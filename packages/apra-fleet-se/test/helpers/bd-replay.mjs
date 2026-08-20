import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Record/replay layer for every `bd` CLI call the mock-sprint test suite
// issues (all of them flow through mock-sprint-harness.mjs's runCmd(), which
// delegates here). Three modes, selected by APRA_FLEET_BD_MOCK:
//
//   - replay (DEFAULT; unset or any value other than the ones below):
//     `bd ...` commands never spawn a process. Each scenario's calls are
//     answered from the committed JSONL recording under
//     test/fixtures/bd-recordings/<scenario>.jsonl -- the exact bytes a real
//     `bd` binary produced when the SAME test last ran in record mode.
//     Nothing is fabricated: if the test issues a command that has no
//     remaining recorded response, this module fails loudly with re-record
//     instructions instead of guessing a response.
//   - real (APRA_FLEET_BD_MOCK=0|false|off|no|real): every command runs the
//     real `bd` CLI via child_process.exec, byte-for-byte the pre-shim
//     behavior. This is what `npm run test:integration` uses.
//   - record (APRA_FLEET_BD_MOCK=record): same as real, PLUS every bd
//     call's { command, stdout, stderr, exitCode } is captured into that
//     scenario's JSONL recording. Refreshing fixtures == re-running the real
//     suite in record mode (`npm run test:record`) and committing the
//     result; there is no separate synthetic recording driver, so
//     recordings can never drift from what the tests actually issue.
//
// Replay matching is CONTENT-KEYED, not positional: recorded entries are
// indexed by their exact command string and served FIFO among identical
// commands. Rationale: scenarios with concurrent doer streaks (parallel()
// dispatches in runner.js -- e.g. the 3-bead golden transcript and the
// multidoer scenario) interleave their bd calls in a timing-dependent order,
// so the GLOBAL call order is not reproducible across runs; but each
// sequential command stream's RELATIVE order is deterministic (the same
// await chain issues them), so FIFO-per-command-string replays evolving
// state snapshots (e.g. successive `bd list --ready --json` calls) in the
// correct order while tolerating cross-stream interleaving. Drift in WHAT is
// issued (a changed/renamed/extra bd command) still fails loudly: there is
// no recorded entry for it.
//
// Non-`bd` commands (e.g. runner.js's `node -e "...existsSync..."` probes)
// are ALWAYS executed for real in every mode -- they are cheap and depend on
// real per-run tempDir paths, so recording them would be both useless and
// unstable.
//
// Scenario keying: every tempDir this suite creates follows the pattern
// `<family>-<tag>-<Date.now()>-<pid>` (see setup()/setupMinimal() in
// mock-sprint-harness.mjs and the local setup() helpers in
// golden-transcript*.test.mjs / budget-live.test.mjs). Stripping the
// trailing `-<millis>-<pid>` yields a stable, per-scenario key that is
// identical across runs, so the recording filename is deterministic while
// the tempDir itself stays unique per run. Scenario tags are unique across
// the whole suite, and `node --test`'s file-level concurrency runs each
// test file in its own process, so per-scenario recordings never contend.

export const RECORDINGS_DIR = path.join(__dirname, '..', 'fixtures', 'bd-recordings');

const REAL_VALUES = new Set(['0', 'false', 'off', 'no', 'real']);

export function bdMode() {
    const raw = (process.env.APRA_FLEET_BD_MOCK ?? '').trim().toLowerCase();
    if (raw === 'record') return 'record';
    if (REAL_VALUES.has(raw)) return 'real';
    return 'replay';
}

// The original mock-sprint-harness runCmd body, unchanged: resolve (never
// reject) with { err, stdout, stderr } from a real child process.
export const execCmd = (cmd, cwd) => new Promise((resolve) => {
    exec(cmd, { cwd, env: { ...process.env, BD_ALLOW_REMOTE_MIGRATE: '1' } }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
    });
});

const isBdCommand = (cmd) => /^\s*bd(\s|$)/.test(cmd);

