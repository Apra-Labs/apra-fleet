#!/usr/bin/env node
// pm e2e local runner.
//
// For each selected suite: clone the toy repo, render the scenario with the repo
// path and a unique branch, invoke the provider's CLI headless with the pm
// skill installed, then read checkpoints.json the orchestrator wrote and decide
// pass/fail. The sprint pushes to the toy and raises a real PR (no merge).
//
// Inspection: before tearing the PR down we capture its URL and commit list and
// print them into the job summary. A closed PR with a deleted branch still serves
// /pull/<n>/commits on GitHub, so a reviewer can always click through to see exactly
// how the sprint progressed -- even though teardown keeps the toy tidy.
//
// Telemetry: providers are invoked with stream-json output so token usage (in/out,
// cache) is captured per run and reported in the summary for cost-regression tracking.
//
// Usage:
//   node e2e/pm/run-e2e.mjs [--suite pm-s1,pm-s10] [--provider claude|gemini|agy|opencode] [--timeout 1800] [--keep-pr] [--keep-install]
//
// Selection: default is all suites. --suite accepts comma-separated IDs (e.g. pm-s1,pm-s10)
// and may be repeated. --provider filters by provider. The skill must be installed
// first (node install.mjs --llm <provider>).
//
// Teardown: after each suite this runner uninstalls pm for that suite's provider
// (node install.mjs --uninstall --llm <provider>) -- the skill, its agents, the
// auto-sprint workflow file, and the permissions install() added are all removed,
// so repeated e2e runs (and anything else on a shared/self-hosted runner) never
// accumulate stale pm state. Pass --keep-install to skip this, e.g. when debugging
// a failure locally and you want the installed skill left in place afterward.
//
// Auth: pushing the branch and opening the PR needs write access to the toy. Provide
// it via GH_TOKEN / E2E_GH_TOKEN (wired into the push URL and gh), or rely on the
// runner's ambient git + gh credentials.
//
// CLI flags vary by tool/version; override a provider's command with
//   E2E_CMD_CLAUDE="claude -p {PROMPT} --permission-mode acceptEdits"
// ({PROMPT} is substituted with the rendered scenario).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTelemetryFile, diagnoseFailure } from '../lib/extract-results.mjs';
import { validateSprint } from '../lib/validate-sprint.mjs';
import { postSummary } from '../lib/post-summary.mjs';

// One-release backcompat: prefer the E2E_* env var; fall back to the retired
// PMLITE_E2E_* name if the new one is unset, warning once per name so stragglers
// get flagged without spamming the log on every read.
const warnedEnvCompat = new Set();
function envCompat(newName, oldName) {
  if (process.env[newName] !== undefined) return process.env[newName];
  if (process.env[oldName] !== undefined) {
    if (!warnedEnvCompat.has(oldName)) {
      warnedEnvCompat.add(oldName);
      console.error(`[e2e] ${oldName} is deprecated -- use ${newName} instead`);
    }
    return process.env[oldName];
  }
  return undefined;
}

const E2E = path.dirname(fileURLToPath(import.meta.url));
// This runner lives at the repo-root e2e/pm/ tree. The apra-pm package (whose
// installer this drives for teardown) is NOT this dir's parent anymore, so point
// at it explicitly relative to the repo root (E2E/../..).
const PM_PKG_ROOT = path.join(E2E, '..', '..', 'packages', 'apra-fleet-se', 'apra-pm');
// Suite registry lives at the repo-root e2e/ tree (shared with the fleet harness).
// This runner drives the 'pm' namespace; cfg keeps the historical { toy, suites[] } shape.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(E2E, '..', 'suites.json'), 'utf-8'));
const cfg = REGISTRY.pm;

// Each suite may specify a custom scenario file via the "scenario" field.
// Falls back to the shared scenario.md when not set.
function scenarioFor(suite) {
  const file = suite.scenario || 'scenario.md';
  return fs.readFileSync(path.join(E2E, file), 'utf-8');
}

