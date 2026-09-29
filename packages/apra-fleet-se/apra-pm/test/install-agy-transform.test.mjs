// apra-fleet-oomh.6: install.mjs branched on the provider with only an
// opencode transform; --llm agy wrote the Claude-only frontmatter tools list
// (including tools with no Antigravity mapping) entirely untransformed, so an
// agy-provider agent could be told it has a tool (in its own frontmatter)
// that the real Antigravity harness never grants. This ports
// transformAgentForAgy from src/cli/agent-transform.ts into install.mjs (kept
// in sync per the comment at the top of that file) and wires it into the
// install() agent-writing loop for --llm agy, mirroring the existing
// transformAgentForOpenCode treatment.
//
// resolveAgentConditionals() also had to start resolving agy's body against
// agyToolMap's keys (previously it fell through to claude semantics for agy,
// which was correct ONLY because no agy frontmatter transform existed yet --
// see apra-fleet-oomh.4's test file for the prior behavior). Now that the
// frontmatter is transformed for agy, the body must agree with it or the
// split-brain apra-fleet-oomh bug reappears one level down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveAgentConditionals, transformAgentForAgy } from '../install.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// Mirrors install()'s own pipeline: resolve conditionals first (against the
// still-Claude-format frontmatter), then rewrite the frontmatter.
function pipeline(content, filename) {
  const resolved = resolveAgentConditionals(content, 'agy', filename);
  return transformAgentForAgy(resolved, filename);
}

// ---- direct unit coverage (mirrors tests/agent-transform.test.ts's
// transformAgentForAgy suite for the main installer) ------------------------

test('transformAgentForAgy: drops tools with no Antigravity mapping and never emits them verbatim', () => {
  const source = [
    '---',
    'name: doer',
    'description: Executes plan tasks.',
    'tools: [Read, Edit, Write, Bash, Grep, Glob, Agent, ToolSearch]',
    '---',
    '',
    '# Body',
  ].join('\n');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  let result;
  try {
    result = transformAgentForAgy(source, 'doer.md');
  } finally {
    console.warn = originalWarn;
  }

  const toolsLine = result.split('\n').find((l) => l.startsWith('tools:'));
  assert.ok(toolsLine, 'a tools: line must be emitted');
  for (const mapped of ['view_file', 'replace_file_content', 'write_to_file', 'run_command', 'grep_search', 'list_dir', 'invoke_subagent', 'send_message']) {
    assert.ok(toolsLine.includes(mapped), `tools line must include mapped tool ${mapped}`);
  }
  assert.equal(toolsLine.includes('ToolSearch'), false, 'ToolSearch has no agy mapping and must not survive');
  assert.equal(warnings.length, 1, 'exactly one warning for the unmapped tool');
  assert.match(warnings[0], /ToolSearch/);
});

test('transformAgentForAgy: omits the tools line entirely when every tool is unmapped', () => {
  const source = [
    '---',
    'name: doer',
    'description: Executes plan tasks.',
    'tools: [ToolSearch]',
    '---',
    '',
    '# Body',
  ].join('\n');

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = transformAgentForAgy(source, 'doer.md');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.split('\n').some((l) => l.startsWith('tools:')), false);
});

test('transformAgentForAgy: returns non-frontmatter files unchanged', () => {
  const raw = '# Plain Agent\nNo frontmatter.';
  assert.equal(transformAgentForAgy(raw, 'plain.md'), raw);
});