// `bd dolt pull` / `bd dolt push` are the Plan 3.3 D-pull/D-push sync brackets
// (apra-fleet-eft.9.1): the orchestrator issues them around every
// beads-reading dispatch and after every beads-mutating one. In this
// single-clone mock harness there is NO shared dolt remote, so these are pure
// infrastructure no-ops with no meaningful per-scenario output. They are
// intercepted as synthetic successes in the mocked (replay/record) modes -- so
// every existing scenario tolerates the brackets WITHOUT needing (or drifting)
// a recorded response for them, and so they never bloat the committed
// recordings. Real/integration mode still runs them against the real `bd`
// CLI. The dolt bracket behavior itself (retry/reconcile/divergence, exact
// insertion points) is covered directly by the unit tests in
// dolt-sync-brackets.test.mjs / mock-sprint-git-sync-brackets.test.mjs, which
// drive the helpers with an injected command() mock rather than through this
// record/replay layer.
const isDoltSyncCommand = (cmd) => /^\s*bd\s+dolt\s+(pull|push)\b/.test(cmd);

// apra-fleet-eft.54.5: `bd config get sync.remote --json` is the sync-remote
// pre-gate every D-pull/D-push bracket consults (isMemberSyncRemoteConfigured
// in runner.js -- doltPullBefore AND doltPushAfter both call it BEFORE
// deciding whether to issue their real `bd dolt` command). Under real bd it is
// a full `bd` CLI spawn (cold-starting the embedded dolt engine, ~0.6-2s+ per
// spawn, worse on a cold CI host), and it is issued once per sync bracket even
// though a clone's sync.remote is FIXED for the whole scenario (set at `bd
// init`, never mutated by any mock-sprint scenario). On the terminal-abort
// scenarios (mock-sprint-planner-auth-failure-no-retry / -deadpid /
// -stalledsession) the sync brackets around Sprint Setup + the pre-plan reads
// + the single Planner attempt issue this identical probe three times back to
// back, each a redundant real spawn that eats into the test's documented
// fast-abort budget (elapsedMs < 60000) with zero information gain. Cache it
// per clone exactly like the D-pull/D-push brackets below (same eft.17.1
// rationale and safety: keyed by cwd, the value cannot vary for a given clone,
// distinct scenarios use distinct tempDirs, and caching the Promise also
// dedupes concurrent probes from parallel doer streaks).
const isStableConfigProbe = (cmd) => /^\s*bd\s+config\s+get\s+sync\.remote\b/.test(cmd);

// apra-fleet-eft.56.1: commands that pass reviewer-authored free text via a
// local temp file (`bd create --body-file "<path>"`, `bd note <id> --file
// "<path>"` -- see writeCommandBodyTempFile()/appendRejectedFindingToParentNotes()
// in runner.js) embed a fresh randomUUID()-named path on EVERY invocation, so
// the raw command string can never be byte-identical between the recording
// run and a later replay run. Record/replay matching below is
// content-keyed on the exact command string (see the module header comment),
// so without normalization every such command would look like permanent
// "recording drift" on replay, even though nothing about the test's actual
// behavior changed. Normalize the quoted path argument to a stable
// placeholder for MATCHING purposes only -- record/real mode still executes
// the real, unmodified `cmd` (with the real path bd must actually read).
const normalizeCommandForMatching = (cmd) => cmd.replace(/(--body-file|--file)\s+"[^"]*"/g, '$1 "<TMPFILE>"');

// ---------------------------------------------------------------------------
// real-mode D-pull/D-push bracket caching (apra-fleet-eft.17.1)
// ---------------------------------------------------------------------------
// Under real bd (APRA_FLEET_BD_MOCK=off), runner.js wraps EVERY dispatch in the
// Plan 3.3 sync brackets (doltPullBefore -> `bd dolt pull`, doltPushAfter ->
// `bd dolt push`). Each such call spawns the real `bd` CLI, which cold-starts
// the embedded dolt engine (~seconds per spawn). The mock-sprint-*, golden-
// transcript* and budget-live scenarios each drive DOZENS of dispatches against
// a SINGLE local beads clone (their per-scenario tempDir) that has NO configured
// dolt remote, so every one of those pulls/pushes is a deterministic no-remote
// no-op returning the exact same benign-skip result. Re-spawning it per dispatch
// is what pushed 28/74 real-bd files over the 5-min single-file budget and the
// full suite to ~3228s (apra-fleet-eft.17).
//
// Fix: hydrate each fixture's dolt working copy at most ONCE per test-file
// process. The first `bd dolt pull` (and first `bd dolt push`) for a given clone
// -- keyed by cwd -- runs for real; its result Promise is cached and every
// subsequent identical dolt-sync command for that SAME clone is served from the
// cache WITHOUT re-spawning bd. Correctness is unchanged: with no remote the
// operation cannot vary for a given clone, and every bd read hits the local dolt
// store directly regardless of whether a redundant push ran. Distinct scenarios
// use distinct tempDirs (unique cwd), so each fixture still pays exactly one real
// round-trip per verb. Caching the Promise (not just the resolved value) also
// dedupes concurrent bracket calls from parallel doer streaks.
// apra-fleet-eft.54.5: also serves the stable `bd config get sync.remote
// --json` sync-remote pre-gate probe (isStableConfigProbe above) -- same
// per-clone caching contract as the D-pull/D-push brackets.
const realDoltSyncCache = new Map(); // `${cwd} ${normalizedCmd}` -> Promise<{err,stdout,stderr}>

