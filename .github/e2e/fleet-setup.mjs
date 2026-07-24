#!/usr/bin/env node
// Deterministic replacement for the LLM-driven T1/T2 setup phase (formerly
// setup-script.md) and T6 teardown phase (formerly t6-teardown.md) of the
// fleet e2e workflow. Every fleet MCP tool call here is provider-agnostic,
// so there is no need for an LLM to decide what to call -- see the "Load
// suite config" step in .github/workflows/fleet-e2e.yml for the config this
// script re-reads.
//
// Usage:
//   node fleet-setup.mjs setup --suite <id>
//   node fleet-setup.mjs teardown
//   node fleet-setup.mjs shutdown
//
// `setup` must be run with cwd set to the run directory ($RUN_DIR in the
// workflow) -- checkpoints.json is written relative to cwd, matching the
// convention sprint-script.md already uses for T3-* checkpoints.
//
// `shutdown` stops the whole fleet server process (every member/session on
// the runner, not just the ones this suite registered) and is deliberately
// NOT part of `teardown` -- a caller running multiple suites against the
// same self-hosted runner must opt into it explicitly rather than have any
// one suite's teardown take the server out from under the others.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// U+274C CROSS MARK ("[X]" in fleet tool output), written as an escape so
// this file stays ASCII-only. Fleet tools report failure as a leading
// marker in their text result, not as a rejected promise -- see
// src/services/tool-registry.ts's wrapTool().
const FAIL_MARK = '\u274C';

const ROLES = [
  { role: 'doer', name: 'alice', tag: 'doer' },
  { role: 'reviewer', name: 'bella', tag: 'reviewer' },
];

// ---- config resolution (pure) -----------------------------------------------

export function loadConfig(repoRoot = REPO_ROOT) {
  const suites = JSON.parse(fs.readFileSync(path.join(repoRoot, '.github/e2e/suites.json'), 'utf8'));
  const members = JSON.parse(fs.readFileSync(path.join(repoRoot, '.github/e2e/members.json'), 'utf8'));
  return { suites, members };
}

export function resolveMemberConfigs(suiteId, { suites, members }) {
  const suite = suites.suites[suiteId];
  if (!suite) throw new Error(`Unknown suite "${suiteId}" in suites.json`);

  const resolved = {};
  for (const { role, name, tag } of ROLES) {
    const roleCfg = suite[role];
    if (!roleCfg) throw new Error(`suites.json suite "${suiteId}" has no "${role}" entry`);
    // suites.json's <role>.os is already the exact members.json key to use
    // (e.g. "linux" for a remote member, "local_doer_linux" for a local one)
    // -- see the "Load suite config" step in fleet-e2e.yml, which does the
    // same members[$DOER_OS] lookup with no further transformation.
    const memberCfg = members[roleCfg.os];
    if (!memberCfg) throw new Error(`members.json has no entry for "${roleCfg.os}" (suite ${suiteId} ${role})`);
    resolved[role] = {
      name,
      tags: [tag],
      type: roleCfg.type,
      provider: roleCfg.provider,
      host: memberCfg.host,
      username: memberCfg.username,
      folder: memberCfg.work_folder,
      // roleCfg.os is either a bare OS name ("linux"/"macos"/"windows", remote
      // members) or "local_<role>_<os>" (local members) -- either way the OS
      // name is the last underscore-separated segment. execute_command runs
      // the literal string we pass through the member's native shell with NO
      // translation (bash on linux/macos, powershell.exe on windows -- see
      // src/os/windows.ts's cleanExec()), so callers must pick shell-correct
      // commands themselves.
      os: roleCfg.os.split('_').pop(),
    };
  }
  return resolved;
}

// ---- MCP result helpers -----------------------------------------------------

function textOf(result) {
  return (result?.content ?? []).map((c) => c.text ?? '').join('\n');
}

/** Call a fleet SDK method and throw with the real error text on failure.
 *  Fleet tools report failure as text (a leading FAIL_MARK), not a rejected
 *  promise, so this is the only reliable check. */
async function call(fn, options, label) {
  const result = await fn(options);
  const text = textOf(result).trim();
  if (text.startsWith(FAIL_MARK)) {
    throw new Error(`${label} failed: ${text}`);
  }
  return { text, result };
}

/** execute_command carries exitCode/stdout/stderr in structuredContent
 *  (see ExecuteCommandResult in src/tools/execute-command.ts) -- prefer that
 *  over scraping the display text. */
