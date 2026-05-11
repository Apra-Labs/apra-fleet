#!/usr/bin/env node
/**
 * Fleet E2E local runner — cross-platform (Windows/Linux/macOS).
 * Usage: node .github/e2e/run-e2e.mjs <suite>
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
const OUT_DIR   = join(REPO_DIR, 'e2e-out');
const SUITE     = process.argv[2] || 's1';

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

function py(args) {
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, args, { encoding: 'utf8', shell: isWindows });
    if (r.status === 0) return r.stdout || '';
  }
  return null;
}

// dotted-path lookup into a plain object
function get(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj) ?? '';
}

// ── Load config ────────────────────────────────────────────────────────────

const config  = JSON.parse(readFileSync(join(E2E_DIR, 'suites.json'),  'utf8'));
const members = JSON.parse(readFileSync(join(E2E_DIR, 'members.json'), 'utf8'));

const s = config.suites[SUITE];
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

const RUN_ID        = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BRANCH_PREFIX = `e2e-${SUITE}-${RUN_ID}`;

console.log(`Suite: ${SUITE} | PM: ${PM_OS}/${PM_PROVIDER} | Run: ${RUN_ID}`);

// ── Build + install fleet binary ───────────────────────────────────────────

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

// ── Smoke-test PM LLM auth ─────────────────────────────────────────────────

console.log('\n--- Verifying PM LLM auth ---');
if (PM_PROVIDER === 'claude') {
  // On Windows, shell:true joins args via cmd.exe — colons and spaces must be
  // quoted inside the arg string, not by spawnSync.
  const probeArgs = ['-p', 'hello are you ready', '--model', 'claude-haiku-4-5', '--max-turns', '1'];
  const r = spawnSync('claude', probeArgs, { encoding: 'utf8', shell: isWindows });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  if (r.status !== 0 || !/ready/i.test(out)) {
    console.error(`ERROR: PM claude auth failed (exit=${r.status}) — run provision_llm_auth on this member first.`);
    process.exit(1);
  }
}
console.log('PM auth OK');

// ── MCP config ────────────────────────────────────────────────────────────

writeFileSync(
  join(REPO_DIR, 'mcp-runtime.json'),
  JSON.stringify({ mcpServers: { 'apra-fleet': { command: FLEET_BIN, args: ['mcp'] } } }, null, 2)
);

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
const [llmCmd, llmArgs] = PM_PROVIDER === 'claude'
  ? ['claude', ['-p', rendered, '--mcp-config', 'mcp-runtime.json',
                '--output-format', 'stream-json', '--verbose', '--max-turns', '80']]
  : ['gemini', ['--output-format', 'stream-json', '--mcp-config', 'mcp-runtime.json', '-p', rendered]];

const llm = spawnSync(llmCmd, llmArgs,
  { encoding: 'utf8', shell: isWindows, maxBuffer: 200 * 1024 * 1024 });
writeFileSync(RAW_OUTPUT, (llm.stdout || '') + (llm.stderr || ''));

// ── Collect fleet log ──────────────────────────────────────────────────────

const fleetLogPath = (py([join(E2E_DIR, 'extract-fleet-log-path.py'), RAW_OUTPUT]) || '').trim();
if (fleetLogPath && existsSync(fleetLogPath)) {
  copyFileSync(fleetLogPath, join(OUT_DIR, 'logs/fleet-pm.log'));
  console.log(`Fleet log: ${fleetLogPath}`);
} else {
  console.warn(`WARNING: fleet log not found at '${fleetLogPath}'`);
}

// ── Extract results ────────────────────────────────────────────────────────

const resultsJson = py([join(E2E_DIR, 'extract-results.py'), RAW_OUTPUT, SUITE, PM_OS, PM_PROVIDER]);
writeFileSync(join(OUT_DIR, 'results.json'),
  resultsJson || JSON.stringify({ overall: 'FAIL', error: 'extract-results.py failed' }));

// ── Telemetry ──────────────────────────────────────────────────────────────

spawnSync('node', [join(E2E_DIR, 'extract-telemetry.js')],
  { cwd: OUT_DIR, stdio: 'inherit', shell: isWindows });

// ── T6 teardown ────────────────────────────────────────────────────────────

console.log('\n--- T6 teardown ---');
const t6Prompt = readFileSync(join(E2E_DIR, 't6-teardown.md'), 'utf8');
const [t6Cmd, t6Args] = PM_PROVIDER === 'claude'
  ? ['claude', ['-p', t6Prompt, '--mcp-config', 'mcp-runtime.json', '--max-turns', '15']]
  : ['gemini', ['--mcp-config', 'mcp-runtime.json', '-p', t6Prompt]];
const t6 = spawnSync(t6Cmd, t6Args,
  { encoding: 'utf8', shell: isWindows, maxBuffer: 10 * 1024 * 1024 });
const t6Out = (t6.stdout || '') + (t6.stderr || '');
writeFileSync(join(OUT_DIR, 't6-output.txt'), t6Out);
console.log(t6Out.split('\n').slice(-3).join('\n'));

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n=== Results ===');
try {
  const results = JSON.parse(readFileSync(join(OUT_DIR, 'results.json'), 'utf8'));
  console.log(`Overall: ${results.overall}`);
  for (const t of results.results || [])
    console.log(`  ${t.test}: ${t.status}${t.notes ? ' — ' + t.notes : ''}`);
} catch { console.log('(could not parse results.json)'); }
console.log(`\nArtifacts: ${OUT_DIR}`);