function realDoltSyncCached(cmd, cwd) {
    const key = `${cwd} ${cmd.trim().replace(/\s+/g, ' ')}`;
    let pending = realDoltSyncCache.get(key);
    if (!pending) {
        pending = execCmd(cmd, cwd);
        realDoltSyncCache.set(key, pending);
    }
    return pending;
}

// apra-fleet-eft.60.4: test-only introspection for the per-clone real-mode
// dolt-sync spawn cache above. Answers "how many REAL child-process spawns
// has the cache actually performed for commands matching `pattern`, under
// this cwd" -- distinct from a command LOG (e.g. mock-sprint-harness.mjs's
// `commandLog`), which records every logical request issued to
// executeCommand however many of those requests were subsequently served
// from this cache without spawning anything. Each entry in `realDoltSyncCache`
// represents exactly one real spawn no matter how many times its key was
// requested, so this is the right tool to pin that the eft.17.1/eft.54.5
// caching is actually deduping repeat identical D-pull/D-push/sync-remote-
// probe requests within one scenario -- not once per Planner retry attempt
// (the eft.60 family regression) -- rather than merely happening to return a
// correct result slowly. Only meaningful under real bd (`bdMode() ===
// 'real'`): in the default replay mode dolt-sync commands never populate
// this cache at all (see runCmd below), so callers should gate on that.
export function realSyncSpawnCount(cwd, pattern) {
    let count = 0;
    const prefix = `${cwd} `;
    for (const key of realDoltSyncCache.keys()) {
        if (!key.startsWith(prefix)) continue;
        const cmd = key.slice(prefix.length);
        if (!pattern || pattern.test(cmd)) count += 1;
    }
    return count;
}

// ---------------------------------------------------------------------------
// real-mode repeated-read caching (apra-fleet-u87n.1)
// ---------------------------------------------------------------------------
// Measured root cause of the real-bd timeouts on the heavier mock-sprint
// files: essentially 100% of their wall clock is real `bd` process spawns.
// mock-sprint-member-vcs-provider-threading.test.mjs issues 27 of them (one
// `bd init` at ~10.7s, 26 more at ~1.1-2.6s each) for a total of ~47s of
// child-process time out of a ~47s file duration -- the same file finishes in
// ~0.3s in replay mode, i.e. the scenario's own JS costs nothing. Under
// --test-concurrency=8 those spawns contend for one disk with 7 sibling
// files' dolt engines and the file blows past its per-file timeout. Cutting
// SPAWNS is therefore the only lever that moves the number; a timeout bump
// would just relabel the contention.
//
// Seven of that file's spawns are re-reads of a command whose answer cannot
// have changed: within one scenario the ONLY writer of the tempDir's beads
// store is this same process, and every one of its `bd` calls flows through
// runCmd() here. So a read (`bd list`/`bd show`/`bd stats`) may be served
// from cache as long as no bd command that could mutate the store has been
// issued for that SAME cwd since -- exactly the invariant that makes the
// eft.17.1 D-pull/D-push and eft.54.5 sync.remote caches above safe, applied
// to reads whose validity window ends at the next write instead of lasting
// the whole scenario.
//
// Any non-read bd command (create/update/close/note/dep/import/...) drops the
// whole cwd's read cache, both when it is dispatched and again when it
// completes, so a read issued after a write never sees pre-write state. The
// classification is a strict allowlist: anything not recognized as read-only
// is treated as a writer, so an unfamiliar future subcommand fails safe.
// Caching the Promise (not the value) also dedupes identical concurrent reads
// from parallel doer streaks. Replay/record modes are untouched -- they never
// consult this cache.
const READ_ONLY_BD = /^\s*bd\s+(list|show|stats)\b/;

