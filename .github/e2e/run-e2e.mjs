#!/usr/bin/env node
/**
 * Fleet E2E local runner — cross-platform (Windows/Linux/macOS).
 *
 * Usage:
 *   node .github/e2e/run-e2e.mjs <suite>                 # full run (build + install + test)
 *   node .github/e2e/run-e2e.mjs <suite> --install-only  # build + install, then exit (provision auth next)
 *   node .github/e2e/run-e2e.mjs <suite> --skip-install  # skip build/install, go straight to auth check + test
 *
 * Run from the apra-fleet repo root.
 */
import {
  readFileSync, mkdirSync, existsSync, writeFileSync, copyFileSync, readdirSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:process';

const isWindows = platform === 'win32';
const REPO_DIR  = join(fileURLToPath(import.meta.url), '../../..');
const E2E_DIR   = join(REPO_DIR, '.github/e2e');
const RUN_ID    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR   = join(REPO_DIR, '..', 'testRuns', RUN_ID);

// ── Args ───────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const SUITE        = args.find(a => !a.startsWith('--')) || 's1';
const INSTALL_ONLY = args.includes('--install-only');
const SKIP_INSTALL = args.includes('--skip-install');

if (INSTALL_ONLY && SKIP_INSTALL) {
  console.error('ERROR: --install-only and --skip-install are mutually exclusive.');
  process.exit(1);
}

mkdirSync(join(OUT_DIR, 'logs'), { recursive: true });

// ── Helpers ────────────────────────────────────────────────────────────────

function run(cmd, args = [], opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWindows, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} exited ${r.status}`);
  return r;
}

function capture(cmd, args = []) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: isWindows });
  return (r.stdout || '').trim();
}

// Resolve a binary from PATH without a shell — needed for LLM tools on Windows
// because shell:true routes through cmd.exe which mangles multi-word args.
function findExe(name) {
  const exts = isWindows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(isWindows ? ';' : ':')) {
    for (const ext of exts) {
      const p = join(dir.trim(), name + ext);
      if (existsSync(p)) return p;
    }
  }
  return name;
}

// ── Result extraction (replaces extract-fleet-log-path.py) ─────────────────

/**
 * Scan a Claude stream-json file for the fleet log path.
 * fleet_status tool results embed it as JSON { logFile: "..." }
 * or as text "log=<path>".
 */
function extractFleetLogPath(rawOutputPath) {
  if (!existsSync(rawOutputPath)) return null;
  const content = readFileSync(rawOutputPath, 'utf8');
  let best = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj.type !== 'user') continue;
    for (const block of obj.message?.content ?? []) {
      if (!block || block.type !== 'tool_result') continue;
      for (const c of block.content ?? []) {
        if (!c || c.type !== 'text') continue;
        // Try structured JSON
        try {
          const d = JSON.parse(c.text);
          if (d.logFile) { best = d.logFile; continue; }
        } catch {}
        // Try text format: log=<path>
        const m = c.text.match(/\blog=([^\s|]+\.log)/);
        if (m) best = m[1];
      }
    }
  }
  return best;
}

// ── Results extraction (replaces extract-results.py) ───────────────────────

/**
 * Build the results report from a Claude Code stream-json output file.
 * The PM emits CHECKPOINT lines after each test; this assembles the report.
 */
function extractResults(rawOutputPath, suite, pmOs, pmProvider) {
  if (!existsSync(rawOutputPath)) {
    return { overall: 'FAIL', error: 'raw-output.txt not found' };
  }

  const content = readFileSync(rawOutputPath, 'utf8');
  const allTexts = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj.type === 'result' && obj.result) {
      allTexts.push(obj.result);
    } else if (obj.type === 'assistant') {
      for (const block of obj.message?.content ?? []) {
        if (block?.type === 'text' && block.text) allTexts.push(block.text);
      }
    }
  }

  // Find last CHECKPOINT array across all text blocks
  let checkpoints = null;
  for (const text of allTexts) {
    for (const line of text.split('\n')) {
      if (line.startsWith('CHECKPOINT: ')) {
        try {
          const cp = JSON.parse(line.slice('CHECKPOINT: '.length));
          checkpoints = cp;
        } catch {}
      }
    }
  }

  const results = checkpoints ?? [];
  const overall = results.length === 0 || results.some(t => t.status === 'FAIL') ? 'FAIL' : 'PASS';

  return {
    run: {
      suite,
      pm_os:       pmOs,
      pm_provider: pmProvider,
      timestamp:   new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    },
    results,
    overall,
  };
}

// ── Load config ────────────────────────────────────────────────────────────

const config  = JSON.parse(readFileSync(join(E2E_DIR, 'suites.json'),  'utf8'));
const members = JSON.parse(readFileSync(join(E2E_DIR, 'members.json'), 'utf8'));

const s = config.suites[SUITE];
if (!s) {
  console.error(`ERROR: unknown suite "${SUITE}". Available: ${Object.keys(config.suites).join(', ')}`);
  process.exit(1);
}

const PM_PROVIDER = s.pm.provider;
const PM_OS       = s.pm.os;
const DOER_OS     = s.doer.os;
const DOER_PROV   = s.doer.provider;
const REV_OS      = s.reviewer.os;
const REV_PROV    = s.reviewer.provider;
const VCS         = s.vcs;

const DOER_HOST   = members[DOER_OS].host;
const DOER_FOLDER = members[DOER_OS].work_folder;
const REV_HOST    = members[REV_OS].host;
const REV_FOLDER  = members[REV_OS].work_folder;
const TOY_URL     = members.toy_projects[VCS];

const BRANCH_PREFIX = `e2e-${SUITE}-${RUN_ID}`;

const modeLabel = INSTALL_ONLY ? ' [install-only]' : SKIP_INSTALL ? ' [skip-install]' : '';
console.log(`Suite: ${SUITE} | PM: ${PM_OS}/${PM_PROVIDER} | Run: ${RUN_ID}${modeLabel}`);

// ── Phase 1: Build + install fleet binary ──────────────────────────────────

if (!SKIP_INSTALL) {
  console.log('\n--- Building fleet binary ---');
  run('npm', ['ci', '--silent']);
  run('npm', ['run', 'build:binary', '--silent']);

  const BIN = readdirSync(join(REPO_DIR, 'dist')).find(f =>
    isWindows
      ? f.startsWith('apra-fleet-installer-') && f.endsWith('.exe')
      : f.startsWith('apra-fleet-installer-') && !/\.(blob|cjs|json|exe)$/.test(f)
  );
  if (!BIN) throw new Error('Fleet installer binary not found in dist/');

  run(join(REPO_DIR, 'dist', BIN), ['install', '--force']);

  const HOME_DIR  = process.env.USERPROFILE || process.env.HOME || '';
  const FLEET_BIN = join(HOME_DIR, '.apra-fleet/bin', isWindows ? 'apra-fleet.exe' : 'apra-fleet');
  console.log(`Fleet: ${capture(FLEET_BIN, ['--version'])}`);

  if (INSTALL_ONLY) {
    console.log('\n--- Fleet installed successfully ---');
    console.log('Next step: provision LLM auth on this member, then run:');
    console.log(`  node .github/e2e/run-e2e.mjs ${SUITE} --skip-install`);
    process.exit(0);
  }
}

// ── Phase 2: Verify PM LLM auth ───────────────────────────────────────────

console.log('\n--- Verifying PM LLM auth ---');
if (PM_PROVIDER === 'claude') {
  const claudeExe = findExe('claude');
  const r = spawnSync(claudeExe, ['-p', 'hello are you ready', '--model', 'claude-haiku-4-5', '--max-turns', '1'],
    { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  if (r.status !== 0 || !/ready/i.test(out)) {
    console.error(`\nERROR: PM claude auth failed (exit=${r.status}).`);
    console.error('Run provision_llm_auth on this member, then retry:');
    console.error(`  node .github/e2e/run-e2e.mjs ${SUITE} --skip-install`);
    process.exit(1);
  }
}
console.log('PM auth OK');

// ── Render test script ─────────────────────────────────────────────────────

console.log('\n--- Rendering test script ---');
const rendered = readFileSync(join(E2E_DIR, 'test-script.md'), 'utf8')
  .replaceAll('{{SUITE_ID}}',          SUITE)
  .replaceAll('{{PM_OS}}',             PM_OS)
  .replaceAll('{{PM_PROVIDER}}',       PM_PROVIDER)
  .replaceAll('{{DOER_HOST}}',         DOER_HOST)
  .replaceAll('{{DOER_OS}}',           DOER_OS)
  .replaceAll('{{DOER_PROVIDER}}',     DOER_PROV)
  .replaceAll('{{REVIEWER_HOST}}',     REV_HOST)
  .replaceAll('{{REVIEWER_OS}}',       REV_OS)
  .replaceAll('{{REVIEWER_PROVIDER}}', REV_PROV)
  .replaceAll('{{TOY_PROJECT_URL}}',   TOY_URL)
  .replaceAll('{{VCS}}',               VCS)
  .replaceAll('{{BRANCH_PREFIX}}',     BRANCH_PREFIX)
  .replaceAll('{{DOER_FOLDER}}',       DOER_FOLDER)
  .replaceAll('{{REVIEWER_FOLDER}}',   REV_FOLDER);

const RENDERED_SCRIPT = join(OUT_DIR, 'rendered-test-script.md');
writeFileSync(RENDERED_SCRIPT, rendered);

// ── Run LLM test (T1–T5) ──────────────────────────────────────────────────

console.log('\n--- Running E2E (T1–T5) ---');
const RAW_OUTPUT = join(OUT_DIR, 'raw-output.txt');
const llmExe     = findExe(PM_PROVIDER === 'claude' ? 'claude' : 'gemini');
const llmArgs    = PM_PROVIDER === 'claude'
  ? ['-p', rendered, '--output-format', 'stream-json', '--verbose', '--max-turns', '80']
  : ['--output-format', 'stream-json', '-p', rendered];

const llm = spawnSync(llmExe, llmArgs,
  { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
writeFileSync(RAW_OUTPUT, (llm.stdout || '') + (llm.stderr || ''));

// ── Collect fleet log ──────────────────────────────────────────────────────

const fleetLogPath = extractFleetLogPath(RAW_OUTPUT);
if (fleetLogPath && existsSync(fleetLogPath)) {
  copyFileSync(fleetLogPath, join(OUT_DIR, 'logs/fleet-pm.log'));
  console.log(`Fleet log: ${fleetLogPath}`);
} else {
  console.warn(`WARNING: fleet log not found at '${fleetLogPath}'`);
}

// ── Extract results ────────────────────────────────────────────────────────

const report = extractResults(RAW_OUTPUT, SUITE, PM_OS, PM_PROVIDER);
writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(report, null, 2));

// ── Telemetry ──────────────────────────────────────────────────────────────

spawnSync('node', [join(E2E_DIR, 'extract-telemetry.js')],
  { cwd: OUT_DIR, stdio: 'inherit', shell: isWindows });

// ── T6 teardown ────────────────────────────────────────────────────────────

console.log('\n--- T6 teardown ---');
const t6Prompt = readFileSync(join(E2E_DIR, 't6-teardown.md'), 'utf8');
const t6Exe    = findExe(PM_PROVIDER === 'claude' ? 'claude' : 'gemini');
const t6Args   = PM_PROVIDER === 'claude'
  ? ['-p', t6Prompt, '--max-turns', '15']
  : ['-p', t6Prompt];
const t6 = spawnSync(t6Exe, t6Args,
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const t6Out = (t6.stdout || '') + (t6.stderr || '');
writeFileSync(join(OUT_DIR, 't6-output.txt'), t6Out);
console.log(t6Out.split('\n').slice(-3).join('\n'));

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n=== Results ===');
console.log(`Overall: ${report.overall}`);
for (const t of report.results || [])
  console.log(`  ${t.test}: ${t.status}${t.notes ? ' — ' + t.notes : ''}`);
console.log(`\nArtifacts: ${OUT_DIR}`);
