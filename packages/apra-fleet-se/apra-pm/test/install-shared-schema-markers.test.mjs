// apra-fleet-oomh.4: agents/schemas/*.json and agents/_shared/*.md were
// copied with a raw copyDir() (no marker resolution), unlike agents/*.md
// which already runs through resolveAgentConditionals() in install()'s main
// loop (~line 480). If either tree ever grows a conditional marker, the main
// apra-fleet installer (src/cli/install.ts) would resolve it per-provider via
// loadAgentAssets() (which recurses into _shared/ and schemas/), while this
// installer would ship the raw <!-- if-tool: ... --> HTML comments verbatim --
// exactly the split-brain failure the shared marker contract exists to
// prevent. copyDirResolved() closes that gap for every asset kind copied
// alongside agents/*.md.
//
// These tests use an invented tool name ("Telepathy") so no case can pass by
// special-casing a real one -- mirrors tests/agent-transform.test.ts's
// convention for the same mechanism in the main installer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveAgentConditionals, copyDirResolved } from '../install.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(join(__dir, '../install.mjs'), 'utf-8');

// ---- resolveAgentConditionals() direct calls (schemas/_shared have no
// frontmatter, so these exercise the "declared === null" path) -------------

test('resolveAgentConditionals: claude keeps the if-branch for a frontmatter-less body', () => {
  const body = '<!-- if-tool: Telepathy -->keep-if<!-- else-tool: Telepathy -->keep-else<!-- end-tool: Telepathy -->';
  assert.equal(resolveAgentConditionals(body, 'claude', 'GRAPH-SEMANTICS.md'), 'keep-if');
});

test('resolveAgentConditionals: agy resolves against agyToolMap -- an invented tool name falls to the else-branch (apra-fleet-oomh.6)', () => {
  const body = '<!-- if-tool: Telepathy -->keep-if<!-- else-tool: Telepathy -->keep-else<!-- end-tool: Telepathy -->';
  assert.equal(resolveAgentConditionals(body, 'agy', 'GRAPH-SEMANTICS.md'), 'keep-else');
});

test('resolveAgentConditionals: agy keeps the if-branch for a tool it maps (Bash)', () => {
  const body = '<!-- if-tool: Bash -->keep-if<!-- else-tool: Bash -->keep-else<!-- end-tool: Bash -->';
  assert.equal(resolveAgentConditionals(body, 'agy', 'GRAPH-SEMANTICS.md'), 'keep-if');
});

test('resolveAgentConditionals: opencode resolves against OPENCODE_NATIVE_TOOLS -- an invented tool name falls to the else-branch', () => {
  const body = '<!-- if-tool: Telepathy -->keep-if<!-- else-tool: Telepathy -->keep-else<!-- end-tool: Telepathy -->';
  assert.equal(resolveAgentConditionals(body, 'opencode', 'GRAPH-SEMANTICS.md'), 'keep-else');
});

test('resolveAgentConditionals: opencode keeps the if-branch for a tool it natively supports (Bash)', () => {
  const body = '<!-- if-tool: Bash -->keep-if<!-- else-tool: Bash -->keep-else<!-- end-tool: Bash -->';
  assert.equal(resolveAgentConditionals(body, 'opencode', 'GRAPH-SEMANTICS.md'), 'keep-if');
});

// ---- copyDirResolved() end-to-end: no marker syntax survives, for any
// --llm, in a synthetic schemas/_shared-style tree --------------------------

test('copyDirResolved: no conditional marker survives in a copied tree, for any --llm', () => {
  for (const llm of ['claude', 'agy', 'opencode']) {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-copy-resolved-src-'));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-copy-resolved-dest-'));
    try {
      fs.writeFileSync(
        path.join(srcDir, 'GRAPH-SEMANTICS.md'),
        '# doc\n<!-- if-tool: Telepathy -->\nprose\n<!-- end-tool: Telepathy -->\n'
      );
      fs.mkdirSync(path.join(srcDir, 'nested'));
      fs.writeFileSync(path.join(srcDir, 'nested', 'schema.json'), '{"ok": true}');

      copyDirResolved(srcDir, destDir, llm);

      const doc = fs.readFileSync(path.join(destDir, 'GRAPH-SEMANTICS.md'), 'utf-8');
      assert.doesNotMatch(
        doc,
        /<!--\s*(if-tool|else-tool|end-tool):/,
        `${llm}: marker syntax must not survive into the copied file`
      );

      const schema = fs.readFileSync(path.join(destDir, 'nested', 'schema.json'), 'utf-8');
      assert.equal(schema, '{"ok": true}', `${llm}: a plain file with no markers must copy through unchanged`);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  }
});

// ---- source-introspection: install() actually wires copyDirResolved in ----

test('install.mjs routes schemasSrc and sharedSrc through copyDirResolved, not the raw copyDir (source check)', () => {
  assert.match(
    src,
    /copyDirResolved\(schemasSrc,\s*schemasDest,\s*args\.llm\)/,
    'schemasSrc must be copied through copyDirResolved (apra-fleet-oomh.4)'
  );
  assert.match(
    src,
    /copyDirResolved\(sharedSrc,\s*sharedDest,\s*args\.llm\)/,
    'sharedSrc must be copied through copyDirResolved (apra-fleet-oomh.4)'
  );
});
