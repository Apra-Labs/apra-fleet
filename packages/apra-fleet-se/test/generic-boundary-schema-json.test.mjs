import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listEngineFiles, scanFiles } from '../scripts/check-generic-boundary.mjs';

// The engine file-set collection must cover apra-pm/agents/schemas/*.json:
// schema descriptions are LLM-facing and ship to every target. These tests go
// through file-set collection (runEngineScan over a temp package root), not
// scanSource alone, so they fail if .json files are not collected.

// File-set collection plus scanning; the repo-wide ALLOWED_EXCEPTIONS name real
// engine files, so they are deliberately not applied to a temp root.
const scan = (packageRoot) => {
    const files = listEngineFiles(packageRoot);
    return { files, violations: scanFiles(files).findings };
};

let root;
const write = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
};
const schema = (description) => JSON.stringify({ type: 'object', properties: { content: { type: 'string', description } } }, null, 2);

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-schema-json-')); });
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a tracker id inside an agents schema json is one bead-id-in-llm-text violation naming that file', () => {
    write('apra-pm/agents/schemas/leaky-output.json', schema('REQUIRED; rejected and persists nothing (apra-fleet-23c).'));
    const { files, violations } = scan(root);
    assert.ok(files.some((f) => f.rel === 'apra-pm/agents/schemas/leaky-output.json'), 'the json schema must be collected');
    const v = violations.filter((x) => x.id === 'bead-id-in-llm-text');
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.equal(v.length, 1);
    assert.match(JSON.stringify(v[0]), /apra-pm\/agents\/schemas\/leaky-output\.json/);
    fs.rmSync(path.join(root, 'apra-pm/agents/schemas/leaky-output.json'));
});

test('a clean schema json yields zero violations', () => {
    write('apra-pm/agents/schemas/clean-output.json', schema('REQUIRED; a capture without it is rejected and persists nothing.'));
    const { files, violations } = scan(root);
    assert.ok(files.some((f) => f.rel === 'apra-pm/agents/schemas/clean-output.json'));
    assert.deepEqual(violations, []);
    fs.rmSync(path.join(root, 'apra-pm/agents/schemas/clean-output.json'));
});

test('an .md under apra-pm/agents is still scanned', () => {
    write('apra-pm/agents/role.md', 'Track the work in apra-fleet-23c please.\n');
    const { files, violations } = scan(root);
    assert.ok(files.some((f) => f.rel === 'apra-pm/agents/role.md'));
    assert.ok(violations.some((x) => x.id === 'bead-id-in-llm-text'), JSON.stringify(violations));
});
