// apra-fleet-unw.21: install.mjs must install agents/schemas/ alongside
// agents/*.md, so the machine-readable role contracts (and the
// .claude/workflows/auto-sprint.js loadRoleSchema() lookup, which resolves
// them relative to the installed workflow file's location) are present on
// every provider's config dir. There is no exported install() to call
// directly (only uninstall() is exported, mirroring test/install-
// permissions.test.mjs's approach for the parts of install.mjs that aren't
// exported), so this is a source-introspection test, consistent with that
// file's existing convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const src = readFileSync(join(ROOT, 'install.mjs'), 'utf-8');

test('agents/schemas/ exists in this checkout with at least one schema file', () => {
  const schemasDir = join(ROOT, 'agents', 'schemas');
  assert.ok(existsSync(schemasDir), 'agents/schemas/ must exist');
  const files = readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'agents/schemas/ must contain at least one .json file');
});

test('install.mjs copies agents/schemas/ into <configDir>/agents/schemas (source check)', () => {
  assert.match(
    src,
    /const schemasSrc\s*=\s*path\.join\(agentsSrc,\s*['"]schemas['"]\)/,
    'install.mjs must derive schemasSrc from agentsSrc'
  );
  assert.match(
    src,
    /copyDir\(schemasSrc,\s*schemasDest\)/,
    'install.mjs must copy schemasSrc into schemasDest'
  );
});

test('install.mjs\'s schemasDest is a child of agentsDest, i.e. installed alongside agents/*.md (source check)', () => {
  assert.match(
    src,
    /const schemasDest\s*=\s*path\.join\(agentsDest,\s*['"]schemas['"]\)/,
    'schemasDest must be path.join(agentsDest, "schemas")'
  );
});

test('uninstall() removes the installed agents/schemas directory (source check)', () => {
  const uninstallBody = src.slice(src.indexOf('function uninstall('), src.indexOf('\n// --- main'));
  assert.match(
    uninstallBody,
    /schemasDest\s*=\s*path\.join\(agentsDest,\s*['"]schemas['"]\)/,
    'uninstall() must resolve the same schemasDest path as install'
  );
  assert.match(
    uninstallBody,
    /rmSync\(schemasDest,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/,
    'uninstall() must remove schemasDest recursively'
  );
});
