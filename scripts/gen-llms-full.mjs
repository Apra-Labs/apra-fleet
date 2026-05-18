#!/usr/bin/env node
/**
 * gen-llms-full.mjs -- generates llms-full.txt at the repo root.
 *
 * Reads llms.txt, extracts every markdown link from list items, filters to
 * local files that exist on disk (skips http/https/mailto and missing paths),
 * and concatenates those docs into llms-full.txt wrapped in XML elements
 * (llmstxt.org convention).
 *
 * No external dependencies -- uses only Node built-ins.
 * Run: node scripts/gen-llms-full.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// --- Parse llms.txt ---

const llmsTxtPath = join(root, 'llms.txt');
if (!existsSync(llmsTxtPath)) {
  console.error('ERROR: llms.txt not found at repo root');
  process.exit(1);
}

const llmsTxt = readFileSync(llmsTxtPath, 'utf-8');

// Extract project title and summary from H1 and blockquote
const h1Match = llmsTxt.match(/^#\s+(.+)/m);
const bqMatch = llmsTxt.match(/^>\s+(.+)/m);
const projectTitle = h1Match ? h1Match[1].trim() : 'Apra Fleet';
const projectSummary = bqMatch ? bqMatch[1].trim() : '';

// Parse list-item markdown links: - [Title](url): description
// Also handles lines without a trailing description.
const LINK_RE = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.+))?/gm;

const seen = new Set();
const docs = [];

let match;
while ((match = LINK_RE.exec(llmsTxt)) !== null) {
  const title = match[1].trim();
  const rawUrl = match[2].trim();
  const desc = match[3] ? match[3].trim() : '';

  // Skip external links
  if (/^https?:\/\//i.test(rawUrl) || /^mailto:/i.test(rawUrl)) {
    continue;
  }

  // Strip fragment
  const urlNoFragment = rawUrl.replace(/#.*$/, '');
  if (!urlNoFragment) continue;

  const resolvedPath = join(root, urlNoFragment);

  // Skip missing files silently
  if (!existsSync(resolvedPath)) {
    continue;
  }

  // De-duplicate by resolved path
  if (seen.has(resolvedPath)) continue;
  seen.add(resolvedPath);

  docs.push({ path: urlNoFragment, title, desc });
}

if (docs.length === 0) {
  console.error('ERROR: llms.txt contains zero usable local links');
  process.exit(1);
}

// --- Build llms-full.txt ---

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

const output = `<project title="${escapeXml(projectTitle)}" summary="${escapeXml(projectSummary)}">
  <docs>
${docBlocks.join('\n\n')}
  </docs>
</project>\n`;

const outPath = join(root, 'llms-full.txt');
writeFileSync(outPath, output, 'utf-8');
console.log(`Written: ${outPath} (${output.length} bytes, ${docs.length} docs)`);
