#!/usr/bin/env node
/**
 * sync-agent-docs.mjs -- generates AGENTS.md and AGY.md from CLAUDE.md.
 *
 * CLAUDE.md is the single source of truth for the shared instructions
 * (Dev commands, Conventions, DeepWiki, the Beads block, etc). AGENTS.md and
 * AGY.md are mechanically regenerated from it, each with its own title line
 * and a small tool-specific appendix (Codex beads setup for AGENTS.md,
 * Antigravity's non-interactive keep-alive rule for AGY.md) appended from
 * scripts/agent-doc-partials/. This replaces hand-maintained "keep these in
 * sync" discipline with a deterministic script -- edit CLAUDE.md, then run
 * `node scripts/sync-agent-docs.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const partialsDir = join(__dirname, 'agent-doc-partials');

const SOURCE = join(root, 'CLAUDE.md');

const TARGETS = [
  {
    file: join(root, 'AGENTS.md'),
    title: '# Apra Fleet - Agent Context',
    appendix: join(partialsDir, 'AGENTS.appendix.md'),
  },
  {
    file: join(root, 'AGY.md'),
    title: '# Apra Fleet - Antigravity (agy) Context',
    appendix: join(partialsDir, 'AGY.appendix.md'),
  },
];

const GENERATED_NOTE =
  '<!-- Generated from CLAUDE.md by `node scripts/sync-agent-docs.mjs` -- ' +
  'do not hand-edit the shared sections below (the tool-specific appendix ' +
  'at the end of this file is exempt). Edit CLAUDE.md and rerun the script. -->';

function readClaudeBody() {
  const raw = readFileSync(SOURCE, 'utf-8');
  const lines = raw.split('\n');
  if (!lines[0].startsWith('# ')) {
    throw new Error(`${SOURCE}: expected the first line to be a "# " title, got: ${lines[0]}`);
  }
  // Drop the source's own title line; the rest is the shared body every
  // target reuses verbatim under its own title. Content between
  // SYNC-SOURCE-ONLY markers (e.g. the "this file is generated from..."
  // note, which only makes sense in CLAUDE.md itself) is stripped.
  const body = lines.slice(1).join('\n');
  return body
    .replace(/<!-- SYNC-SOURCE-ONLY:START -->[\s\S]*?<!-- SYNC-SOURCE-ONLY:END -->\n*/g, '')
    .replace(/^\n+/, '');
}

function main() {
  const body = readClaudeBody();

  for (const target of TARGETS) {
    const appendix = readFileSync(target.appendix, 'utf-8').replace(/\n+$/, '');
    const out = [target.title, '', GENERATED_NOTE, '', body.replace(/\n+$/, ''), '', appendix, ''].join(
      '\n',
    );
    writeFileSync(target.file, out, 'utf-8');
    console.log(`Wrote ${target.file}`);
  }
}

main();