async function execCommand(fleetApi, memberName, command, label) {
  const result = await fleetApi.executeCommand({ member_name: memberName, command });
  const structured = result?.structuredContent;
  if (!structured || structured.exitCode !== 0) {
    throw new Error(`${label} on ${memberName} failed: ${textOf(result)}`);
  }
  return structured.stdout ?? '';
}

// ---- checkpoints --------------------------------------------------------------

function writeCheckpoint(id, status, notes) {
  const line = JSON.stringify({ id, status, notes });
  fs.appendFileSync('checkpoints.json', line + '\n');
  process.stdout.write(`CHECKPOINT: ${line}\n`);
}

// ---- setup steps ----------------------------------------------------------

async function registerAndProvision(fleetApi, member) {
  const isRemote = member.type === 'remote';

  const registerOptions = {
    friendly_name: member.name,
    member_type: member.type,
    work_folder: member.folder,
    llm_provider: member.provider,
    tags: member.tags,
  };
  if (isRemote) {
    registerOptions.host = member.host;
    registerOptions.username = member.username;
    registerOptions.auth_type = 'password';
    // Server resolves this from its own credential store (seeded by the
    // workflow's "Seed fleet credential store" step) -- never a raw secret here.
    registerOptions.password = '{{secure.E2E_ACRED}}';
  }
  await call(fleetApi.registerMember.bind(fleetApi), registerOptions, `register_member(${member.name})`);

  if (isRemote) {
    await call(fleetApi.setupSshKey.bind(fleetApi), { member_name: member.name }, `setup_ssh_key(${member.name})`);
  }

  await call(
    fleetApi.updateMember.bind(fleetApi),
    { member_name: member.name, unattended: 'auto' },
    `update_member(${member.name})`,
  );
  await call(
    fleetApi.provisionLlmAuth.bind(fleetApi),
    { member_name: member.name },
    `provision_llm_auth(${member.name})`,
  );
  await call(
    fleetApi.composePermissions.bind(fleetApi),
    { member_name: member.name, tags: member.tags, project_folder: member.folder },
    `compose_permissions(${member.name})`,
  );
}

async function assertMembersOnline(fleetApi, names) {
  const { text } = await call(fleetApi.fleetStatus.bind(fleetApi), { format: 'json' }, 'fleet_status');
  const payload = JSON.parse(text);
  const byName = new Map((payload.members ?? []).map((m) => [m.name, m]));
  const offline = names.filter((name) => byName.get(name)?.status !== 'online');
  if (offline.length) {
    const seen = names.map((name) => `${name}=${byName.get(name)?.status ?? 'MISSING'}`);
    throw new Error(`fleet_status: expected [${names.join(', ')}] online, got [${seen.join(', ')}]`);
  }
}

// Verbatim port of setup-script.md's "Verify tools on each member" block for
// linux/macos (bash) -- no behavior change there, just moved out of an LLM's
// hands. execute_command does NOT translate commands for the target shell
// (src/os/*.ts's cleanExec() picks the shell, but the command string is run
// as-is), so a windows member needs its own PowerShell version -- bash's
// `||`/`$(...)` command substitution do not parse under Windows PowerShell
// 5.1 (`The token '||' is not a valid statement separator`).
const BD_CHECK_BASH = 'which bd || npm install -g @beads/bd@1.0.4';
const DOLT_CHECK_BASH = [
  'which dolt || ~/bin/dolt version || (',
  'OS=$(uname -s | tr \'[:upper:]\' \'[:lower:]\');',
  'ARCH=$(uname -m | sed \'s/x86_64/amd64/\');',
  'mkdir -p ~/bin;',
  'curl -fsSL -o /tmp/dolt.tar.gz https://github.com/dolthub/dolt/releases/latest/download/dolt-${OS}-${ARCH}.tar.gz;',
  'tar -xzf /tmp/dolt.tar.gz -C /tmp/ && mv /tmp/dolt-${OS}-${ARCH}/bin/dolt ~/bin/ && chmod +x ~/bin/dolt;',
  'grep -q \'HOME/bin\' ~/.profile 2>/dev/null || echo \'export PATH=$HOME/bin:$PATH\' >> ~/.profile;',
  '~/bin/dolt version',
  ')',
].join(' ');

