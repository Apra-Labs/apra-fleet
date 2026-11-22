// Shared fixtures for VCS builder tests under the file-based request-body
// transport (fleet-sprint/vcs-providers/shell-helpers.mjs jsonBodyFromFile):
// every body-carrying builder takes an absolute member-side `payload_path`,
// emits `--data-binary '@<path>'`, and returns the JSON text as
// `built.payload.content` for the caller to stage. ASCII only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const POSIX_PAYLOAD_PATH = '/work/repo/.apra-call/vcs-body-test.json';
export const WINDOWS_PAYLOAD_PATH = 'C:\\work\\repo\\.apra-call\\vcs-body-test.json';

/** The fixture payload path for a member OS. */
export function testPayloadPath(os) {
    return os === 'windows' ? WINDOWS_PAYLOAD_PATH : POSIX_PAYLOAD_PATH;
}

/** Assert `built` sends its body from a file (no inline -d argument) and
 *  return the parsed JSON body it stages. */
export function stagedJson(built) {
    assert.ok(built && built.payload, 'expected the builder to return a payload to stage');
    assert.ok(typeof built.payload.content === 'string', 'payload.content is the JSON text');
    assert.ok(built.command.includes('--data-binary '), `expected --data-binary in: ${built.command}`);
    assert.ok(!/ -d /.test(built.command), `no inline -d body may remain in: ${built.command}`);
    return JSON.parse(built.payload.content);
}

/** Wrap a builder so a call that names no `payload_path` gets the fixture
 *  path for its `os` -- keeps call sites focused on what each test pins. */
export function withPayloadPath(builder) {
    return (params) => builder({ payload_path: testPayloadPath(params && params.os), ...(params || {}) });
}

/** The exact `--data-binary` argument a POSIX-quoted builder emits for the
 *  fixture path. */
export function posixDataBinaryArg(p = POSIX_PAYLOAD_PATH) {
    return `--data-binary '@${p}'`;
}

/** The absolute work folder a test's fake member_detail reports. */
export const TEST_MEMBER_FOLDER = '/work/repo';

/** A fake member file store for send_files: records each staged file by base
 *  name (read while the caller's local temp file still exists) so a fake
 *  provider can read the request body a `--data-binary '@<path>'` names. */
export function createStagedFileRecorder() {
    const files = new Map();
    const sends = [];
    return {
        files,
        sends,
        /** Answer a send_files tool call. */
        record(toolArgs) {
            const paths = (toolArgs && Array.isArray(toolArgs.local_paths)) ? toolArgs.local_paths : [];
            sends.push({ ...toolArgs });
            for (const p of paths) files.set(path.basename(p), readFileSync(p, 'utf8'));
            return { content: [{ text: `[OK] sent ${paths.length} file(s)` }] };
        },
        /** The staged body text the command's --data-binary names, or null. */
        body(cmd) {
            const m = /--data-binary '@([^']+)'/.exec(String(cmd));
            if (!m) return null;
            const name = m[1].split(/[\\/]/).pop();
            return files.has(name) ? files.get(name) : null;
        },
        /** The staged JSON body the command names (asserts it was staged). */
        json(cmd) {
            const text = this.body(cmd);
            assert.ok(text !== null, `no staged request body for: ${cmd}`);
            return JSON.parse(text);
        },
    };
}