const realReadCache = new Map(); // `${cwd} ${normalizedCmd}` -> Promise<{err,stdout,stderr}>
let realReadServed = 0;

function invalidateRealReadCache(cwd) {
    const prefix = `${cwd} `;
    for (const key of realReadCache.keys()) {
        if (key.startsWith(prefix)) realReadCache.delete(key);
    }
}

function realReadCached(cmd, cwd) {
    const key = `${cwd} ${cmd.trim().replace(/\s+/g, ' ')}`;
    const pending = realReadCache.get(key);
    if (pending) {
        realReadServed += 1;
        return pending;
    }
    const fresh = execCmd(cmd, cwd);
    realReadCache.set(key, fresh);
    return fresh;
}

function realWriteThrough(cmd, cwd) {
    invalidateRealReadCache(cwd);
    return execCmd(cmd, cwd).then((res) => {
        invalidateRealReadCache(cwd);
        return res;
    });
}

// Test-only introspection (same purpose as realSyncSpawnCount above): how
// many read calls this cache answered WITHOUT spawning bd. Only meaningful
// under real bd (`bdMode() === 'real'`).
export function realReadServeCount() {
    return realReadServed;
}

// ---------------------------------------------------------------------------
// real-mode `bd init` templating (apra-fleet-3ei)
// ---------------------------------------------------------------------------
// Every heavy mock-sprint/golden-transcript/budget-live scenario's setup()/
// setupMinimal() issues a bare `bd init` into a brand-new scratch tempDir
// before it ever creates a bead. Under real bd (APRA_FLEET_BD_MOCK=off, i.e.
// `npm run test:integration` / the real-bd suite apra-fleet-eft.17 is about)
// this is a full process spawn that bootstraps an embedded Dolt database
// from scratch -- real, repeated cost across 25+ setup() calls.
//
// Unlike a pre-seeded backlog (investigated and rejected for this same bead:
// fleet-e2e-toy's issues are a flat, unrelated toy backlog that doesn't
// exercise what these scenarios need), a BARE `bd init` with no issues yet
// created has no scenario-specific content at all -- every scenario runs the
// exact same command against an empty scratch dir, so its result is safe to
// produce once per test-file process and replicate onto every subsequent
// caller's own tempDir instead of re-running the real bootstrap.
//
// Verified (see task investigation): a copy of an already-`bd init`-ed
// directory tree, relocated to a differently-named destination directory,
// still behaves correctly under `bd list`/`bd create`/`bd update --parent`
// -- the embedded Dolt store's issue-id prefix is fixed at template-creation
// time and does not need to match the destination directory's name. No
// scenario asserts on the literal issue-id prefix string, only on the ids
// `bd create --silent` hands back at runtime, so this is behavior-neutral.
// apra-fleet-u87n.1 widens that amortization from ONE PROCESS to one
// TEST-RUNNER HOST. `node --test` runs every file in its own process, so the
// per-process template still paid a full ~10.7s dolt bootstrap per file -- 70+
// of them in the real-bd suite, eight of them firing SIMULTANEOUSLY at
// concurrency=8 as the lane starts, which is precisely when the disk is most
// contended. The template's content is identical for every process (a bare
// `bd init` into an empty dir), so it is published to a fixed path in the OS
// temp dir and reused by every later test-file process on the same host.
//
// Publication is atomic: the bootstrap runs into a `-staging-<random>`
// sibling and is then rename()d onto the final path, so a concurrent reader
// can only ever observe a COMPLETE template (a partially-bootstrapped dolt
// store is never visible under the final name). If two processes race, the
// loser's rename fails, it discards its staging copy and uses the winner's --
// bounded worst case, never a corrupt template.
//
// The path is keyed by the `bd` binary's own size+mtime fingerprint, so
// upgrading bd never reuses a template bootstrapped by the previous version;
// it simply starts a new one. APRA_FLEET_BD_TEMPLATE_KEY overrides the key
// outright, which is how bd-init-templating.test.mjs keeps asserting an
// EXACTLY-one-spawn bootstrap for its own private namespace regardless of
// what other files on this host have already published.
const BD_INIT_TEMPLATE_VERSION = 'v2';

