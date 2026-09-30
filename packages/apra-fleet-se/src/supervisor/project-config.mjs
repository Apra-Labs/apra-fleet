// =============================================================================
// Supervisor project config -- the single owner of `supervisor.config.json`
// =============================================================================
//
// One small JSON file holding the supervisor's PERSISTED project folder: the
// folder whose `.beads` tracker this supervisor runs against, remembered
// across restarts so it is no longer an accident of the service's working
// directory. This module owns three things and nothing else:
//
//   1. WHERE the file lives. The path derives from the service data-dir knob
//      (`FLEET_SE_DATA_DIR`, else `~/.apra-fleet-se`) via `defaultDataDir()`
//      in ./ledger.mjs -- the SAME knob every other piece of supervisor state
//      already honours. There is deliberately no second home-directory
//      literal in this file: an isolated supervisor (a test, a sandbox
//      deploy, two supervisors on one host) is obtained purely by pointing
//      that knob somewhere else, and any code that hardcoded a home path
//      would silently escape that isolation. See ../projects/store/db.mjs's
//      header, which spells out the same rule for `supervisor.sqlite`.
//
//   2. WHAT SHAPE it has, and that reading it is TOTAL. `readSupervisorConfig()`
//      never throws: a missing file, an unreadable file, malformed JSON, or a
//      valid file carrying a wrong-typed `projectDir` each come back as a
//      not-configured result plus a human `reason`. A supervisor must be able
//      to boot and serve the very console page an operator would use to fix a
//      bad setting -- so a bad setting can never be a hard read failure.
//
//   3. HOW it is written. Atomically (temp file + rename, via
//      ./rename-with-retry.mjs), so an interrupted write can never leave a
//      truncated file that the next read has to reject. Unknown top-level
//      keys are PRESERVED across a write: a newer supervisor may add a field
//      this build has never heard of, and an older writer must not destroy it.
//
// WHY A JSON FILE AND NOT A ROW IN `supervisor.sqlite` -- the decision, and
// the reason, so the next reader does not "simplify" this by merging the two:
//
//   A multi-project CRUD domain already exists at `/api/projects`
//   (../projects/routes/projects.mjs, 11 routes) backed by `supervisor.sqlite`.
//   This module deliberately does NOT depend on it. That store is opened
//   through `node:sqlite`, which only exists on Node 22.13.0+, and
//   ../../bin/serve.mjs degrades to `registerProjectsStoreUnavailableRoutes`
//   when the store cannot be opened at all (see `openProjectStoreOrDegrade`
//   there, and `NodeSqliteUnavailableError` in ../projects/store/db.mjs). A
//   setting stored in that store would therefore silently DISAPPEAR on
//   exactly the runtimes the released binary must keep working on -- and the
//   project folder is the one setting the supervisor needs BEFORE it knows
//   whether any store could be opened, because it is resolved up front in
//   serve.mjs before any seam is built or the port is bound.
//
//   So: this file is the bootstrap setting (plain `fs`, no native
//   dependency, readable on every supported runtime); `supervisor.sqlite`
//   remains the place for the richer multi-project domain. They are not the
//   same concern and must not be merged.
//
// This module is the ONLY code in the repo that opens `supervisor.config.json`
// by name. Every other caller (the console route, the installer, serve's
// startup resolution) goes through these exports, so the file format cannot
// fork into two divergent hand-rolled copies.
// =============================================================================

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDir } from './ledger.mjs';
import { renameWithRetry } from './rename-with-retry.mjs';

/** The on-disk file name, relative to the supervisor data dir. */
export const SUPERVISOR_CONFIG_FILENAME = 'supervisor.config.json';

/**
 * Absolute path of `supervisor.config.json` for this supervisor instance.
 *
 * `dataDir` is injectable ONLY so a test (or a second instance) can point it
 * elsewhere; the default runs through `defaultDataDir()` so `FLEET_SE_DATA_DIR`
 * is honoured and there is no second home-directory literal here.
 * @param {{ dataDir?: string }} [opts]
 * @returns {string}
 */
export function supervisorConfigPath(opts = {}) {
    const dataDir = opts.dataDir ?? defaultDataDir();
    return path.join(path.resolve(dataDir), SUPERVISOR_CONFIG_FILENAME);
}