// Default headless command per provider. {PROMPT} is replaced with the scenario.
// The autonomy flags matter: without them the CLI stalls on permission/trust gates
// (e.g. when dispatching a subagent) and times out. stream-json output is what lets
// us account tokens. Override with E2E_CMD_<P>.
const CLI = {
  claude: ['claude', '-p', '{PROMPT}', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '--max-turns', '100'],
  gemini: ['gemini', '-p', '{PROMPT}', '--model', 'auto', '--skip-trust', '--output-format', 'stream-json'],
  // agy print mode defaults to a 5m wait; a full sprint is ~30m, so raise it. agy
  // emits no stream-json: its transcript is read from disk after exit (see runAgy).
  agy: ['agy', '--print-timeout=40m', '-p', '{PROMPT}', '--dangerously-skip-permissions'],
  // --variant minimal reduces reasoning effort so the model does not spend >2min
  // thinking between turns, which would exceed the upstream API idle timeout.
  opencode: ['opencode', 'run', '{PROMPT}', '--variant', 'minimal', '--format', 'json', '--dangerously-skip-permissions'],
};

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf-8' });
  return r.status === 0;
}

function parseArgs() {
  const a = { suites: [], provider: null, timeout: 5400, keepPr: false, keepInstall: false };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--suite') a.suites.push(...v[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (v[i] === '--provider') a.provider = v[++i];
    else if (v[i] === '--timeout') a.timeout = Number(v[++i]);
    else if (v[i] === '--keep-pr') a.keepPr = true;
    else if (v[i] === '--keep-install') a.keepInstall = true;
    else { console.error(`unknown arg "${v[i]}"`); process.exit(2); }
  }
  return a;
}

// owner/repo slug for gh commands, derived from the toy URL.
const OWNER_REPO = (cfg.toy.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1] || null;

function ghEnv(token) { return token ? { ...process.env, GH_TOKEN: token } : process.env; }

// LLM processes must not inherit write-access tokens on public runners -- the
// token is already embedded in the git remote URL before the sprint starts.
// Set E2E_TRUST_LLM=1 on self-hosted (private) runners where leakage
// is not a concern and the LLM may need the token for gh CLI calls.
function llmEnv() {
  const e = envCompat('E2E_TRUST_LLM', 'PMLITE_E2E_TRUST_LLM') === '1' ? { ...process.env } : (() => {
    const x = { ...process.env }; delete x.GH_TOKEN; delete x.E2E_GH_TOKEN; return x;
  })();
  // Workflows run as background tasks in Claude Code's print mode. Without this
  // the process exits after 600s leaving the workflow unfinished.
  e.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0';
  return e;
}

// Capture the PR raised for this branch BEFORE teardown: its URL, commit list, and
// the /commits permalink that survives branch deletion. Best effort.
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

// Close the e2e PR and delete its branch on the toy -- good housekeeping so repeated
// runs do not pile up on the shared public repo. The commits stay visible via the
// captured /pull/<n>/commits URL even after the branch is gone.
function teardownPr(branch, token) {
  if (!OWNER_REPO) return;
  const env = ghEnv(token);
  spawnSync('gh', ['pr', 'close', branch, '-R', OWNER_REPO, '--delete-branch'], { encoding: 'utf-8', env });
  // Drop the branch even if no PR was opened (failure before the pr step).
  spawnSync('gh', ['api', '-X', 'DELETE', `repos/${OWNER_REPO}/git/refs/heads/${branch}`], { encoding: 'utf-8', env });
}

