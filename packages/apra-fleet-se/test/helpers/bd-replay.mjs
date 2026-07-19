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
    const entry = { command: cmd, exitCode: null, stdout: '', stderr: '' };
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
        if (!byCommand.has(entry.command)) byCommand.set(entry.command, []);
        byCommand.get(entry.command).push(entry);
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

    const queue = session.byCommand.get(cmd);
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
    if (mode === 'real') return execCmd(cmd, cwd);
    // Dolt sync brackets are mock-mode no-ops (see isDoltSyncCommand above):
    // synthesize a clean success WITHOUT recording or requiring a recording.
    if (isDoltSyncCommand(cmd)) return Promise.resolve({ err: null, stdout: '', stderr: '' });
    if (mode === 'record') return recordBd(cmd, cwd);
    return replayBd(cmd, cwd);
}