/**
 * The not-configured result shape, built in one place so every reason string
 * arrives with the same surrounding fields.
 * @param {string} filePath
 * @param {string} reason
 * @param {object} [raw]
 * @returns {{ configured: false, projectDir: null, reason: string, path: string, raw: object }}
 */
function notConfigured(filePath, reason, raw = {}) {
    return { configured: false, projectDir: null, reason, path: filePath, raw };
}

/**
 * The not-recorded toolchain result, built in one place so every reason
 * string arrives with the same surrounding shape as `notConfigured()` above.
 * @param {string} reason
 * @returns {{ toolchain: null, toolchainReason: string }}
 */
function toolchainNotRecorded(reason) {
    return { toolchain: null, toolchainReason: reason };
}

/**
 * Extract and validate the `toolchain` block from an already-parsed config
 * object (apra-fleet-i9ag.19.3). This is INDEPENDENT of `projectDir`
 * validation: a bad or absent `projectDir` must never affect this, and a bad
 * or absent `toolchain` must never affect `projectDir` -- see the caller,
 * which computes both from the same `parsed` object and never short-circuits
 * one because of the other.
 *
 * TOTAL, same as the reader as a whole: every malformed shape below returns
 * `{ toolchain: null, toolchainReason: <its own distinguishable reason> }`
 * rather than throwing --
 *
 *   - the block is missing or `null` (the normal not-yet-recorded case),
 *   - the block is present but not an object (a string, number, array, ...),
 *   - `nodePath` is missing, not a string, blank, or not an absolute path.
 *
 * Only `nodePath` is validated this strictly: it is the one field a caller
 * (apra-fleet-i9ag.19.5/.19.7) would otherwise try to `spawn()` or `execFile()`
 * directly. `nodeVersion`, `bdPath`, `bdVersion`, and `recordedAt` are passed
 * through as written -- `bdPath`/`bdVersion` are expected to be `null` when
 * `bd` could not be resolved at install time (see `seedSupervisorToolchain()`
 * in `src/cli/supervisor.ts`), and rejecting the whole block for that would
 * throw away a perfectly usable `nodePath`.
 * @param {string} filePath
 * @param {object} parsed
 * @returns {{ toolchain: { nodePath: string, nodeVersion: string|null, bdPath: string|null, bdVersion: string|null, recordedAt: string|null } | null, toolchainReason: string | null }}
 */
function readToolchainBlock(filePath, parsed) {
    const block = parsed.toolchain;
    if (block === undefined || block === null) {
        return toolchainNotRecorded(`${filePath} has no 'toolchain' setting`);
    }
    if (typeof block !== 'object' || Array.isArray(block)) {
        return toolchainNotRecorded(`${filePath} has a 'toolchain' that is not an object (got ${Array.isArray(block) ? 'an array' : typeof block})`);
    }

    const nodePath = block.nodePath;
    if (nodePath === undefined || nodePath === null) {
        return toolchainNotRecorded(`${filePath} toolchain has no 'nodePath' setting`);
    }
    if (typeof nodePath !== 'string') {
        return toolchainNotRecorded(`${filePath} toolchain has a 'nodePath' that is not a string (got ${Array.isArray(nodePath) ? 'an array' : typeof nodePath})`);
    }
    if (!nodePath.trim()) {
        return toolchainNotRecorded(`${filePath} toolchain has a 'nodePath' that is blank`);
    }
    if (!path.isAbsolute(nodePath)) {
        return toolchainNotRecorded(`${filePath} toolchain has a 'nodePath' that is not an absolute path: ${nodePath}`);
    }

    return {
        toolchain: {
            nodePath,
            nodeVersion: block.nodeVersion ?? null,
            bdPath: block.bdPath ?? null,
            bdVersion: block.bdVersion ?? null,
            recordedAt: block.recordedAt ?? null,
        },
        toolchainReason: null,
    };
}

