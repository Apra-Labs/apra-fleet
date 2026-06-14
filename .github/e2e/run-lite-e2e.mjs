#!/usr/bin/env node
// Fleet-less (lite) e2e runner.
//
// Reads lite-suites.json, clones the toy repo, renders local-sprint-script.md,
// runs the provider CLI headless (no fleet server, local subagents only), then
// validates the sprint via the shared validate-sprint.mjs gates.
//
// Usage: node .github/e2e/run-lite-e2e.mjs <suite-id>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSprint } from './validate-sprint.mjs';

const E2E = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(E2E, 'lite-suites.json'), 'utf-8'));
const scriptTpl = fs.readFileSync(path.join(E2E, 'local-sprint-script.md'), 'utf-8');

const OWNER_REPO = (cfg.toy.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1] || null;

function ghEnv(token) { return token ? { ...process.env, GH_TOKEN: token } : process.env; }

function git(args, opts = {}) { return spawnSync('git', args, { encoding: 'utf-8', ...opts }); }

function capturePr(branch, token) {
  if (!OWNER_REPO) return null;
  const r = spawnSync('gh', ['pr', 'view', branch, '-R', OWNER_REPO, '--json', 'url,number,state,commits'],
    { encoding: 'utf-8', env: ghEnv(token) });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const j = JSON.parse(r.stdout);
    if (!j.url) return null;
    return {
      number: j.number,
      url: j.url,
      state: j.state,
      commitsUrl: `${j.url}/commits`,
      commits: (j.commits || []).map((c) => ({
        sha: String(c.oid || '').slice(0, 7),
        msg: c.messageHeadline || '',
        author: (c.authors && c.authors[0] && (c.authors[0].name || c.authors[0].login)) || '',
      })),
    };
  } catch { return null; }
}

function teardownPr(branch, token) {
  if (!OWNER_REPO) return;
  const env = ghEnv(token);
  spawnSync('gh', ['pr', 'close', branch, '-R', OWNER_REPO, '--delete-branch'], { encoding: 'utf-8', env });
  spawnSync('gh', ['api', '-X', 'DELETE', `repos/${OWNER_REPO}/git/refs/heads/${branch}`], { encoding: 'utf-8', env });
}

function main() {
  const suiteId = process.argv[2];
  if (!suiteId) { console.error('Usage: run-lite-e2e.mjs <suite-id>'); process.exit(2); }

  const suite = cfg.suites.find((s) => s.id === suiteId);
  if (!suite) { console.error(`suite "${suiteId}" not found in lite-suites.json`); process.exit(2); }

  const token = process.env.GH_TOKEN || process.env.E2E_GH_TOKEN || '';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-lite-e2e-${suite.id}-`));
  const repo = path.join(work, 'repo');
  const logPath = path.join(work, 'cli.log');

  const clone = git(['clone', cfg.toy, repo]);
  if (clone.status !== 0) { console.error(`clone failed: ${(clone.stderr || '').trim()}`); process.exit(1); }
  git(['-C', repo, 'config', 'user.email', 'e2e@pm']);
  git(['-C', repo, 'config', 'user.name', 'pm-e2e']);

  if (token && OWNER_REPO) {
    git(['-C', repo, 'remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${OWNER_REPO}.git`]);
  }

  const branch = `fleet-lite-e2e/${suite.id}-${process.pid}`;
  const prompt = scriptTpl
    .replaceAll('{{REPO}}', repo.replace(/\\/g, '/'))
    .replaceAll('{{BRANCH}}', branch)
    .replaceAll('{{TOY_PROJECT_URL}}', cfg.toy)
    .replaceAll('{{VCS}}', 'github');

  let cmd, args;
  if (suite.provider === 'claude') {
    cmd = 'claude';
    args = ['-p', prompt, '--model', 'sonnet', '--output-format', 'stream-json',
      '--verbose', '--max-turns', '80', '--add-dir', repo];
  } else if (suite.provider === 'opencode') {
    cmd = 'opencode';
    args = ['run', prompt, '--format', 'json', '--dangerously-skip-permissions'];
  } else if (suite.provider === 'agy') {
    // agy on Windows may write transcript to CONOUT$ (stdout empty); Linux/macOS -p prints normally
    cmd = 'agy';
    args = ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', '45m', '--add-dir', repo];
  } else {
    console.error(`unsupported provider: ${suite.provider}`);
    process.exit(2);
  }

  console.log(`[${suite.id}] ${cmd} (cwd ${work}, branch ${branch}) ...`);
  const r = spawnSync(cmd, args, {
    cwd: work,
    encoding: 'utf-8',
    timeout: 2700 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(logPath, `${r.stdout || ''}\n---STDERR---\n${r.stderr || ''}`);
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');

  const pr = capturePr(branch, token);
  const v = validateSprint({
    repo,
    branch,
    pr,
    minCommits: suite.minCommits || 4,
    expectedIssues: suite.expectedIssues || 3,
  });

  for (const g of v.gates) {
    console.log(`  ${g.pass ? 'PASS' : 'FAIL'} ${g.name}: ${g.detail}`);
  }

  if (v.pass) {
    console.log(`[${suite.id}] PASS -- all validation gates passed`);
  } else {
    const failed = v.gates.filter((g) => !g.pass).map((g) => g.name);
    const why = timedOut ? `timed out; ` : '';
    console.log(`[${suite.id}] FAIL -- ${why}gates failed: ${failed.join(', ')}`);
  }

  if (pr) console.log(`[${suite.id}] commits: ${pr.commitsUrl}`);

  teardownPr(branch, token);

  const outDir = path.join(work, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ suite: suite.id, gates: v.gates, pass: v.pass, pr }, null, 2) + '\n');

  if (fs.existsSync(logPath)) {
    try { fs.copyFileSync(logPath, path.join(outDir, `${suite.id}-cli.log`)); } catch { /* non-fatal */ }
  }

  process.exit(v.pass ? 0 : 1);
}

main();