// Fingerprint the `bd` binary WITHOUT spawning it (the whole point here is to
// avoid spawns): resolve it off PATH the same way the OS would and stat it.
// Unresolvable (or unstattable) degrades to a fixed 'unknown' key -- the
// template is still correct, it just is not invalidated by a bd upgrade, and
// the version constant above remains the manual escape hatch.
function bdBinaryFingerprint() {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = path.join(dir, `bd${ext}`);
            try {
                const st = fs.statSync(candidate);
                if (st.isFile()) return `${st.size}-${Math.trunc(st.mtimeMs)}`;
            } catch {
                // not here; keep looking
            }
        }
    }
    return 'unknown';
}

// The directory NAME matters to bd: `bd init` derives its database name from
// it and rejects anything that does not survive that mapping -- notably a
// long name ("produces an invalid database name ...", observed with a
// 70+ char staging directory). So the key -- whatever its length -- is folded
// into a short fixed-width hash, leaving room for mkdtemp's own suffix on the
// staging sibling.
let bdBinaryKey = null;
function bdInitTemplateDir() {
    // The env override is read on EVERY call (never memoized): a test that
    // sets it mid-process must get its own namespace immediately. Only the
    // binary fingerprint -- a stat sweep of PATH -- is memoized.
    let raw = process.env.APRA_FLEET_BD_TEMPLATE_KEY;
    if (!raw) {
        if (!bdBinaryKey) bdBinaryKey = bdBinaryFingerprint();
        raw = bdBinaryKey;
    }
    const key = createHash('sha1').update(String(raw)).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), `bdtpl-${BD_INIT_TEMPLATE_VERSION}-${key}`);
}

const bdInitTemplatePromises = new Map(); // templateDir -> Promise<{ err, stdout, stderr, templateDir }>
let bdInitTemplateSpawns = 0;

// A template directory counts as usable only once it holds the `.beads` dir
// `bd init` creates -- the marker bd-init-templating.test.mjs itself asserts
// on. Anything less is a leftover/partial directory, not a template.
const templateIsReady = (dir) => {
    try {
        return fs.statSync(path.join(dir, '.beads')).isDirectory();
    } catch {
        return false;
    }
};