/**
 * Read `supervisor.config.json`.
 *
 * TOTAL by contract -- this never throws and never rejects. Every failure
 * mode degrades to `{ configured: false, projectDir: null, reason: <why> }`:
 *
 *   - the file does not exist (the normal un-configured first boot),
 *   - the file cannot be read (permissions, it is a directory, I/O error),
 *   - its contents are not parseable JSON, or parse to a non-object
 *     (`null`, an array, a bare number/string),
 *   - it parses to an object whose `projectDir` is missing, not a string, or
 *     blank.
 *
 * On success `projectDir` is an ABSOLUTE, resolved path (a relative value in
 * the file resolves against `cwd`, default `process.cwd()`), and `raw` carries
 * the whole parsed object so `writeSupervisorConfig()` can preserve unknown
 * keys.
 *
 * The result also always carries `toolchain` / `toolchainReason`
 * (apra-fleet-i9ag.19.3), the install-time-recorded
 * `{ nodePath, nodeVersion, bdPath, bdVersion, recordedAt }` written by
 * `seedSupervisorToolchain()` in `src/cli/supervisor.ts`, or `null` plus a
 * reason when it is missing or malformed. Reading these two settings is
 * INDEPENDENT in both directions: a bad `toolchain` never flips `configured`
 * to `false`, and a bad or absent `projectDir` never forces `toolchain` to
 * `null` -- each setting reports its own problem, because the supervisor must
 * be able to boot and serve the console page an operator would use to fix
 * either one on its own.
 *
 * `fs` is injectable (the `node:fs/promises` shape; only `readFile` is used)
 * so a test can drive an unreadable-file case without needing real chmod
 * semantics -- which do not behave the same way on Windows or as root.
 * @param {{ dataDir?: string, filePath?: string, cwd?: string, fs?: { readFile: Function } }} [opts]
 * @returns {Promise<{ configured: boolean, projectDir: string|null, reason: string|null, path: string, raw: object, toolchain: object|null, toolchainReason: string|null }>}
 */
export async function readSupervisorConfig(opts = {}) {
    const filePath = opts.filePath ?? supervisorConfigPath(opts);
    const fs = opts.fs ?? fsp;
    const cwd = opts.cwd ?? process.cwd();

    let text;
    try {
        text = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
        const code = err && err.code;
        const reason = code === 'ENOENT'
            ? `no ${SUPERVISOR_CONFIG_FILENAME} at ${filePath}`
            : `could not read ${filePath}: ${err && err.message ? err.message : String(err)}`;
        return { ...notConfigured(filePath, reason), ...toolchainNotRecorded(reason) };
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        const reason = `${filePath} is not valid JSON: ${detail}`;
        return { ...notConfigured(filePath, reason), ...toolchainNotRecorded(reason) };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const reason = `${filePath} must contain a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`;
        return { ...notConfigured(filePath, reason), ...toolchainNotRecorded(reason) };
    }

    // `toolchain` and `projectDir` are two independent settings living in the
    // same object: compute both from `parsed` now, neither one gating the
    // other, then merge whichever `projectDir` result applies below.
    const toolchainResult = readToolchainBlock(filePath, parsed);

    const value = parsed.projectDir;
    if (value === undefined || value === null) {
        return { ...notConfigured(filePath, `${filePath} has no 'projectDir' setting`, parsed), ...toolchainResult };
    }
    if (typeof value !== 'string' || !value.trim()) {
        const shown = typeof value === 'string' ? 'an empty string' : `a ${Array.isArray(value) ? 'array' : typeof value}`;
        return { ...notConfigured(filePath, `${filePath} has a 'projectDir' that is not a non-empty string (got ${shown})`, parsed), ...toolchainResult };
    }

    return {
        configured: true,
        projectDir: path.resolve(cwd, value.trim()),
        reason: null,
        path: filePath,
        raw: parsed,
        ...toolchainResult,
    };
}

/**
 * Write `supervisor.config.json` atomically, preserving unknown keys.
 *
 * The write is temp-file-then-rename (through `renameWithRetry`, which absorbs
 * the transient Windows EPERM/EBUSY lock on the rename step -- see
 * ./rename-with-retry.mjs), so a reader concurrent with this call, or a
 * process killed midway through it, sees either the old file or the new one
 * and never a truncated one.
 *
 * Unknown top-level keys already in the file are carried over: this reads the
 * current contents first (via the total reader above, so an unparseable
 * current file is simply replaced rather than blocking the write) and merges
 * `projectDir` over them. A future field written by a newer supervisor
 * survives a write by this build.
 * @param {{ projectDir: string, dataDir?: string, filePath?: string, cwd?: string, fs?: object }} opts
 * @returns {Promise<{ path: string, projectDir: string, config: object }>}
 */
