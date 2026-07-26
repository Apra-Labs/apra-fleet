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
//   node fleet-setup.mjs collect-logs
//   node fleet-setup.mjs teardown
//   node fleet-setup.mjs shutdown
//
// `setup` and `collect-logs` must be run with cwd set to the run directory
// ($RUN_DIR in the workflow) -- checkpoints.json / logs/<role>/ are written
// relative to cwd, matching the convention sprint-script.md already uses for
// T3-* checkpoints. `collect-logs` must run BEFORE `teardown` -- it needs
// alice/bella still registered and reachable to pull their session
// transcripts.
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
 *  Most fleet tools report failure as text (a leading FAIL_MARK) rather than
 *  a rejected promise, but a handler that throws internally instead resolves
 *  with the MCP-level result.isError flag set (see McpClient.handleMessage /
 *  client.mjs -- only a transport-level error rejects the promise) -- check
 *  both, since a FAIL_MARK-less isError result would otherwise read as PASS. */
export async function call(fn, options, label) {
  const result = await fn(options);
  const text = textOf(result).trim();
  if (result?.isError || text.startsWith(FAIL_MARK)) {
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

// Clones the toy repo and runs `bd init` on a member, deterministically --
// this used to be the orchestrator LLM's own T3-repo-setup work (real turns
// spent on `git clone` + waiting out a slow `bd init`, once per member). Now
// that the toy repo's Dolt history has been flattened (10 commits -> 1;
// apra-fleet-eft P0 follow-up), `bd init` on a fresh clone takes ~25s instead
// of downloading thousands of chunks -- cheap enough to just run
// independently on BOTH members rather than initializing once and
// replicating via send_files/receive_files, which was the original plan
// before the flatten made that optimization unnecessary.
//
// `bd init` is NOT idempotent -- it errors ("this workspace is already
// initialized") if a DB already exists, so each branch checks first and
// skips if the toy folder / Dolt DB is already present (e.g. a re-run
// against a work folder teardown didn't get to wipe).
export function cloneAndInitCommand(toyUrl, toyPath, os) {
  if (os === 'windows') {
    return [
      `if (Test-Path "${toyPath}\\.git") { Write-Output "already-cloned" } else { git clone ${toyUrl} "${toyPath}" }`,
      `Set-Location "${toyPath}"`,
      `if (Test-Path ".beads\\embeddeddolt") { Write-Output "already-initialized" } else { bd init 2>&1 }`,
    ].join('; ');
  }
  return [
    `if [ -d "${toyPath}/.git" ]; then echo already-cloned; else git clone ${toyUrl} "${toyPath}"; fi`,
    `cd "${toyPath}"`,
    `if [ -d ".beads/embeddeddolt" ]; then echo already-initialized; else bd init 2>&1; fi`,
  ].join(' && ');
}

export function toyRepoUrlFor(vcs, members) {
  const url = members.toy_projects?.[vcs];
  if (!url) throw new Error(`members.json toy_projects has no entry for vcs "${vcs}"`);
  return url;
}

async function bootstrapToyRepo(fleetApi, memberName, folder, os, toyUrl) {
  const toyPath = toyFolderPath(folder, os);
  await execCommand(fleetApi, memberName, cloneAndInitCommand(toyUrl, toyPath, os), 'toy repo clone + bd init');
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
    const config = loadConfig();
    const members = resolveMemberConfigs(suiteId, config);
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

    // T2.5: Toy repo + beads bootstrap -- deterministic clone + `bd init` on
    // BOTH members independently (see bootstrapToyRepo's comment for why this
    // no longer needs an alice-initializes/bella-replicates approach).
    const suite = config.suites.suites[suiteId];
    const toyUrl = toyRepoUrlFor(suite.vcs, config.members);
    for (const member of memberList) {
      await bootstrapToyRepo(fleetApi, member.name, member.folder, member.os, toyUrl);
    }
    writeCheckpoint('T2-toy-bootstrap', 'PASS', 'toy repo cloned + beads DB initialized on both members');
    writeCheckpoint('T2-done', 'PASS', 'setup phase finished');

    process.stdout.write('Setup phase complete: T1, T2, T2-done all PASS.\n');
  } finally {
    try { transport.stop(); } catch { /* best-effort cleanup */ }
  }
}

// The toy repo is cloned to <work_folder>/fleet-e2e-toy (see verifyRoundtrip's
// sibling setup steps and toy_projects in members.json) and is where the
// doer/reviewer's beads/Dolt DB and git state accumulate across runs. Wiping
// it here -- while the member is still registered and reachable via
// execute_command -- means each run starts from a pristine clone instead of
// patching over whatever state (corrupted Dolt DB, stale git identity) the
// previous run left behind.
export function toyFolderPath(folder, os) {
  return os === 'windows' ? `${folder}\\fleet-e2e-toy` : `${folder}/fleet-e2e-toy`;
}

export function deleteFolderCommand(folderPath, os) {
  return os === 'windows'
    ? `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "${folderPath}"`
    : `rm -rf "${folderPath}"`;
}

// ---- deterministic session-log collection --------------------------------
//
// Replaces sprint-script.md's old "## Collect Session Logs" section, which
// had the orchestrator LLM itself work out each member's transcript path and
// copy it over -- real turns spent on pure file-finding with no reasoning
// involved, and it silently produced nothing if the orchestrator ran out of
// turns or crashed before reaching that instruction. This runs unconditionally
// as its own step (see fleet-e2e.yml, `if: always()`, before T6 teardown
// removes the members) so logs are collected even on a total LLM failure.
//
// Path conventions below mirror src/services/stall/log-path-resolver.ts
// (the stall detector's own, already-tested logic for finding a live
// session's log file) rather than the old prompt's hand-written description,
// which turned out to disagree with it in places (e.g. gemini's real
// filename is the exact session ID, not an 8-char-prefix glob).

export function claudeProjectSlug(workFolder) {
  // Claude Code replaces EVERY non-alphanumeric character (slashes,
  // backslashes, colons, dots...) with '-', not just path separators.
  return workFolder.replace(/[^a-zA-Z0-9]/g, '-');
}

export function geminiProjectName(workFolder) {
  return workFolder.split(/[\\/]/).filter(Boolean).pop() || 'project';
}

// Builds a cross-platform `node -e ...` SHELL COMMAND (not just JS source) that
// locates a member's own session transcript and copies it into the current
// directory -- avoids needing separate bash/PowerShell variants per OS,
// matching the pattern the workflow already uses for agy's own transcript
// lookup (fleet-e2e.yml's AGY_TRANSCRIPT_SCRIPT).
//
// Dynamic values (work-folder-derived slugs, session ids) are passed as
// base64-encoded `process.argv` words instead of being interpolated as
// quoted string literals into the -e source. This used to build the JS
// source with `JSON.stringify(slug)`/`JSON.stringify(sessionId)` (producing
// embedded double-quoted literals), then wrap the WHOLE script in another
// `JSON.stringify()` for the `-e` argument (fleet-setup.mjs's execCommand
// call) -- nesting one double-quoted string inside another, escaped as
// `\"`. bash preserves that faithfully, but on a Windows local member the
// PowerShell/CRT argv re-quoting the command passes through does not
// round-trip nested `\"` correctly, corrupting exactly the interpolated
// spans (observed live: quotes/commas mangled around the slug and session
// id, while the surrounding single-quoted literal JS -- 'fs', 'path',
// '.jsonl', etc -- survived intact every time). Base64 has no quote,
// backslash, or comma characters at all, so there is nothing left for any
// layer of re-quoting to corrupt, regardless of how many shells the command
// string crosses (ssh, cmd.exe, powershell.exe).
//
// Returns a full command string (ready to hand straight to execute_command,
// no further wrapping needed), or null for providers with no known flat-file
// transcript (opencode stores sessions in a SQLite db, not a per-session
// file -- unsupported here).
function toBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function buildNodeEvalCommand(scriptBody, argValues) {
  // Prepended once: process.argv[2..] are base64-encoded UTF-8 strings,
  // decoded into `A` before scriptBody runs.
  const fullScript = `const A=process.argv.slice(2).map(x=>Buffer.from(x,'base64').toString('utf8'));${scriptBody}`;
  const scriptB64 = toBase64(fullScript);
  const argB64 = argValues.map(toBase64);
  return `node -e "eval(Buffer.from('${scriptB64}','base64').toString('utf8'))" ${argB64.map((a) => `"${a}"`).join(' ')}`;
}

export function collectTranscriptScript(provider, workFolder, sessionId) {
  const copyAndReport = (srcExpr, idExpr) =>
    `if(fs.existsSync(${srcExpr})){fs.copyFileSync(${srcExpr},path.join(process.cwd(),${idExpr}+'.jsonl'));console.log('FLEET_LOG_COPIED');}else{console.log('FLEET_LOG_MISSING');}`;

  if (provider === 'claude') {
    const slug = claudeProjectSlug(workFolder);
    const scriptBody =
      `const fs=require('fs'),path=require('path'),os=require('os');`
      + `const src=path.join(os.homedir(),'.claude','projects',A[0],A[1]+'.jsonl');`
      + copyAndReport('src', 'A[1]');
    return buildNodeEvalCommand(scriptBody, [slug, sessionId]);
  }

  if (provider === 'gemini') {
    const projectName = geminiProjectName(workFolder);
    const scriptBody =
      `const fs=require('fs'),path=require('path'),os=require('os');`
      + `const src=path.join(os.homedir(),'.gemini','tmp',A[0],'chats',A[1]+'.jsonl');`
      + copyAndReport('src', 'A[1]');
    return buildNodeEvalCommand(scriptBody, [projectName, sessionId]);
  }

  if (provider === 'agy') {
    // agy (antigravity-cli) has no session-id-named file at all -- it keys a
    // cache of conversations by the exact cwd they were started in, mapping
    // to an internal conversation id whose transcript lives elsewhere. The
    // fleet-tracked sessionId isn't used for lookup here at all; this only
    // needs the member's own work folder (A[0]).
    const scriptBody =
      `const fs=require('fs'),path=require('path'),os=require('os');`
      + `const home=os.homedir();`
      + `const norm=p=>path.resolve(p).toLowerCase().split(path.sep).join('/');`
      + `const target=norm(A[0]);`
      + `let id='';`
      + `try{const cache=JSON.parse(fs.readFileSync(path.join(home,'.gemini','antigravity-cli','cache','last_conversations.json'),'utf8'));`
      + `for(const k of Object.keys(cache)){if(norm(k)===target){id=cache[k];break;}}}catch{}`
      + `if(!id){console.log('FLEET_LOG_MISSING');}else{`
      + `const src=path.join(home,'.gemini','antigravity-cli','brain',id,'.system_generated','logs','transcript.jsonl');`
      + `if(fs.existsSync(src)){fs.copyFileSync(src,path.join(process.cwd(),id+'.jsonl'));console.log('FLEET_LOG_COPIED');}else{console.log('FLEET_LOG_MISSING');}`
      + `}`;
    return buildNodeEvalCommand(scriptBody, [workFolder]);
  }

  // codex, copilot, opencode: no known flat-file transcript to collect yet.
  return null;
}

async function collectMemberLogs(fleetApi, roleName, runDir) {
  let detail;
  try {
    const { text } = await call(fleetApi.memberDetail.bind(fleetApi), { member_name: roleName, format: 'json' }, `member_detail(${roleName})`);
    detail = JSON.parse(text);
  } catch (err) {
    return `${roleName}: member_detail failed: ${err.message}`;
  }

  const sessionId = detail?.session?.id;
  const workFolder = detail?.folder;
  const provider = detail?.llmProvider ?? 'claude';

  if (!sessionId) return `${roleName}: no session id recorded, nothing to collect`;
  if (!workFolder) return `${roleName}: no work folder recorded, nothing to collect`;

  const command = collectTranscriptScript(provider, workFolder, sessionId);
  if (!command) return `${roleName}: provider "${provider}" has no known transcript format, skipped`;

  const localDestDir = path.join(runDir, 'logs', roleName);
  fs.mkdirSync(localDestDir, { recursive: true });
  const remoteFileName = `${sessionId}.jsonl`;

  let copyOutput;
  try {
    copyOutput = await execCommand(fleetApi, roleName, command, 'locate + copy session transcript');
  } catch (err) {
    return `${roleName}: transcript lookup script failed: ${err.message}`;
  }

  if (!copyOutput.includes('FLEET_LOG_COPIED')) {
    return `${roleName}: transcript not found on member (session ${sessionId}, provider ${provider})`;
  }

  try {
    await call(
      fleetApi.receiveFiles.bind(fleetApi),
      { member_name: roleName, remote_paths: [remoteFileName], local_dest_dir: localDestDir },
      `receive_files(${roleName})`,
    );
  } catch (err) {
    return `${roleName}: receive_files failed: ${err.message}`;
  } finally {
    // Best-effort cleanup of the copy left in the member's work folder --
    // receive_files only reaches files inside it, so the copy step above was
    // just a hop, not something that should persist there afterward.
    try {
      await execCommand(
        fleetApi,
        roleName,
        workFolder && workFolder.match(/^[A-Za-z]:\\/) // windows-style absolute path
          ? `Remove-Item -Force -ErrorAction SilentlyContinue "${remoteFileName}"`
          : `rm -f "${remoteFileName}"`,
        'clean up transcript copy',
      );
    } catch { /* best-effort */ }
  }

  const downloadedPath = path.join(localDestDir, remoteFileName);
  if (!fs.existsSync(downloadedPath)) return `${roleName}: receive_files did not write ${downloadedPath}`;
  return `${roleName}: collected session ${sessionId} (${provider}) -> ${downloadedPath}`;
}

async function runCollectLogs(runDir) {
  const { connectFleet } = await import('../../packages/apra-fleet-client/src/client/server-resolution.mjs');
  const { fleetApi, transport } = await connectFleet();

  try {
    const results = [];
    for (const { name } of ROLES) {
      const note = await collectMemberLogs(fleetApi, name, runDir);
      results.push(note);
      process.stdout.write(`${note}\n`);
    }
    process.stdout.write('Log collection complete.\n');
  } finally {
    try { transport.stop(); } catch { /* best-effort cleanup */ }
  }
}

async function runTeardown(suiteId) {
  const { connectFleet } = await import('../../packages/apra-fleet-client/src/client/server-resolution.mjs');
  const { fleetApi, transport } = await connectFleet();

  // Resolving member configs requires a known suite -- older callers (or a
  // manual `teardown` invocation) that don't pass one just skip the folder
  // wipe and fall through to member removal, same as before this existed.
  const members = suiteId ? resolveMemberConfigs(suiteId, loadConfig()) : null;

  // remove_member's text result has no single consistent failure marker
  // across its return paths (e.g. a "not found" member returns unmarked
  // plain text, matching t6-teardown.md's "ignore 'not found' errors").
  // The reliable signal -- and what t6-teardown.md itself gates on -- is
  // the follow-up fleet_status check for whether alice/bella still remain.
  const removalNotes = [];
  try {
    for (const { role, name } of ROLES) {
      const member = members?.[role];
      if (member) {
        const toyPath = toyFolderPath(member.folder, member.os);
        try {
          await execCommand(fleetApi, name, deleteFolderCommand(toyPath, member.os), 'delete toy folder');
          removalNotes.push(`${name}: wiped ${toyPath}`);
        } catch (err) {
          // Best-effort -- a member that's already unreachable (e.g. a prior
          // step failed before it came online) shouldn't block teardown from
          // still removing it from the registry.
          removalNotes.push(`${name}: toy folder wipe failed: ${err.message}`);
        }
      }

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
  } else if (subcommand === 'collect-logs') {
    // Must run with cwd = $RUN_DIR (same convention as `setup`) -- logs are
    // written to logs/<role>/ relative to cwd. Deliberately best-effort: a
    // missing session or lookup failure on one member is logged and does not
    // fail the process, since this is diagnostic collection, not a gate.
    runCollectLogs(process.cwd()).catch((err) => {
      process.stderr.write(`Log collection failed: ${err.message}\n`);
      process.exit(1);
    });
  } else if (subcommand === 'teardown') {
    const { suite } = parseArgs(rest);
    runTeardown(suite).catch((err) => {
      process.stdout.write(`T6: FAIL -- ${err.message}\n`);
      process.exit(1);
    });
  } else if (subcommand === 'shutdown') {
    runShutdown().catch((err) => {
      process.stderr.write(`Shutdown failed: ${err.message}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write('Usage: fleet-setup.mjs <setup --suite <id>|teardown|shutdown|collect-logs>\n');
    process.exit(1);
  }
}