test('transformAgentForAgy: emits XML auto_approve permission rules for read/write/bash/agent', () => {
  const source = [
    '---',
    'name: doer',
    'description: Executes plan tasks.',
    'tools: [Read, Edit, Write, Bash, Agent]',
    '---',
    '',
    '# Body',
  ].join('\n');
  const result = transformAgentForAgy(source, 'doer.md');
  assert.ok(result.includes('<rule>'));
  assert.ok(result.includes('<auto_approve>'));
  assert.ok(result.includes('<permission action="read_file" target="*" />'));
  assert.ok(result.includes('<permission action="write_file" target="*" />'));
  assert.ok(result.includes('<permission action="command" target="*" />'));
  assert.ok(result.includes('<permission action="invoke_subagent" target="*" />'));
  assert.ok(result.includes('<permission action="send_message" target="*" />'));
  assert.ok(result.includes('</auto_approve>'));
  assert.ok(result.includes('</rule>'));
  assert.ok(result.includes('# Body'));
});

// ---- pipeline coverage: resolveAgentConditionals() + transformAgentForAgy()
// together, against install.mjs's real, checked-in role prompts. This is the
// closest an .mjs unit test gets to the parent bug's acceptance criterion:
// "no installed agent file references a tool the transform dropped from its
// own frontmatter, in body text or frontmatter" (apra-fleet-oomh). -----------

test('pipeline: doer.md for agy drops ToolSearch from frontmatter AND from body prose', () => {
  const raw = fs.readFileSync(join(ROOT, 'agents', 'doer.md'), 'utf-8');
  const result = pipeline(raw, 'doer.md');

  const toolsLine = result.split('\n').find((l) => l.startsWith('tools:'));
  assert.ok(toolsLine, 'a tools: line must be emitted');
  assert.equal(toolsLine.includes('ToolSearch'), false, 'ToolSearch must not survive in the agy frontmatter');

  assert.equal(result.includes('Run ToolSearch with query'), false, 'the ToolSearch-only prose must not survive in the agy body');
  assert.doesNotMatch(result, /<!--\s*(if-tool|else-tool|end-tool):/, 'no marker syntax may survive');
});

test('pipeline: no --llm agy output for any shipped role prompt references a tool its own frontmatter dropped', () => {
  const agentsDir = join(ROOT, 'agents');
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'test setup: at least one role prompt must exist');

  for (const file of files) {
    const raw = fs.readFileSync(join(agentsDir, file), 'utf-8');
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!fmMatch) continue; // no frontmatter, nothing to drop
    const toolsMatch = fmMatch[1].split('\n').find((l) => /^tools:\s*/.test(l));
    if (!toolsMatch) continue;
    const sourceTools = toolsMatch.replace(/^tools:\s*/, '').replace(/^\[/, '').replace(/\]$/, '')
      .split(',').map((t) => t.trim()).filter(Boolean);

    const result = pipeline(raw, file);
    for (const tool of sourceTools) {
      if (tool === '*') continue;
      // A tool with an agy mapping is expected to survive (as its mapped name);
      // only unmapped tools must be fully absent from the output.
      const agyToolMapKeys = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Agent'];
      if (agyToolMapKeys.includes(tool)) continue;
      assert.equal(
        result.includes(tool),
        false,
        `${file}: dropped tool "${tool}" must not appear anywhere in the agy output (frontmatter or body)`
      );
    }
    assert.doesNotMatch(result, /<!--\s*(if-tool|else-tool|end-tool):/, `${file}: no marker syntax may survive`);
  }
});

// ---- source-introspection: install() actually wires transformAgentForAgy in

test('install.mjs calls transformAgentForAgy for --llm agy (source check)', () => {
  const src = fs.readFileSync(join(ROOT, 'install.mjs'), 'utf-8');
  assert.match(
    src,
    /args\.llm\s*===\s*['"]agy['"]\s*\)\s*content\s*=\s*transformAgentForAgy\(content,\s*a\)/,
    'the agy branch must call transformAgentForAgy(content, a)'
  );
  assert.match(
    src,
    /supported\s*=\s*llm\s*===\s*['"]opencode['"][\s\S]*?llm\s*===\s*['"]agy['"]\s*\?\s*Object\.keys\(agyToolMap\)/,
    'resolveAgentConditionals must resolve agy bodies against agyToolMap, not fall through to claude semantics'
  );
});