const BD_CHECK_WINDOWS = 'if (Get-Command bd -ErrorAction SilentlyContinue) { bd version } else { npm install -g @beads/bd@1.0.4 }';
const DOLT_CHECK_WINDOWS = [
  'if (Get-Command dolt -ErrorAction SilentlyContinue) { dolt version }',
  'elseif (Test-Path "$HOME\\bin\\dolt.exe") { & "$HOME\\bin\\dolt.exe" version }',
  'else {',
  'New-Item -ItemType Directory -Force -Path "$HOME\\bin" | Out-Null;',
  'Invoke-WebRequest -Uri "https://github.com/dolthub/dolt/releases/latest/download/dolt-windows-amd64.zip" -OutFile "$env:TEMP\\dolt.zip";',
  'Expand-Archive -Path "$env:TEMP\\dolt.zip" -DestinationPath "$env:TEMP\\dolt-extract" -Force;',
  'Move-Item -Path "$env:TEMP\\dolt-extract\\dolt-windows-amd64\\bin\\dolt.exe" -Destination "$HOME\\bin\\dolt.exe" -Force;',
  '& "$HOME\\bin\\dolt.exe" version',
  '}',
].join(' ');

export function bdCheckFor(os) {
  return os === 'windows' ? BD_CHECK_WINDOWS : BD_CHECK_BASH;
}

export function doltCheckFor(os) {
  return os === 'windows' ? DOLT_CHECK_WINDOWS : DOLT_CHECK_BASH;
}

async function verifyBdDolt(fleetApi, memberName, os) {
  await execCommand(fleetApi, memberName, bdCheckFor(os), 'bd check');
  await execCommand(fleetApi, memberName, doltCheckFor(os), 'dolt check');
}

async function verifyEcho(fleetApi, memberName) {
  const stdout = await execCommand(fleetApi, memberName, 'echo "e2e-ok-$(hostname)"', 'echo check');
  if (!stdout.includes('e2e-ok-')) {
    throw new Error(`echo check on ${memberName}: expected output to contain "e2e-ok-", got: ${stdout}`);
  }
}

async function verifyRoundtrip(fleetApi, memberName, runDir) {
  const content = 'fleet-e2e-roundtrip';
  const baseName = `roundtrip-${memberName}.txt`;
  const localSendPath = path.join(runDir, baseName);
  const localRecvDir = path.join(runDir, `recv-${memberName}`);

  fs.writeFileSync(localSendPath, content);
  await call(
    fleetApi.sendFiles.bind(fleetApi),
    { member_name: memberName, local_paths: [localSendPath] },
    `send_files(${memberName})`,
  );

  fs.mkdirSync(localRecvDir, { recursive: true });
  await call(
    fleetApi.receiveFiles.bind(fleetApi),
    { member_name: memberName, remote_paths: [baseName], local_dest_dir: localRecvDir },
    `receive_files(${memberName})`,
  );

  // downloadFiles() (src/services/strategy.ts) preserves the basename of
  // remote_paths when writing into local_dest_dir.
  const downloadedPath = path.join(localRecvDir, baseName);
  if (!fs.existsSync(downloadedPath)) {
    throw new Error(`receive_files(${memberName}) did not write ${downloadedPath}`);
  }
  const received = fs.readFileSync(downloadedPath, 'utf8').trim();
  if (received !== content) {
    throw new Error(`roundtrip content mismatch on ${memberName}: expected "${content}", got "${received}"`);
  }
}

// ---- subcommands ------------------------------------------------------------

async function runSetup(suiteId, runDir) {
  const { connectFleet } = await import('../../packages/apra-fleet-client/src/client/server-resolution.mjs');
  const { fleetApi, transport } = await connectFleet();

  try {
    const members = resolveMemberConfigs(suiteId, loadConfig());
    const memberList = [members.doer, members.reviewer];

    // T1: Member Registration
    for (const member of memberList) {
      await registerAndProvision(fleetApi, member);
    }
    await assertMembersOnline(fleetApi, memberList.map((m) => m.name));
    for (const member of memberList) {
      await verifyBdDolt(fleetApi, member.name, member.os);
    }
    writeCheckpoint('T1', 'PASS', `registered ${memberList.map((m) => m.name).join(', ')}`);

    // T2: Basic Execution
    for (const member of memberList) {
      await verifyEcho(fleetApi, member.name);
      await verifyRoundtrip(fleetApi, member.name, runDir);
    }
    writeCheckpoint('T2', 'PASS', 'echo + file roundtrip verified on both members');
    writeCheckpoint('T2-done', 'PASS', 'setup phase finished');

    process.stdout.write('Setup phase complete: T1, T2, T2-done all PASS.\n');
  } finally {
    try { transport.stop(); } catch { /* best-effort cleanup */ }
  }
}

