import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

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
        return execCmd(cmd, cwd);
    }
    // Dolt sync brackets are mock-mode no-ops (see isDoltSyncCommand above):
    // synthesize a clean success WITHOUT recording or requiring a recording.
    if (isDoltSyncCommand(cmd)) return Promise.resolve({ err: null, stdout: '', stderr: '' });
    if (mode === 'record') return recordBd(cmd, cwd);
    return replayBd(cmd, cwd);
}
