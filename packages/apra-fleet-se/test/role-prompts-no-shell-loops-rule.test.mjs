import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every top-level role prompt in apra-pm/agents must carry the generic
// "No shell loops" rule (run commands as separate tool calls). Role files are
// enumerated at test time, so a new role file without the rule fails.
// Falsifiable: deleting the rule marker from any one role file fails that
// file's subtest.

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apra-pm', 'agents');
const MARKER = 'No shell loops:';
const roleFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));

test('role prompt directory is non-empty', () => {
    assert.ok(roleFiles.length > 0, 'no role prompt files found');
});

for (const f of roleFiles) {
    test(`${f} carries the no-shell-loops rule`, () => {
        const text = readFileSync(join(AGENTS_DIR, f), 'utf8');
        assert.ok(text.includes(MARKER), `${f} is missing the "${MARKER}" rule`);
        assert.ok(/separate tool call/.test(text), `${f} rule lacks the separate-tool-call instruction`);
    });
}