// Uninstall pm for this suite's provider after the run -- skill, agents,
// auto-sprint workflow, and the permissions install() merged in. Runs
// install.mjs itself (rather than importing it) so this stays correct even
// if the installer's internals change. Best effort: a failure here should not
// fail the suite, since the run's own pass/fail was already decided by the
// validation gates above.
function teardownInstall(provider, repoRoot) {
  const r = spawnSync('node', ['install.mjs', '--uninstall', '--llm', provider], { cwd: repoRoot, encoding: 'utf-8' });
  if (r.status !== 0) {
    console.log(`[teardown] pm uninstall for ${provider} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  }
}

// Restore the toy's shared Dolt seed (refs/dolt/data) to golden at teardown, so the
// shared "issues without a database" state stays CONSTANT across runs. The committed
// .beads/issues.jsonl on the toy's main is the single source of truth (exactly the 8
// open issues the suites test, plus noise); we rebuild the Dolt DB from it and force-push.
// Running this every teardown (rather than on a schedule) means any drift -- a stray push,
// a bd version that ignored the init-time `dolt remote remove`, a manual mistake -- heals
// on the very next run. Best effort: never fail a suite over the seed heal.
// Opt out with E2E_NO_HEAL=1 (e.g. local debugging against a throwaway toy fork).
function healDoltSeed(token) {
  if (envCompat('E2E_NO_HEAL', 'PMLITE_E2E_NO_HEAL') === '1') { console.log('[heal-seed] E2E_NO_HEAL=1 -- skipping'); return; }
  if (!token || !OWNER_REPO) { console.log('[heal-seed] no token/OWNER_REPO -- skipping'); return; }
  let work;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'pmlite-e2e-heal-'));
    const repo = path.join(work, 'gold');
    // Fresh clone guarantees a PRISTINE .beads/issues.jsonl (the suite clone mutated its own
    // DB and committed closures to its branch, so its tree is not golden).
    const clone = git(['clone', cfg.toy, repo]);
    if (clone.status !== 0) { console.log(`[heal-seed] clone failed: ${(clone.stderr || '').trim().slice(0, 150)}`); return; }
    git(['-C', repo, 'config', 'user.email', 'e2e@pm']);
    git(['-C', repo, 'config', 'user.name', 'pm-e2e']);
    // CRITICAL: bd init adopts the Dolt seed from the git `origin` remote (NOT config.yaml).
    // Remove origin first so init builds an EMPTY embedded Dolt DB -- no pollution pulled in --
    // then import the committed clean JSONL to create all issues fresh (nothing "stale").
    git(['-C', repo, 'remote', 'remove', 'origin']);
    try { fs.rmSync(path.join(repo, '.beads', 'embeddeddolt'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(repo, '.beads', '.local_version'), { force: true }); } catch {}
    spawnSync('bd', ['init', '-p', 'gh-toy', '--non-interactive'], { cwd: repo, encoding: 'utf-8' });
    spawnSync('bd', ['import', '.beads/issues.jsonl'], { cwd: repo, encoding: 'utf-8' });
    // Guard: refuse to push unless the rebuilt seed is all-open and non-empty. This stops a
    // corrupt rebuild (e.g. a polluted JSONL) from being force-pushed over the good remote.
    const listed = spawnSync('bd', ['list', '--status', 'all', '--json'], { cwd: repo, encoding: 'utf-8' });
    let issues = [];
    try { const j = JSON.parse(listed.stdout); issues = j.issues || j; } catch { issues = []; }
    const openCount = issues.filter((i) => i.status !== 'closed').length;
    if (issues.length === 0 || openCount !== issues.length) {
      console.log(`[heal-seed] refusing to push -- rebuilt seed not all-open (total=${issues.length}, open=${openCount})`);
      return;
    }
    // Force-push the golden seed, overwriting refs/dolt/data. bd dolt (git-backed) shells to
    // git, so the token embeds in the remote URL just like the suite's git origin push.
    spawnSync('bd', ['dolt', 'remote', 'add', 'origin', `git+https://x-access-token:${token}@github.com/${OWNER_REPO}`], { cwd: repo, encoding: 'utf-8' });
    const push = spawnSync('bd', ['dolt', 'push', '--force', '--remote', 'origin'], { cwd: repo, encoding: 'utf-8' });
    if (push.status === 0) console.log(`[heal-seed] golden seed restored (${issues.length} open issues)`);
    else console.log(`[heal-seed] push failed (exit ${push.status}): ${((push.stderr || push.stdout) || '').trim().slice(0, 200)}`);
  } catch (e) {
    console.log(`[heal-seed] error: ${(e && e.message) || e}`);
  } finally {
    if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
  }
}

function selectSuites(a) {
  if (a.suites.length) return cfg.suites.filter((s) => a.suites.includes(s.id));
  let s = cfg.suites;
  if (a.provider) s = s.filter((x) => x.provider === a.provider);
  return s;
}

function commandFor(provider, prompt, model) {
  // E2E_MODEL overrides the suite's model -- easy to switch without editing suites.json.
  const effectiveModel = envCompat('E2E_MODEL', 'PMLITE_E2E_MODEL') || model;
  const override = envCompat(`E2E_CMD_${provider.toUpperCase()}`, `PMLITE_E2E_CMD_${provider.toUpperCase()}`);
  const tokens = override ? override.split(' ') : CLI[provider];
  const filled = tokens.map((t) => (t === '{PROMPT}' ? prompt : t));
  if (!override && effectiveModel && provider === 'opencode') {
    filled.splice(1, 0, '-m', effectiveModel);
  }
  return { bin: filled[0], args: filled.slice(1) };
}

function git(args, opts = {}) { return spawnSync('git', args, { encoding: 'utf-8', ...opts }); }

// opencode picks up the runner's global XDG_CONFIG_HOME which may have fleet MCP
// or other server entries. When the pm skill loads and sees dispatch tools it cannot
// use, opencode exits silently with 0 commits. Write a blank opencode.json into a
// temp config dir and point XDG_CONFIG_HOME there so opencode starts clean.
function opencodeEnv(workDir) {
  const cfgDir = path.join(workDir, '.config', 'opencode');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json' }) + '\n');
  return { ...llmEnv(), XDG_CONFIG_HOME: path.join(workDir, '.config') };
}

// agy writes its conversation to disk, not stdout. After it exits we look up the
// conversation id for the run cwd and dump its transcript.jsonl. Mirrors the proven
// fleet e2e approach.
const AGY_TRANSCRIPT_SCRIPT =
  "const fs=require('fs'),path=require('path');const home=process.env.USERPROFILE||process.env.HOME||'';" +
  "const cache=JSON.parse(fs.readFileSync(path.join(home,'.gemini','antigravity-cli','cache','last_conversations.json'),'utf8'));" +
  "const norm=p=>path.resolve(p).toLowerCase().split(path.sep).join('/');const target=norm(process.argv[1]);" +
  "let id='';for(const k of Object.keys(cache)){if(norm(k)===target){id=cache[k];break;}}" +
  "if(!id){process.stdout.write('E2E_TRANSCRIPT_MISSING:NO_CONV\\n');process.exit(0);}" +
  "const tp=path.join(home,'.gemini','antigravity-cli','brain',id,'.system_generated','logs','transcript.jsonl');" +
  "if(fs.existsSync(tp)){process.stdout.write('E2E_TRANSCRIPT_START\\n');process.stdout.write(fs.readFileSync(tp,'utf8'));process.stdout.write('\\nE2E_TRANSCRIPT_END\\n');}" +
  "else{process.stdout.write('E2E_TRANSCRIPT_MISSING:'+id+'\\n');}";

function appendAgyTranscript(cwd, logPath) {
  const r = spawnSync('node', ['-e', AGY_TRANSCRIPT_SCRIPT, cwd], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  fs.appendFileSync(logPath, `\n${r.stdout || ''}${r.stderr || ''}`);
}

// agy -p stops after each text response, so a full sprint needs resuming until the
// sprint is done. The terminal signal is the PR itself (cleanup raises it), checked
// via `isDone()`. Returns { timedOut }.
function runAgy(cmd, args, cwd, logPath, isDone, timeoutS) {
  const first = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024, env: llmEnv() });
  fs.writeFileSync(logPath, `${first.stdout || ''}\n---STDERR---\n${first.stderr || ''}`);
  appendAgyTranscript(cwd, logPath);
  if (first.error && first.error.code === 'ETIMEDOUT') return { timedOut: true };

  for (let i = 1; i <= 4; i++) {
    if (isDone()) break;
    console.log(`[agy] resume attempt ${i} -- no PR raised yet`);
    const cont = ['--print-timeout=40m', '--continue', '-p',
      'Continue the sprint from where you left off. Finish the pm start and cleanup commands without stopping, so a PR is raised.',
      '--dangerously-skip-permissions'];
    const r = spawnSync(cmd, cont, { cwd, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024, env: llmEnv() });
    fs.appendFileSync(logPath, `\n---RESUME ${i}---\n${r.stdout || ''}\n${r.stderr || ''}`);
    appendAgyTranscript(cwd, logPath);
    if (r.error && r.error.code === 'ETIMEDOUT') return { timedOut: true };
  }
  return { timedOut: false };
}