async function createBdInitTemplate(templateDir) {
    if (templateIsReady(templateDir)) {
        // Published by an earlier test-file process on this host: reuse it
        // with no spawn at all.
        return { err: null, stdout: '', stderr: '', templateDir };
    }

    await fs.promises.mkdir(os.tmpdir(), { recursive: true });
    const staging = await fs.promises.mkdtemp(`${templateDir}-staging-`);
    bdInitTemplateSpawns += 1;
    const res = await execCmd('bd init', staging);
    if (res.err) {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
        return { ...res, templateDir };
    }

    // Publish. Two things can make the rename fail, and they need opposite
    // handling:
    //   - the destination already exists  -> another process won the race;
    //     drop ours and use theirs.
    //   - EBUSY/EPERM on the SOURCE       -> Windows only: the just-exited
    //     `bd init` child (or a scanner) still holds a handle inside the
    //     staging tree for a moment. Retry briefly; this is the same
    //     transient the harness's own teardown rm already retries on.
    // If publication never succeeds we still have a perfectly good bootstrapped
    // directory in `staging`, so fall back to using it as THIS process's
    // template rather than failing every scenario setup in the file.
    let published = false;
    for (let attempt = 0; attempt < 10 && !published; attempt += 1) {
        if (templateIsReady(templateDir)) break;
        try {
            await fs.promises.rename(staging, templateDir);
            published = true;
        } catch {
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    if (published || templateIsReady(templateDir)) {
        if (!published) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
        return { err: null, stdout: res.stdout, stderr: res.stderr, templateDir };
    }
    return { err: null, stdout: res.stdout, stderr: res.stderr, templateDir: staging };
}

// Serves a real `bd init` call in real mode by copying the shared template
// directory onto the caller's already-created (empty) `cwd`, instead of
// spawning `bd init` again. If the template bootstrap itself failed, that
// same failure is surfaced to every caller -- a fresh real spawn per scenario
// would just fail identically 25+ times, and fabricating a misleading success
// would be worse.
async function realBdInitTemplated(cwd) {
    const dir = bdInitTemplateDir();
    let pending = bdInitTemplatePromises.get(dir);
    if (!pending) {
        pending = createBdInitTemplate(dir);
        bdInitTemplatePromises.set(dir, pending);
    }
    const { err, stdout, stderr, templateDir } = await pending;
    if (err) return { err, stdout, stderr };
    await fs.promises.cp(templateDir, cwd, { recursive: true });
    return { err: null, stdout, stderr };
}

// Test-only introspection (same purpose as realSyncSpawnCount above): how
// many REAL `bd init` process spawns has this process actually performed,
// however many logical `bd init` calls were served from the template copy
// without spawning anything. Never exceeds 1 per template key, and is 0 when
// an earlier process on this host already published that key's template.
export function bdInitTemplateSpawnCount() {
    return bdInitTemplateSpawns;
}

// Test-only: the shared template path currently in effect (honours
// APRA_FLEET_BD_TEMPLATE_KEY), so a test that forces its own private template
// key can clean the directory up afterwards instead of leaking it.
export function bdInitTemplatePath() {
    return bdInitTemplateDir();
}

const isBdInitCommand = (cmd) => /^\s*bd\s+init\s*$/.test(cmd);

export function scenarioKeyFromCwd(cwd) {
    return path.basename(cwd).replace(/-\d+-\d+$/, '');
}

export const fixtureFileForKey = (key) => path.join(RECORDINGS_DIR, `${key}.jsonl`);

// JSON.stringify, but with every non-ASCII code unit escaped as \uXXXX so
// recordings stay ASCII-only files even though real bd emits unicode glyphs
// (check marks, em dashes) on its human-readable stdout.
export function toAsciiJsonLine(obj) {
    return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Recordings are committed to a public repository: strip the recording
// machine's absolute temp-dir prefix (which embeds the local OS username on
// Windows, e.g. C:\Users\<name>\AppData\Local\Temp) from captured output.
// Only `bd init`'s human-readable stdout ever contains these paths and
// nothing parses it, so the substitution is behavior-neutral for replay.
// Both native and forward-slash spellings are scrubbed.
export function scrubMachinePaths(text) {
    if (!text) return text;
    const tmp = os.tmpdir();
    const variants = [tmp, tmp.replace(/\\/g, '/')];
    let out = text;
    for (const v of variants) {
        out = out.split(v).join('<TMPDIR>');
    }
    return out;
}

const RE_RECORD_HELP =
    'To refresh recordings, re-run the real-bd suite in record mode and commit the result:\n' +
    '  npm run test:record --workspace=@apralabs/apra-fleet-se\n' +
    'Or bypass recordings entirely (real bd CLI) with:\n' +
    '  npm run test:integration --workspace=@apralabs/apra-fleet-se';

// ---------------------------------------------------------------------------
// record mode
// ---------------------------------------------------------------------------

// key -> { entries: [{ command, exitCode, stdout, stderr, errMessage? }] }
const recordSessions = new Map();

async function recordBd(cmd, cwd) {
    const key = scenarioKeyFromCwd(cwd);
    let session = recordSessions.get(key);
    if (!session) {
        session = { entries: [] };
        recordSessions.set(key, session);
        fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    }
    // Reserve this call's slot synchronously at invocation time, so entries
    // for identical command strings land in invocation order (the order
    // FIFO replay will serve them back in) even when two calls' exec()s
    // overlap and complete out of order.
    //
    // apra-fleet-eft.56.1: the recorded `command` field is the NORMALIZED
    // form (temp-file paths replaced with a stable placeholder) so a later
    // replay run -- which will generate its own, different random temp path
    // for the same logical call -- still matches this entry. The real,
    // unmodified `cmd` (real path and all) is still what actually executes
    // against bd below.
    const entry = { command: normalizeCommandForMatching(cmd), exitCode: null, stdout: '', stderr: '' };
    session.entries.push(entry);

    const res = await execCmd(cmd, cwd);
    entry.exitCode = res.err ? (typeof res.err.code === 'number' ? res.err.code : 1) : 0;
    entry.stdout = scrubMachinePaths(res.stdout ?? '');
    entry.stderr = scrubMachinePaths(res.stderr ?? '');
    if (res.err) entry.errMessage = scrubMachinePaths(res.err.message);

    // Flush the whole session after every completion (test-sized data, so
    // rewriting is cheap) -- the file is always complete once the process
    // exits, and a crash mid-run leaves visibly incomplete entries
    // (exitCode: null) that the recordings fidelity test rejects.
    fs.writeFileSync(fixtureFileForKey(key), session.entries.map(toAsciiJsonLine).join('\n') + '\n');
    return res;
}

// ---------------------------------------------------------------------------
// replay mode
// ---------------------------------------------------------------------------

// key -> { byCommand: Map<command, entry[]> (FIFO queues), total }
const replaySessions = new Map();

export function loadRecording(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line));
}

function loadReplaySession(key) {
    const file = fixtureFileForKey(key);
    if (!fs.existsSync(file)) {
        throw new Error(
            `[bd-replay] No bd recording found for scenario '${key}' (expected ${file}).\n` +
                `A test issued a bd command in replay mode (APRA_FLEET_BD_MOCK unset/truthy) but no recording was ever captured for this scenario.\n${RE_RECORD_HELP}`,
        );
    }
    const entries = loadRecording(file);
    const byCommand = new Map();
    for (const entry of entries) {
        // apra-fleet-eft.56.1: normalize on load too, so an OLDER recording
        // captured before this normalization existed (its `command` field
        // still has a raw, one-off temp path baked in) still matches a fresh
        // replay run's differently-randomized path for the same logical
        // call. Normalization is a no-op for every command without a
        // --body-file/--file argument.
        const matchKey = normalizeCommandForMatching(entry.command);
        if (!byCommand.has(matchKey)) byCommand.set(matchKey, []);
        byCommand.get(matchKey).push(entry);
    }
    return { byCommand, total: entries.length, file };
}

function replayBd(cmd, cwd) {
    const key = scenarioKeyFromCwd(cwd);
    let session = replaySessions.get(key);
    if (!session) {
        session = loadReplaySession(key);
        replaySessions.set(key, session);
    }

    const matchKey = normalizeCommandForMatching(cmd);
    const queue = session.byCommand.get(matchKey);
    if (!queue || queue.length === 0) {
        const remaining = [...session.byCommand.entries()]
            .filter(([, q]) => q.length > 0)
            .map(([c, q]) => `  ${q.length}x ${JSON.stringify(c)}`)
            .join('\n');
        throw new Error(
            `[bd-replay] Recording drift for scenario '${key}': the test issued a bd command with no ${queue ? 'remaining' : ''} recorded response:\n` +
                `  issued: ${JSON.stringify(cmd)}\n` +
                `Unconsumed recorded command(s) in ${session.file}:\n${remaining || '  (none -- recording fully consumed)'}\n` +
                `The test/runner's bd calls no longer match the committed recording.\n${RE_RECORD_HELP}`,
        );
    }
    const entry = queue.shift();
    if (typeof entry.exitCode !== 'number') {
        throw new Error(
            `[bd-replay] Recording for scenario '${key}' has an incomplete entry for ${JSON.stringify(cmd)} (exitCode: ${JSON.stringify(entry.exitCode)}) -- the recording run likely crashed mid-scenario.\n${RE_RECORD_HELP}`,
        );
    }

    let err = null;
    if (entry.exitCode !== 0) {
        err = new Error(entry.errMessage || `Command failed: ${cmd}\n${entry.stderr}`);
        err.code = entry.exitCode;
    }
    return Promise.resolve({ err, stdout: entry.stdout, stderr: entry.stderr });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function runCmd(cmd, cwd) {
    if (!isBdCommand(cmd)) return execCmd(cmd, cwd);
    const mode = bdMode();
    if (mode === 'real') {
        // Hydrate each fixture's dolt clone once, then serve repeat D-pull/
        // D-push brackets -- and the stable sync.remote pre-gate probe every
        // bracket consults -- from cache (see realDoltSyncCached above).
        if (isDoltSyncCommand(cmd) || isStableConfigProbe(cmd)) return realDoltSyncCached(cmd, cwd);
        // Serve a bare `bd init` from the shared template instead of
        // re-running bd's own bootstrap (see realBdInitTemplated above).
        if (isBdInitCommand(cmd)) return realBdInitTemplated(cwd);
        // apra-fleet-u87n.1: repeated identical reads with no intervening
        // write to this clone cannot have changed -- serve them from cache.
        // Everything else is treated as a writer and drops the clone's read
        // cache (see realReadCached/realWriteThrough above).
        if (READ_ONLY_BD.test(cmd)) return realReadCached(cmd, cwd);
        return realWriteThrough(cmd, cwd);
    }
    // Dolt sync brackets are mock-mode no-ops (see isDoltSyncCommand above):
    // synthesize a clean success WITHOUT recording or requiring a recording.
    if (isDoltSyncCommand(cmd)) return Promise.resolve({ err: null, stdout: '', stderr: '' });
    if (mode === 'record') return recordBd(cmd, cwd);
    return replayBd(cmd, cwd);
}
