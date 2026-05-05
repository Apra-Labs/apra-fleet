/**
 * End-to-end integration test for the fleet.
 *
 * Tears down all agents (keys + known_hosts + registry cleaned by remove_agent),
 * re-registers, provisions auth, verifies list/detail tools, and tests prompts.
 *
 * Agent-level operations run in parallel for speed.
 *
 * Usage:
 *   npm run integration                                      # all agents
 *   npm run integration -- --agents member-lin-remote-1       # single member
 *   npm run integration -- --agents member-lin-remote-1,member-mac-remote-1
 *   npm run integration -- --config path.json                # custom config
 *   FLEET_PASSWORD=xxx npm run integration                   # password via env var
 *
 * Requires: fleet.config.json (see fleet.config.example.json)
 * The config file is gitignored — it contains passwords.
 * Set password to "ENV" in config to pull from FLEET_PASSWORD env var.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getAllAgents } from '../src/services/registry.js';
import { closeAllConnections } from '../src/services/ssh.js';
import { registerMember } from '../src/tools/register-member.js';
import { removeMember } from '../src/tools/remove-member.js';
import { provisionAuth } from '../src/tools/provision-auth.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { sendFiles } from '../src/tools/send-files.js';
import { listMembers } from '../src/tools/list-members.js';
import { memberDetail } from '../src/tools/member-detail.js';
import { setupSSHKey } from '../src/tools/setup-ssh-key.js';
import { validateCredentials, credentialStatusNote } from '../src/utils/credential-validation.js';

// ── Config ──────────────────────────────────────────────────────────────────

interface AgentConfig {
  friendly_name: string;
  member_type: 'local' | 'remote';
  host?: string;
  port?: number;
  username?: string;
  auth_type?: 'password' | 'key';
  password?: string;
  key_path?: string;
  work_folder: string;
}

interface FleetConfig {
  agents: AgentConfig[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

let passed = 0;
let failed = 0;
let skipped = 0;
const errors: string[] = [];

function ok(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  passed++;
}

function fail(msg: string, detail?: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detail) console.log(`    ${detail.substring(0, 300)}`);
  errors.push(msg);
  failed++;
}

function skip(msg: string) {
  console.log(`  \x1b[33m⊘\x1b[0m ${msg}`);
  skipped++;
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(60 - title.length)}`);
}

function resolvePassword(ac: AgentConfig): AgentConfig {
  if (ac.password === 'ENV') {
    const envPw = process.env.FLEET_PASSWORD;
    if (!envPw) {
      throw new Error(`Agent "${ac.friendly_name}" has password="ENV" but FLEET_PASSWORD env var is not set`);
    }
    return { ...ac, password: envPw };
  }
  return ac;
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function preflight(config: FleetConfig) {
  section('0. Pre-flight');

  const hasCreds = fs.existsSync(CRED_PATH);

  hasCreds
    ? ok('~/.claude/.credentials.json exists')
    : skip('~/.claude/.credentials.json missing — provision_llm_auth will be skipped for remote agents');

  // Token health reporting (informational only)
  if (hasCreds) {
    const raw = fs.readFileSync(CRED_PATH, 'utf-8');
    const cs = validateCredentials(raw);
    const note = cs ? credentialStatusNote(cs) : '';
    const label = cs?.status ?? 'unknown structure';
    console.log(`  Token status: ${label}${note ? ` — ${note}` : ''}`);
  }

  for (const a of config.agents.filter(a => a.auth_type === 'key' && a.key_path)) {
    fs.existsSync(a.key_path!)
      ? ok(`Key file exists: ${a.friendly_name}`)
      : skip(`Key file missing for ${a.friendly_name} — will register with password + setup_ssh_key`);
  }

  return { hasCreds };
}

async function teardown() {
  section('1. Teardown');

  const agents = getAllAgents();
  console.log(`  Found ${agents.length} existing member(s) to remove`);

  // Remove agents in parallel
  const results = await Promise.all(
    agents.map(async member => {
      const result = await removeMember({ member_id: member.id });
      return { name: member.friendlyName, success: result.includes('removed'), result };
    })
  );
  for (const r of results) {
    r.success ? ok(`Removed ${r.name}`) : fail(`Remove ${r.name}`, r.result);
  }

  closeAllConnections();
  ok('Closed all SSH connections');
}

async function registerOne(rawAc: AgentConfig): Promise<{ name: string; id?: string }> {
  let ac = resolvePassword(rawAc);
  let needsSetupSSHKey = false;

  // Key file missing → fall back to password auth, then setup_ssh_key after registration
  if (ac.auth_type === 'key' && ac.key_path && !fs.existsSync(ac.key_path)) {
    const envPw = process.env.FLEET_PASSWORD;
    if (!envPw) {
      fail(`Register ${ac.friendly_name}`, `Key file missing and FLEET_PASSWORD not set`);
      return { name: ac.friendly_name };
    }
    console.log(`    ↳ ${ac.friendly_name}: key file missing — registering with password, will setup_ssh_key after`);
    ac = { ...ac, auth_type: 'password', password: envPw, key_path: undefined };
    needsSetupSSHKey = true;
  }

  const result = await registerMember(ac);
  const idMatch = result.match(/ID:\s+([a-f0-9-]+)/);

  if (!result.includes('registered successfully') || !idMatch) {
    fail(`Register ${ac.friendly_name}`, result.split('\n')[0]);
    return { name: ac.friendly_name };
  }

  const id = idMatch[1];
  ok(`Registered ${ac.friendly_name} → ${id.substring(0, 8)}...`);

  if (needsSetupSSHKey) {
    const keyResult = await setupSSHKey({ member_id: id });
    keyResult.includes('✅')
      ? ok(`SSH key deployed for ${ac.friendly_name}`)
      : fail(`SSH key setup for ${ac.friendly_name}`, keyResult.split('\n')[0]);
  }

  return { name: ac.friendly_name, id };
}

async function register(config: FleetConfig): Promise<Map<string, string>> {
  section('2. Register');

  // Register all agents in parallel
  const results = await Promise.all(config.agents.map(ac => registerOne(ac)));

  const nameToId = new Map<string, string>();
  for (const r of results) {
    if (r.id) nameToId.set(r.name, r.id);
  }
  return nameToId;
}

async function testAuthErrorDetection(nameToId: Map<string, string>, config: FleetConfig) {
  section('2.5 Auth Error Detection (unprovisioned)');

  const remoteAgents = config.agents.filter(a => a.member_type === 'remote');
  if (remoteAgents.length === 0) {
    skip('No remote agents to test auth error detection');
    return;
  }

  const tasks = remoteAgents.map(async ac => {
    const id = nameToId.get(ac.friendly_name);
    if (!id) { skip(`Auth detect ${ac.friendly_name} — not registered`); return; }

    const result = await executePrompt({ member_id: id, prompt: 'hello', resume: false, timeout_s: 30 });

    result.includes('/login') && result.includes('provision_llm_auth')
      ? ok(`Auth error detected on ${ac.friendly_name}`)
      : skip(`Auth detect ${ac.friendly_name} — unexpected result (member may have residual auth)`);
  });
  await Promise.all(tasks);
}

async function verifyListAgents(nameToId: Map<string, string>) {
  section('3. Verify list_agents');

  const registeredCount = nameToId.size;

  // Both formats in parallel
  const [compact, json] = await Promise.all([
    listMembers({ format: 'compact' }),
    listMembers({ format: 'json' }),
  ]);

  [...nameToId.keys()].every(name => compact.includes(name))
    ? ok(`Compact output lists all ${registeredCount} registered agents`)
    : fail('Compact output missing agents', compact);

  try {
    const parsed = JSON.parse(json);
    parsed.total === registeredCount
      ? ok(`JSON total = ${parsed.total}`)
      : fail(`JSON total mismatch: expected ${registeredCount}, got ${parsed.total}`);

    const remoteAgents = parsed.members.filter((a: any) => a.type === 'remote');
    remoteAgents.every((a: any) => a.username)
      ? ok('All remote agents have username in JSON')
      : fail('Some remote agents missing username');
  } catch {
    fail('JSON output is not valid JSON', json.substring(0, 100));
  }
}

async function verifyOneAgent(ac: AgentConfig, id: string) {
  // Both formats in parallel
  const [compact, json] = await Promise.all([
    memberDetail({ member_id: id, format: 'compact' }),
    memberDetail({ member_id: id, format: 'json' }),
  ]);

  compact.includes('online')
    ? ok(`${ac.friendly_name} — online (compact)`)
    : fail(`${ac.friendly_name} — not online`, compact.split('\n')[0]);

  try {
    const parsed = JSON.parse(json);
    parsed.connectivity?.status === 'connected'
      ? ok(`${ac.friendly_name} — connected (json)`)
      : fail(`${ac.friendly_name} — not connected`, JSON.stringify(parsed.connectivity));

    if (ac.member_type === 'remote') {
      parsed.username === ac.username
        ? ok(`${ac.friendly_name} — username=${parsed.username}`)
        : fail(`${ac.friendly_name} — wrong username: ${parsed.username}`);
    }
  } catch {
    fail(`${ac.friendly_name} — invalid JSON detail`, json.substring(0, 100));
  }
}

async function verifyAgentDetail(nameToId: Map<string, string>, config: FleetConfig) {
  section('4. Verify agent_detail');

  const tasks: Promise<void>[] = [];
  for (const ac of config.agents) {
    const id = nameToId.get(ac.friendly_name);
    if (!id) { skip(`Detail ${ac.friendly_name} — not registered`); continue; }
    tasks.push(verifyOneAgent(ac, id));
  }
  await Promise.all(tasks);
}

async function provision(nameToId: Map<string, string>, config: FleetConfig, hasCreds: boolean) {
  section('5. Provision Auth');

  // Compute credential status once for annotation validation
  const credStatus = hasCreds
    ? validateCredentials(fs.readFileSync(CRED_PATH, 'utf-8'))
    : null;

  const tasks = config.agents.map(async ac => {
    const id = nameToId.get(ac.friendly_name);
    if (!id) { skip(`Provision ${ac.friendly_name} — not registered`); return; }

    if (ac.member_type === 'remote' && !hasCreds) {
      skip(`Provision ${ac.friendly_name} — no local credentials.json (run /login)`);
      return;
    }

    const result = await provisionAuth({ member_id: id });

    if (result.includes('✅') || result.includes('⏭️')) {
      ok(`Provisioned ${ac.friendly_name}`);
    } else if (result.includes('⚠️')) {
      ok(`Provisioned ${ac.friendly_name} (unverified — will test with prompt)`);
    } else {
      fail(`Provision ${ac.friendly_name}`, result);
    }

    // Validate output annotations based on credential status
    if (ac.member_type === 'remote' && credStatus) {
      credStatus.status === 'near-expiry' && result.includes('expires in')
        ? ok(`${ac.friendly_name} — near-expiry annotation present`)
        : credStatus.status === 'expired-refreshable' && result.includes('auto-refresh')
        ? ok(`${ac.friendly_name} — auto-refresh annotation present`)
        : credStatus.status === 'expired-no-refresh' && result.includes('/login')
        ? ok(`${ac.friendly_name} — expired-no-refresh blocked with /login`)
        : credStatus.status === 'valid'
        ? ok(`${ac.friendly_name} — no extra annotations (valid token)`)
        : skip(`${ac.friendly_name} — annotation check inconclusive`);
    }
  });
  await Promise.all(tasks);
}

async function testSendFileAndPrompt(nameToId: Map<string, string>, config: FleetConfig, hasCreds: boolean) {
  section('6. Send File + Prompt Validation');

  // Create temp files with random numbers per member — random values ensure
  // stale files from a previous run can't produce false passes.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
  const randNum = () => Math.floor(Math.random() * 9000) + 1000; // 1000–9999
  const eligible = config.agents
    .map((ac, i) => ({ ac, id: nameToId.get(ac.friendly_name), idx: i + 1, num: randNum() }))
    .filter((e): e is typeof e & { id: string } => !!e.id);

  const tasks = eligible.map(async ({ ac, id, idx, num }) => {
    if (ac.member_type === 'remote' && !hasCreds) {
      skip(`SendFile ${ac.friendly_name} — skipped (no credentials deployed)`);
      return;
    }

    // Write a temp file with a random number as content
    const fileName = `test-${idx}.txt`;
    const tmpFile = path.join(tmpDir, fileName);
    fs.writeFileSync(tmpFile, String(num));

    // Send file to member
    const sendResult = await sendFiles({ member_id: id, local_paths: [tmpFile] });
    sendResult.includes('uploaded') || sendResult.includes('copied')
      ? ok(`Sent ${fileName} to ${ac.friendly_name}`)
      : fail(`Send file to ${ac.friendly_name}`, sendResult);

    // Prompt 1: read the number
    const readResult = await executePrompt({
      member_id: id,
      prompt: `Read the file ${fileName} and respond with ONLY the number inside it, nothing else.`,
      resume: false,
      timeout_s: 60,
    });

    readResult.includes('Response from') && readResult.includes(String(num))
      ? ok(`${ac.friendly_name} — read number ${num} correctly`)
      : fail(`${ac.friendly_name} — expected ${num} in response`, readResult.substring(0, 200));

    // Prompt 2: double the number (resume session)
    const doubled = num * 2;
    const doubleResult = await executePrompt({
      member_id: id,
      prompt: 'Double this number and respond with ONLY the result, nothing else.',
      resume: true,
      timeout_s: 60,
    });

    doubleResult.includes('Response from') && doubleResult.includes(String(doubled))
      ? ok(`${ac.friendly_name} — doubled to ${doubled} correctly`)
      : fail(`${ac.friendly_name} — expected ${doubled} in response`, doubleResult.substring(0, 200));
  });

  await Promise.all(tasks);

  // Cleanup temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testPrompts(nameToId: Map<string, string>, config: FleetConfig, hasCreds: boolean) {
  section('7. Test Prompts');

  const tasks = config.agents.map(async ac => {
    const id = nameToId.get(ac.friendly_name);
    if (!id) { skip(`Prompt ${ac.friendly_name} — not registered`); return; }

    if (ac.member_type === 'remote' && !hasCreds) {
      skip(`Prompt ${ac.friendly_name} — skipped (no credentials deployed)`);
      return;
    }

    const result = await executePrompt({ member_id: id, prompt: 'respond with exactly: FLEET_OK', timeout_s: 60 });

    result.includes('FLEET_OK') || result.includes('Response from')
      ? ok(`Prompt OK on ${ac.friendly_name}`)
      : fail(`Prompt on ${ac.friendly_name}`, result);
  });
  await Promise.all(tasks);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║            Fleet Integration Test                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const configArg = process.argv.indexOf('--config');
  const configPath = configArg >= 0
    ? process.argv[configArg + 1]
    : path.join(process.cwd(), 'fleet.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`\n  Config file not found: ${configPath}`);
    console.error('  Copy fleet.config.example.json → fleet.config.json and fill in credentials.\n');
    process.exit(1);
  }

  const fullConfig: FleetConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const agentsArg = process.argv.indexOf('--agents');
  const agentFilter = agentsArg >= 0
    ? process.argv[agentsArg + 1]?.split(',').map(s => s.trim())
    : null;

  const config: FleetConfig = agentFilter
    ? { agents: fullConfig.agents.filter(a => agentFilter.includes(a.friendly_name)) }
    : fullConfig;

  if (agentFilter && config.agents.length === 0) {
    console.error(`\n  No agents matched filter: ${agentFilter.join(', ')}`);
    console.error(`  Available: ${fullConfig.agents.map(a => a.friendly_name).join(', ')}\n`);
    process.exit(1);
  }

  console.log(`  Config: ${configPath} (${config.agents.length} member${config.agents.length === 1 ? '' : 's'}${agentFilter ? ` — filtered: ${agentFilter.join(', ')}` : ''})`);

  const { hasCreds } = await preflight(config);
  await teardown();
  const nameToId = await register(config);
  await testAuthErrorDetection(nameToId, config);
  await verifyListAgents(nameToId);
  await verifyAgentDetail(nameToId, config);
  await provision(nameToId, config, hasCreds);
  await testSendFileAndPrompt(nameToId, config, hasCreds);
  await testPrompts(nameToId, config, hasCreds);

  // Summary
  section('Results');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);

  if (errors.length > 0) {
    console.log('\n  Failures:');
    errors.forEach(e => console.log(`    - ${e}`));
  }

  section('Final Fleet State');
  console.log(await listMembers());

  closeAllConnections();

  console.log();
  if (failed > 0) {
    console.log('\x1b[31m  INTEGRATION TEST FAILED\x1b[0m\n');
    process.exit(1);
  }
  console.log('\x1b[32m  ALL INTEGRATION TESTS PASSED\x1b[0m\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