function runSuite(suite, timeoutS, keepPr, keepInstall) {
  const res = { id: suite.id, provider: suite.provider, status: '', notes: '', pr: null, telemetry: null, gates: null };
  res.os = process.platform;
  const { bin } = commandFor(suite.provider, '', suite.model);
  if (!which(bin)) { res.status = 'SKIP'; res.notes = `${bin} not found on PATH`; return res; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pmlite-e2e-${suite.id}-`));
  const repo = path.join(work, 'repo');
  const logPath = path.join(work, 'cli.log');

  const clone = git(['clone', cfg.toy, repo]);
  if (clone.status !== 0) { res.status = 'FAIL'; res.notes = `clone failed: ${(clone.stderr || '').trim().slice(0, 200)}`; return res; }
  git(['-C', repo, 'config', 'user.email', 'e2e@pm']);
  git(['-C', repo, 'config', 'user.name', 'pm-e2e']);

  // The toy repo commits .beads/embeddeddolt/ (Dolt DB created by a newer bd). Running
  // bd init on a runner with an older bd fails: "Error 1105: table has unknown fields".
  // Fix: delete the committed Dolt DB first so bd init creates a fresh one at its own
  // schema version. Also delete .local_version so bd doesn't try to forward-migrate.
  const beadsDir = path.join(repo, '.beads');
  try { fs.rmSync(path.join(beadsDir, 'embeddeddolt'), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(beadsDir, '.local_version'), { force: true }); } catch {}
  // beads needs issue_prefix set before the model can run bd commands.
  // The toy repo commits .beads/issues.jsonl but not git config, so initialize
  // here with the toy's prefix so `bd ready` and `bd list` work out of the box.
  spawnSync('bd', ['init', '-p', 'gh-toy', '--non-interactive'], { cwd: repo, encoding: 'utf-8' });

  // bd init ADOPTS the shared Dolt seed from the toy's refs/dolt/data (the "issues shared
  // between team members without a database" model) -- that's the intended read path. But bd
  // then AUTO-PUSHES every bd close/create back to that remote (only `bd close --sandbox`
  // disables it), which would drift the shared seed and, because the next run re-adopts it,
  // silently corrupt subsequent runs. This ephemeral clone must be read-only against the
  // shared Dolt remote: remove the adopted Dolt remote so nothing can push to it. The sprint
  // still mutates its LOCAL Dolt DB and exports to the branch's .beads/issues.jsonl (which the
  // closure gates read); the toy's main config keeps sync.remote so future clones still adopt.
  // Defense in depth: this prevents drift DURING the run; healDoltSeed() at teardown then
  // force-restores the shared seed to golden, so any drift that slips through heals next run.
  spawnSync('bd', ['dolt', 'remote', 'remove', 'origin'], { cwd: repo, encoding: 'utf-8' });

  // The sprint pushes and raises a PR, so keep origin. If a token is provided, wire
  // it into the push URL (gh reads GH_TOKEN from the environment on its own).
  const token = process.env.GH_TOKEN || process.env.E2E_GH_TOKEN || '';
  if (token && OWNER_REPO) {
    git(['-C', repo, 'remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${OWNER_REPO}.git`]);
  }

  const branch = `pmlite-e2e/${suite.id}-${Date.now()}`;
  const prompt = scenarioFor(suite)
    .replaceAll('{{REPO}}', repo.replace(/\\/g, '/'))
    .replaceAll('{{BRANCH}}', branch);
  const { bin: cmd, args } = commandFor(suite.provider, prompt, suite.model);

  console.log(`[${suite.id}] ${cmd} (cwd ${repo}, branch ${branch}) ...`);
  let timedOut = false;
  if (suite.provider === 'agy') {
    ({ timedOut } = runAgy(cmd, args, repo, logPath, () => !!capturePr(branch, token), timeoutS));
  } else {
    const env = suite.provider === 'opencode' ? opencodeEnv(work) : llmEnv();
    const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024, env });
    const meta = `\n---META--- exit=${r.status} signal=${r.signal} error=${r.error ? r.error.code : 'none'}\n`;
    fs.writeFileSync(logPath, `${r.stdout || ''}\n---STDERR---\n${r.stderr || ''}${meta}`);
    timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  }

  res.branch = branch;
  res.work = work;
  res.telemetry = parseTelemetryFile(logPath, suite.provider);

  // Capture the PR (URL + commits) and run the independent validation gates BEFORE
  // teardown, while the branch still exists on origin. The gates -- not any
  // self-reported checkpoint -- are the sole arbiter of success.
  res.pr = capturePr(branch, token);
  const v = validateSprint({ repo, branch, pr: res.pr, minCommits: suite.minCommits, expectedIssues: suite.expectedIssues, excludeGates: suite.excludeGates, expectArgsSkill: suite.expectArgsSkill, logPath, provider: suite.provider });
  res.gates = v.gates;

  if (v.pass) {
    res.status = 'PASS';
    res.notes = 'all validation gates passed';
  } else {
    const failed = res.gates.filter((g) => !g.pass).map((g) => g.name);
    if (timedOut) {
      res.status = 'INCOMPLETE';
      res.notes = `timed out after ${timeoutS}s; partial gates failed: ${failed.join(', ')}`;
      if (!res.pr) res.notes += `; ${diagnoseFailure(logPath)}`.replace(/; $/, '');
    } else {
      res.status = 'FAIL';
      res.notes = `gates failed: ${failed.join(', ')}`;
    }
  }

  if (!keepPr) teardownPr(branch, token);
  if (!keepInstall) teardownInstall(suite.provider, PM_PKG_ROOT);
  // Always heal the shared Dolt seed back to golden as part of teardown (all suites).
  healDoltSeed(token);
  return res;
}

async function main() {
  const a = parseArgs();
  const suites = selectSuites(a);
  if (!suites.length) { console.error('no suites match the given filters'); process.exit(2); }

  const results = [];
  for (const s of suites) {
    const r = runSuite(s, a.timeout, a.keepPr, a.keepInstall);
    console.log(`[${r.id}] ${r.status} -- ${r.notes}`);
    if (r.pr) console.log(`[${r.id}] commits: ${r.pr.commitsUrl}`);
    results.push(r);
  }

  const outDir = path.join(E2E, 'e2e-results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results }, null, 2) + '\n');

  for (const r of results) {
    const src = r.work && path.join(r.work, 'cli.log');
    if (src && fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(outDir, `${r.id}-cli.log`)); } catch { /* non-fatal */ }
    }
  }

  postSummary(results);
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main();