async function runTeardown() {
  const { connectFleet } = await import('../../packages/apra-fleet-client/src/client/server-resolution.mjs');
  const { fleetApi, transport } = await connectFleet();

  // remove_member's text result has no single consistent failure marker
  // across its return paths (e.g. a "not found" member returns unmarked
  // plain text, matching t6-teardown.md's "ignore 'not found' errors").
  // The reliable signal -- and what t6-teardown.md itself gates on -- is
  // the follow-up fleet_status check for whether alice/bella still remain.
  const removalNotes = [];
  try {
    for (const { name } of ROLES) {
      try {
        const result = await fleetApi.removeMember({ member_name: name, force: true });
        removalNotes.push(`${name}: ${textOf(result).split('\n')[0]}`);
      } catch (err) {
        removalNotes.push(`${name}: ${err.message}`);
      }
    }

    const { text } = await call(fleetApi.fleetStatus.bind(fleetApi), { format: 'json' }, 'fleet_status');
    const payload = JSON.parse(text);
    const remaining = (payload.members ?? []).filter((m) => m.name === 'alice' || m.name === 'bella');

    if (remaining.length) {
      const reason = `members still present: ${remaining.map((m) => m.name).join(', ')} (${removalNotes.join('; ')})`;
      process.stdout.write(`T6: FAIL -- ${reason}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('T6: PASS\n');
    }
  } finally {
    try { transport.stop(); } catch { /* best-effort cleanup */ }
  }
}

// shutdown is intentionally its own subcommand, NOT folded into teardown --
// it stops the whole fleet server (every connected member/session on the
// runner), not just alice/bella, so a caller running multiple suites against
// the same self-hosted runner concurrently must opt into it explicitly rather
// than have every suite's teardown kill it out from under the others.
async function runShutdown() {
  const { connectFleet, checkRunningInstance } = await import('../../packages/apra-fleet-client/src/client/server-resolution.mjs');
  const { fleetApi, transport } = await connectFleet();
  try {
    try {
      const { text } = await call(fleetApi.shutdownServer.bind(fleetApi), undefined, 'shutdown_server');
      process.stdout.write(`${text}\n`);
    } catch (err) {
      // shutdown_server (src/tools/shutdown-server.ts) closes the HTTP
      // transport -- including the persistent SSE stream this request's own
      // response may be delivered over -- as part of shutting down. The
      // connection dying before that response arrives is the EXPECTED
      // outcome of a successful shutdown racing its own teardown, not a
      // real failure, and surfaces here as a transport/stream error rather
      // than a resolved response. Don't trust a response that can
      // legitimately never arrive -- verify directly instead.
      const instance = await checkRunningInstance().catch(() => ({ running: false }));
      if (instance.running) throw err; // still up -- this really did fail
      process.stdout.write(`Server shutting down (connection closed before the response arrived -- verified stopped: ${err.message}).\n`);
    }
  } finally {
    try { transport.stop(); } catch { /* the server is exiting anyway -- best-effort */ }
  }
}

// ---- CLI entry ----------------------------------------------------------------

function parseArgs(argv) {
  const args = { suite: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--suite') args.suite = argv[++i];
  }
  return args;
}

if (process.argv[1] && (process.argv[1].endsWith('fleet-setup.mjs') || process.argv[1].endsWith('fleet-setup'))) {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === 'setup') {
    const { suite } = parseArgs(rest);
    if (!suite) {
      process.stderr.write('Usage: fleet-setup.mjs setup --suite <id>\n');
      process.exit(1);
    }
    runSetup(suite, process.cwd()).catch((err) => {
      process.stderr.write(`Setup failed: ${err.message}\n`);
      process.exit(1);
    });
  } else if (subcommand === 'teardown') {
    runTeardown().catch((err) => {
      process.stdout.write(`T6: FAIL -- ${err.message}\n`);
      process.exit(1);
    });
  } else if (subcommand === 'shutdown') {
    runShutdown().catch((err) => {
      process.stderr.write(`Shutdown failed: ${err.message}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write('Usage: fleet-setup.mjs <setup --suite <id>|teardown|shutdown>\n');
    process.exit(1);
  }
}
