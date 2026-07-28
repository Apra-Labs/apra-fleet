import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Import the exported functions from install.mjs.
// The isMain guard prevents main() from running on import.
import { claudeOnlyPermissions } from '../install.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../install.mjs'), 'utf-8');

// ---- claudeOnlyPermissions() direct call ------------------------------------

test('claudeOnlyPermissions()[0] === "Bash(*)"', () => {
  const perms = claudeOnlyPermissions();
  assert.ok(Array.isArray(perms), 'claudeOnlyPermissions must return an array');
  assert.equal(perms[0], 'Bash(*)', 'First element must be "Bash(*)"');
});

test('claudeOnlyPermissions() includes Bash(*) somewhere in the list', () => {
  const perms = claudeOnlyPermissions();
  assert.ok(perms.includes('Bash(*)'), 'Bash(*) must be present in claudeOnlyPermissions()');
});

// ---- Settings merge for claude includes Bash(*) (source-introspection) ------

test('claude provider settings merge pushes claudeOnlyPermissions (source check)', () => {
  // The source must show that only the claude branch adds claudeOnlyPermissions().
  assert.match(
    src,
    /if\s*\(\s*args\.llm\s*===\s*['"]claude['"]\s*\)\s*perms\.push\(\.\.\.\s*claudeOnlyPermissions\(\)\s*\)/,
    'source must push claudeOnlyPermissions() into perms only for claude'
  );
});

test('gemini provider does not push claudeOnlyPermissions (source check)', () => {
  // Confirm there is no unconditional or gemini-specific push of claudeOnlyPermissions.
  // The only push of claudeOnlyPermissions must be inside the "if llm === claude" block.
  const pushOccurrences = [...src.matchAll(/perms\.push\(\.\.\.\s*claudeOnlyPermissions\(\)\s*\)/g)];
  assert.equal(pushOccurrences.length, 1, 'claudeOnlyPermissions() must be pushed exactly once');

  // That one push must be inside the "if (args.llm === 'claude')" guard.
  const pushIdx = src.indexOf("perms.push(...claudeOnlyPermissions())");
  const guardIdx = src.lastIndexOf("if (args.llm === 'claude')", pushIdx);
  assert.ok(guardIdx >= 0 && guardIdx < pushIdx, 'the single push must follow a "if (args.llm === \'claude\')" guard');
});

test('opencode provider removes permissions key (source check)', () => {
  // For opencode the permissions block is deleted from settings.json.
  // Confirm the source has the opencode branch that deletes settings.permissions.
  assert.match(
    src,
    /args\.llm\s*===\s*['"]opencode['"]/,
    'source must have an opencode-specific branch'
  );
  assert.match(
    src,
    /delete\s+settings\.permissions/,
    'opencode branch must delete the permissions key'
  );
});

test('Bash(*) not present in requiredPermissions (shared across all providers)', () => {
  // requiredPermissions() is called for all providers; it must not include Bash(*).
  const reqPermsBlock = src.slice(
    src.indexOf('function requiredPermissions('),
    src.indexOf('\nfunction', src.indexOf('function requiredPermissions(') + 1)
  );
  assert.doesNotMatch(reqPermsBlock, /'Bash\(\*\)'/, 'Bash(*) must not appear in requiredPermissions()');
});
