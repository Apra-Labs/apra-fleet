import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORDINGS_DIR, loadRecording, toAsciiJsonLine, bdMode } from './helpers/bd-replay.mjs';

// Fidelity/integrity guard for the bd recordings that back the suite's
// default replay mode (see test/helpers/bd-replay.mjs). Same pattern as
// contracts-schema-vendor-consistency.test.mjs: fixture files that stand in
// for an external tool's real behavior must be mechanically checked, not
// trusted.
//
// The recordings are, by construction, exact bytes captured from a real
// `bd` CLI run of this same suite (`npm run test:record`) -- replay never
// fabricates a response. What can still go wrong, and what this file
// catches:
//
//   - a hand-edited / merge-mangled / truncated recording (no longer the
//     bytes real bd produced, or structurally broken JSONL);
//   - a recording captured by a run that crashed mid-scenario (incomplete
//     entries with exitCode: null);
//   - non-ASCII bytes creeping into the files (the recorder escapes every
//     non-ASCII code unit as \uXXXX; the repo is ASCII-only);
//   - internally incoherent recordings, e.g. a bead id referenced by a
//     recorded command that never appeared in any recorded bd response --
//     impossible for a genuine capture, since tests only learn ids from bd
//     stdout.
//
// Drift against a FUTURE real bd (changed id format, changed JSON shape) is
// caught by running the same tests unmocked -- `npm run test:integration` --
// and fixed by re-recording (`npm run test:record`), never by editing these
// files by hand.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// During a record-mode run (`npm run test:record`) the recorder is
// REWRITING these files concurrently with this test file's own process --
// reading them here would race the writer and false-fail on legitimately
// in-progress entries. The refreshed recordings are validated by the very
// next replay-mode run instead.
const RECORDING_IN_PROGRESS = bdMode() === 'record';

const recordingFiles = !RECORDING_IN_PROGRESS && fs.existsSync(RECORDINGS_DIR)
    ? fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.jsonl')).sort()
    : [];

describe('bd recordings fidelity', () => {
    test('recordings exist for the replay-mode suite', { skip: RECORDING_IN_PROGRESS && 'recordings are being rewritten by this record-mode run' }, () => {
        assert.ok(
            recordingFiles.length > 0,
            `No bd recordings found in ${RECORDINGS_DIR} -- replay mode (the default) cannot work. Re-record with: npm run test:record --workspace=@apralabs/apra-fleet-se`,
        );
    });

    for (const file of recordingFiles) {
        const scenarioKey = path.basename(file, '.jsonl');

        test(`recording '${scenarioKey}' is a faithful, complete real-bd capture`, () => {
            const fullPath = path.join(RECORDINGS_DIR, file);
            const raw = fs.readFileSync(fullPath, 'utf8');

            // ASCII-only bytes: the recorder \uXXXX-escapes everything
            // non-ASCII at capture time, so any non-ASCII here means the
            // file was edited outside the recorder.
            for (let i = 0; i < raw.length; i++) {
                const code = raw.charCodeAt(i);
                assert.ok(
                    code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e),
                    `${file}: non-ASCII or control byte (0x${code.toString(16)}) at offset ${i} -- recordings must be regenerated via 'npm run test:record', not hand-edited`,
                );
            }

            const entries = loadRecording(fullPath);
            assert.ok(entries.length > 0, `${file}: recording is empty`);

            const rawLines = raw.split('\n').filter((l) => l.trim().length > 0);
            const allStdout = entries.map((e) => e.stdout ?? '').join('\n');

            entries.forEach((entry, i) => {
                const where = `${file} entry #${i}`;

                // Round-trip check: every line must be exactly what the
                // recorder itself would serialize -- catches hand edits
                // (reordered keys, extra fields, unescaped unicode) even
                // when they still parse as valid JSON.
                assert.strictEqual(
                    rawLines[i],
                    toAsciiJsonLine(entry),
                    `${where}: line does not round-trip through the recorder's own serializer -- recording was modified outside 'npm run test:record'`,
                );

                assert.strictEqual(typeof entry.command, 'string', `${where}: missing command`);
                assert.match(entry.command, /^\s*bd(\s|$)/, `${where}: recorded a non-bd command: ${JSON.stringify(entry.command)}`);
                assert.strictEqual(
                    typeof entry.exitCode,
                    'number',
                    `${where}: incomplete entry (exitCode ${JSON.stringify(entry.exitCode)}) -- the recording run crashed mid-scenario; re-record`,
                );
                assert.strictEqual(typeof entry.stdout, 'string', `${where}: missing stdout`);
                assert.strictEqual(typeof entry.stderr, 'string', `${where}: missing stderr`);

                // Every successful `... --json` response must be valid JSON
                // exactly as real bd emits it -- parseBdJson() consumers
                // replay these bytes verbatim.
                if (entry.exitCode === 0 && /\s--json(\s|$)/.test(entry.command)) {
                    assert.doesNotThrow(
                        () => JSON.parse(entry.stdout),
                        `${where}: stdout of ${JSON.stringify(entry.command)} is not valid JSON`,
                    );
                }

                // `bd create ... --silent` prints exactly the created id: a
                // single token prefixed by the scenario's tempDir-derived
                // issue prefix (which itself starts with the scenario key).
                if (entry.exitCode === 0 && /^bd create\b/.test(entry.command) && /--silent\b/.test(entry.command)) {
                    const id = entry.stdout.trim();
                    assert.ok(
                        id.length > 0 && !/\s/.test(id) && id.startsWith(`${scenarioKey}-`),
                        `${where}: --silent create stdout ${JSON.stringify(entry.stdout)} is not a single '${scenarioKey}-*' bead id`,
                    );
                }

                // Coherence: any bead id a recorded command references must
                // have appeared in some recorded bd response in this same
                // scenario -- tests/runner.js only ever learn ids from bd
                // stdout, so a genuine capture can never violate this.
                const idPattern = new RegExp(`${scenarioKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+-\\d+-[A-Za-z0-9]+`, 'g');
                for (const refId of entry.command.match(idPattern) ?? []) {
                    assert.ok(
                        allStdout.includes(refId),
                        `${where}: command references bead id ${refId} that appears in no recorded bd stdout -- incoherent recording`,
                    );
                }
            });
        });
    }
});
