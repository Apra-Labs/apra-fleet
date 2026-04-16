#!/usr/bin/env node
/**
 * gen-llms-full.mjs — generates llms-full.txt at the repo root.
 *
 * Reads the five canonical docs listed in llms.txt, wraps each in an XML
 * <doc> element, and writes the result to llms-full.txt so LLM clients can
 * fetch the full content in a single request (llmstxt.org convention).
 *
 * No external dependencies — uses only Node built-ins.
 * Run: node scripts/gen-llms-full.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const docs = [
  {
    path: 'docs/user-guide.md',
    title: 'User Guide',
    desc: 'Installation, configuration, member registration, and day-to-day usage for operators.',
  },
  {
    path: 'docs/vocabulary.md',
    title: 'Vocabulary',
    desc: 'Shared terminology — member, task, skill, PM, fleet, doer/reviewer pattern.',
  },
  {
    path: 'docs/provider-matrix.md',
    title: 'Provider Matrix',
    desc: 'Which LLM providers are supported, their capabilities, and how to configure them.',
  },
  {
    path: 'docs/FAQ.md',
    title: 'FAQ',
    desc: 'Common questions about setup, troubleshooting, and the doer-reviewer loop.',
  },
  {
    path: 'docs/architecture.md',
    title: 'Architecture',
    desc: 'How the fleet hub, MCP server, and members interact at a system level.',
  },
];

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const docBlocks = docs.map(({ path, title, desc }) => {
  const content = readFileSync(join(root, path), 'utf-8');
  return `  <doc title="${escapeXml(title)}" desc="${escapeXml(desc)}">\n${content.trimEnd()}\n  </doc>`;
});

const output = `<project title="Apra Fleet" summary="AI-managed fleet orchestration for Claude Code — run, update, and coordinate multiple Claude Code agents from a single hub.">
  <docs>
${docBlocks.join('\n\n')}
  </docs>
</project>\n`;

const outPath = join(root, 'llms-full.txt');
writeFileSync(outPath, output, 'utf-8');
console.log(`Written: ${outPath} (${output.length} bytes, ${docs.length} docs)`);
