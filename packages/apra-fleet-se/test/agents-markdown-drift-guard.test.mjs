import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-xbu.3.2 -- drift guard for agents/ and dist/agents/ markdown copies.
//
// Purpose: agents/planner.md and agents/plan-reviewer.md at the repo root
// are canonical copies of dist/agents/planner.md and dist/agents/plan-reviewer.md,
// because runner.js references the dist/ copies to dispatch planner and plan-reviewer
// agents. The source copies in agents/ are what developers see and read first; if
// they drift from dist/, edits to the "wrong copy" will silently no-op at runtime.
//
// This test catches that drift mechanically by comparing the content of both pairs
// of files. If they differ, the test fails with guidance on which version is
// canonical and which should be resync'd.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');

describe('agents/ markdown files stay in sync with dist/agents/ (apra-fleet-xbu.3.2)', () => {
    const files = [
        { source: 'agents/planner.md', dist: 'dist/agents/planner.md', name: 'planner.md' },
        { source: 'agents/plan-reviewer.md', dist: 'dist/agents/plan-reviewer.md', name: 'plan-reviewer.md' },
    ];

    for (const { source, dist, name } of files) {
        test(`${name}: source and dist/ copies are identical`, () => {
            const sourcePath = path.join(ROOT, source);
            const distPath = path.join(ROOT, dist);

            assert.ok(fs.existsSync(sourcePath), `source file does not exist: ${sourcePath}`);
            assert.ok(fs.existsSync(distPath), `dist file does not exist: ${distPath}`);

            const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
            const distContent = fs.readFileSync(distPath, 'utf-8');

            assert.strictEqual(
                sourceContent,
                distContent,
                `${name} has drifted: agents/${name} and dist/agents/${name} differ. ` +
                    `dist/agents/${name} is canonical (referenced by runner.js); ` +
                    `sync agents/${name} to match dist/agents/${name} in the same commit.`,
            );
        });
    }
});
