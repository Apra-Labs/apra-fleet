/**
 * gbrain BM25 Recall Eval
 *
 * Seeds 5 apra-fleet facts into gbrain, queries them with paraphrased questions,
 * and scores keyword recall. No API key required — PGLite + BM25 keyword mode only.
 *
 * Exit 0 = PASS (≥2/5 recall), Exit 1 = FAIL.
 * Writes a Markdown scorecard to $GITHUB_STEP_SUMMARY when running in CI.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Test dataset — 5 facts about apra-fleet + paired recall queries
// ---------------------------------------------------------------------------
const FACTS = [
  {
    id: 'port',
    content: 'The apra-fleet MCP server listens on port 3000 by default.',
    query: 'What network port does the fleet server use?',
    keywords: ['3000'],
  },
  {
    id: 'ssh-remote',
    content: 'Fleet members can be local agents or SSH remote machines registered with a hostname and username.',
    query: 'Can fleet connect to remote machines over SSH?',
    keywords: ['ssh', 'remote'],
  },
  {
    id: 'execute-prompt',
    content: 'The execute_prompt tool dispatches a task to a Claude Code agent and waits for its response.',
    query: 'Which fleet tool sends a prompt to an AI agent?',
    keywords: ['execute_prompt'],
  },
  {
    id: 'pglite',
    content: 'gbrain uses PGLite for local storage — no external database server is required when running in local mode.',
    query: 'Does gbrain need a separate database server to run locally?',
    keywords: ['pglite', 'local'],
  },
  {
    id: 'reviewer',
    content: 'The fleet reviewer template checks code for security vulnerabilities and test coverage before approving.',
    query: 'What does the reviewer check before approving a PR?',
    keywords: ['security', 'test'],
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

function scoreHit(responseText, keywords) {
  const lower = responseText.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
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
      // Ensure bun bin dir is on PATH so gbrain shebang resolves
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH || ''}`,
    },
  });

  const client = new Client({ name: 'gbrain-eval', version: '1.0.0' }, { capabilities: {} });

  console.log('Connecting to gbrain MCP server...');
  await client.connect(transport);
  console.log('Connected.\n');

  // -- Seed ------------------------------------------------------------------
  console.log('=== Seeding facts ===');
  for (const fact of FACTS) {
    await client.callTool({
      name: 'brain_write',
      arguments: { content: fact.content, collection: 'eval' },
    });
    console.log(`  [seed] ${fact.id}`);
  }

  // Small delay — BM25 index is synchronous but let writes settle
  await new Promise(r => setTimeout(r, 500));

  // -- Query -----------------------------------------------------------------
  console.log('\n=== Recall queries ===');
  const rows = [];

  for (const fact of FACTS) {
    const result = await client.callTool({
      name: 'brain_query',
      arguments: { query: fact.query, collection: 'eval' },
    });
    const text = extractText(result);
    const hit = scoreHit(text, fact.keywords);
    rows.push({ id: fact.id, query: fact.query, hit, snippet: text.slice(0, 120).replace(/\n/g, ' ') });
    console.log(`  [${hit ? 'HIT ' : 'MISS'}] ${fact.id}: ${fact.query}`);
    if (!hit) console.log(`         response: ${text.slice(0, 120)}`);
  }

  await client.close();

  // -- Score -----------------------------------------------------------------
  const hits = rows.filter(r => r.hit).length;
  const total = rows.length;
  const pct = Math.round((hits / total) * 100);
  const pass = hits >= 2;

  // -- Report ----------------------------------------------------------------
  const lines = [
    '## gbrain BM25 Recall Eval',
    '',
    `**Score: ${hits}/${total} (${pct}%) — ${pass ? '✅ PASS' : '❌ FAIL'}**`,
    '',
    '| Fact | Query | Result |',
    '|------|-------|--------|',
    ...rows.map(r => `| \`${r.id}\` | ${r.query} | ${r.hit ? '✅ HIT' : '❌ MISS'} |`),
    '',
    '### What this shows',
    '- gbrain stores knowledge persistently (PGLite — zero external deps)',
    '- BM25 keyword recall retrieves seeded facts from natural-language queries',
    `- Threshold: ≥2/5 facts recalled — **${pass ? 'met' : 'not met'}**`,
    '',
    `> Mode: BM25 keyword search (no embedding model, no API key required)`,
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
