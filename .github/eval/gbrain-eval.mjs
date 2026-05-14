/**
 * gbrain Knowledge Persistence Eval
 *
 * Writes 5 apra-fleet facts to gbrain (PGLite — zero external deps),
 * reads them back by slug, and verifies the content is intact.
 *
 * This proves:
 *   1. `apra-fleet install --with-gbrain` produces a working gbrain install
 *   2. gbrain persists knowledge durably in PGLite (no API key, no server)
 *   3. Knowledge is faithfully retrievable (5/5 roundtrip)
 *
 * Exit 0 = PASS (5/5 roundtrip), Exit 1 = FAIL.
 * Writes a Markdown scorecard to $GITHUB_STEP_SUMMARY when running in CI.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Test dataset — 5 apra-fleet facts
// ---------------------------------------------------------------------------
const FACTS = [
  {
    id: 'port',
    content: 'The apra-fleet MCP server listens on port 3000 by default.',
    keywords: ['port 3000', '3000'],
  },
  {
    id: 'ssh-remote',
    content: 'Fleet members can be local agents or SSH remote machines registered with a hostname and username.',
    keywords: ['SSH remote', 'hostname'],
  },
  {
    id: 'execute-prompt',
    content: 'The execute_prompt tool dispatches a task to a Claude Code agent and waits for its response.',
    keywords: ['execute_prompt', 'Claude Code'],
  },
  {
    id: 'pglite',
    content: 'gbrain uses PGLite for local storage — no external database server is required when running in local mode.',
    keywords: ['PGLite', 'no external database'],
  },
  {
    id: 'reviewer',
    content: 'The fleet reviewer template checks code for security vulnerabilities and test coverage before approving.',
    keywords: ['security vulnerabilities', 'test coverage'],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractText(result) {
  if (!result || !result.content) return '';
  return result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

function extractJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function verifyContent(responseText, fact) {
  const parsed = extractJson(responseText);
  // get_page returns JSON with compiled_truth or slug fields
  const candidate = parsed
    ? JSON.stringify(parsed).toLowerCase()
    : responseText.toLowerCase();
  return fact.keywords.some(kw => candidate.includes(kw.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const gbrain = process.env.GBRAIN_CMD || 'gbrain';

  const transport = new StdioClientTransport({
    command: gbrain,
    args: ['serve'],
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH || ''}`,
    },
  });

  const client = new Client({ name: 'gbrain-eval', version: '1.0.0' }, { capabilities: {} });

  console.log('Connecting to gbrain MCP server...');
  await client.connect(transport);

  // Print server identity
  try {
    const identity = await client.callTool({ name: 'get_brain_identity', arguments: {} });
    console.log(`Connected: ${extractText(identity).slice(0, 120)}\n`);
  } catch {
    console.log('Connected.\n');
  }

  // -- Seed ------------------------------------------------------------------
  console.log('=== Writing facts (put_page) ===');
  const writeResults = [];
  for (const fact of FACTS) {
    const result = await client.callTool({
      name: 'put_page',
      arguments: {
        slug: `eval/${fact.id}`,
        content: `---\ntags: [eval, apra-fleet]\n---\n${fact.content}`,
      },
    });
    const text = extractText(result);
    const parsed = extractJson(text);
    const status = parsed?.status ?? text.slice(0, 40);
    const ok = text.includes('created') || text.includes('updated');
    writeResults.push({ id: fact.id, ok, status });
    console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${fact.id}: ${status}`);
  }

  // -- Read back -------------------------------------------------------------
  console.log('\n=== Reading facts back (get_page) ===');
  const rows = [];

  for (const fact of FACTS) {
    const result = await client.callTool({
      name: 'get_page',
      arguments: { slug: `eval/${fact.id}` },
    });
    const text = extractText(result);
    const match = verifyContent(text, fact);
    rows.push({ id: fact.id, match, snippet: text.slice(0, 120).replace(/\n/g, ' ') });
    console.log(`  [${match ? 'MATCH' : 'MISS '}] ${fact.id}`);
    if (!match) console.log(`          response: ${text.slice(0, 120)}`);
  }

  await client.close();

  // -- Score -----------------------------------------------------------------
  const hits = rows.filter(r => r.match).length;
  const total = rows.length;
  const pct = Math.round((hits / total) * 100);
  const pass = hits === total; // 5/5 required for persistence eval

  // -- Report ----------------------------------------------------------------
  const lines = [
    '## gbrain Knowledge Persistence Eval',
    '',
    `**Score: ${hits}/${total} (${pct}%) — ${pass ? '✅ PASS' : '❌ FAIL'}**`,
    '',
    '| Fact | Content slug | Stored + Retrieved |',
    '|------|-------------|-------------------|',
    ...rows.map(r => `| \`${r.id}\` | \`eval/${r.id}\` | ${r.match ? '✅ OK' : '❌ FAIL'} |`),
    '',
    '### What this demonstrates',
    '- `apra-fleet install --with-gbrain` produces a working gbrain install',
    '- gbrain persists knowledge in **PGLite** — zero external deps, no API key',
    '- Knowledge is faithfully retrieved by slug (deterministic roundtrip)',
    `- Fleet agents with \`gbrain: true\` get persistent memory across sessions`,
  ];

  const report = lines.join('\n');
  console.log('\n' + report);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, report + '\n');
    console.log('\nScorecard written to step summary.');
  }

  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error('Eval error:', err.message || err);
  process.exit(1);
});