export async function writeSupervisorConfig(opts = {}) {
    const filePath = opts.filePath ?? supervisorConfigPath(opts);
    const fs = opts.fs ?? fsp;
    const cwd = opts.cwd ?? process.cwd();
    const { projectDir } = opts;

    if (typeof projectDir !== 'string' || !projectDir.trim()) {
        throw new TypeError('writeSupervisorConfig requires a non-empty projectDir string');
    }
    const resolved = path.resolve(cwd, projectDir.trim());

    // Unknown-key preservation: whatever is on disk now, minus our own field.
    // A malformed current file yields `raw: {}` from the total reader, so a
    // corrupt file is replaced by a good one instead of failing the write.
    const current = await readSupervisorConfig({ filePath, fs, cwd });
    const config = { ...current.raw, projectDir: resolved };

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    await renameWithRetry(fs, tmpPath, filePath, opts.renameRetry ?? {});

    return { path: filePath, projectDir: resolved, config };
}

/**
 * Write the `toolchain` block atomically, preserving unknown keys AND the
 * existing `projectDir` (apra-fleet-i9ag.19.3) -- the same two write
 * guarantees `writeSupervisorConfig()` above documents, because both writers
 * touch the SAME file and honouring only one of them would silently undo the
 * other's work: an operator changing the project folder through the console's
 * `POST /api/project` (which goes through `writeSupervisorConfig()`) must not
 * un-record the toolchain, and this writer must not un-set their project
 * folder either.
 *
 * `toolchain.nodePath` is required (a non-empty, absolute string) since it is
 * the one field a later reader would try to `spawn()`/`execFile()` directly;
 * `nodeVersion`, `bdPath`, `bdVersion`, and `recordedAt` are passed through
 * as given, defaulting to `null` (or, for `recordedAt`, the current time) when
 * omitted -- this mirrors `seedSupervisorToolchain()` in `src/cli/supervisor.ts`,
 * the installer's own writer, so a value written by either one reads back
 * through `readSupervisorConfig()` unchanged.
 * @param {{ nodePath: string, nodeVersion?: string|null, bdPath?: string|null, bdVersion?: string|null, recordedAt?: string }} toolchain
 * @param {{ dataDir?: string, filePath?: string, cwd?: string, fs?: object }} [opts]
 * @returns {Promise<{ path: string, toolchain: object, config: object }>}
 */
export async function writeSupervisorToolchain(toolchain, opts = {}) {
    const filePath = opts.filePath ?? supervisorConfigPath(opts);
    const fs = opts.fs ?? fsp;
    const cwd = opts.cwd ?? process.cwd();

    if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) {
        throw new TypeError('writeSupervisorToolchain requires a toolchain object');
    }
    const { nodePath } = toolchain;
    if (typeof nodePath !== 'string' || !nodePath.trim() || !path.isAbsolute(nodePath)) {
        throw new TypeError('writeSupervisorToolchain requires an absolute, non-empty toolchain.nodePath string');
    }

    // Unknown-key preservation (including a `projectDir` written by the
    // OTHER writer): whatever is on disk now, minus our own `toolchain` key.
    // A malformed current file yields `raw: {}` from the total reader, so a
    // corrupt file is replaced by a good one instead of failing the write.
    const current = await readSupervisorConfig({ filePath, fs, cwd });
    const toolchainRecord = {
        nodePath,
        nodeVersion: toolchain.nodeVersion ?? null,
        bdPath: toolchain.bdPath ?? null,
        bdVersion: toolchain.bdVersion ?? null,
        recordedAt: toolchain.recordedAt ?? new Date().toISOString(),
    };
    const config = { ...current.raw, toolchain: toolchainRecord };

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    await renameWithRetry(fs, tmpPath, filePath, opts.renameRetry ?? {});

    return { path: filePath, toolchain: toolchainRecord, config };
}
