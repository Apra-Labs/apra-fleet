import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { getSocketPath } from 'blindfold';

const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Provider -> auth env var name */
const PROVIDER_AUTH_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  codex: 'OPENAI_API_KEY',
  copilot: 'COPILOT_GITHUB_TOKEN',
};

export async function runAuth(args: string[]): Promise<void> {
  if (args.includes('--confirm')) {
    return handleConfirm(args);
  }
  if (args.includes('--oauth')) {
    return handleOAuth(args);
  }
  if (args.includes('--api-key')) {
    return handleApiKey(args);
  }

  console.error('Usage:');
  console.error('  apra-fleet auth --confirm <credential-name>');
  console.error('  apra-fleet auth --oauth [--llm <provider>] [<token> | secure.<name> | --secure <name>]');
  console.error('  apra-fleet auth --api-key [--llm <provider>] [<token> | secure.<name> | --secure <name>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// --confirm: OOB network egress confirmation
// ---------------------------------------------------------------------------

async function handleConfirm(args: string[]): Promise<void> {
  const credentialName = args.find((a) => !a.startsWith('-'));

  if (!credentialName) {
    console.error('Usage: apra-fleet auth --confirm <credential-name>');
    process.exit(1);
  }

  if (!NAME_REGEX.test(credentialName)) {
    console.error('Usage: apra-fleet auth --confirm <credential-name>');
    console.error('  Name must match [a-zA-Z0-9_-]{1,64}');
    process.exit(1);
  }

  const contextIdx = args.indexOf('--context');
  const rawCommand = contextIdx !== -1 && contextIdx + 1 < args.length ? args[contextIdx + 1] : undefined;
  const commandContext = rawCommand ? rawCommand.replace(CONTROL_CHARS, '') : undefined;

  const onIdx = args.indexOf('--on');
  const rawMember = onIdx !== -1 && onIdx + 1 < args.length ? args[onIdx + 1] : undefined;
  const memberContext = rawMember ? rawMember.replace(CONTROL_CHARS, '') : undefined;

  console.error(`\napra-fleet - Network Egress Confirmation\n`);
  if (commandContext && memberContext) {
    console.error(`  This command on ${memberContext} will send credential "${credentialName}" over the network:`);
    console.error(`  ${commandContext}`);
  } else {
    console.error(`  Credential "${credentialName}" will be sent over the network.`);
    if (memberContext) console.error(`  Member:  ${memberContext}`);
    if (commandContext) console.error(`  Command: ${commandContext}`);
  }
  console.error('');

  let inputValue: string;
  try {
    inputValue = await new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question('  Type "yes" to allow network access: ', (answer) => {
        rl.close();
        resolve(answer);
      });
      rl.on('close', () => resolve(''));
      rl.on('error', reject);
    });
  } catch {
    console.error('Cancelled.');
    process.exit(1);
    return;
  }

  if (inputValue.toLowerCase() !== 'yes') {
    console.error('  x Confirmation not received. Aborting.');
    process.exit(1);
    return;
  }

  const sockPath = getSocketPath();

  await new Promise<void>((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: credentialName, password: inputValue }) + '\n';
      inputValue = '';
      client.write(msg);
    });

    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;

      const line = buffer.slice(0, nl);
      try {
        const resp = JSON.parse(line);
        if (resp.ok) {
          console.error('\n  + Confirmed. You can close this window.\n');
          resolve();
        } else {
          console.error(`\n  x Error: ${resp.error}\n`);
          reject(new Error(resp.error));
        }
      } catch {
        console.error('\n  x Invalid response from server.\n');
        reject(new Error('Invalid server response'));
      }
      client.end();
    });

    client.on('error', (err) => {
      console.error(`\n  x Could not connect to apra-fleet server.`);
      console.error(`    Is the MCP server running?\n`);
      reject(err);
    });
  }).catch(() => {
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Parse args shared by --oauth and --api-key: --llm, --secure, positional token. */
async function parseTokenArgs(
  args: string[],
  modeFlag: string,
): Promise<{ provider: string; token: string } | never> {
  const llmIdx = args.indexOf('--llm');
  const llmArg = llmIdx !== -1 && llmIdx + 1 < args.length ? args[llmIdx + 1] : null;

  const secureIdx = args.indexOf('--secure');
  const secureName = secureIdx !== -1 && secureIdx + 1 < args.length ? args[secureIdx + 1] : null;

  const skipNext = new Set<number>();
  for (const flag of ['--llm', '--secure']) {
    const idx = args.indexOf(flag);
    if (idx !== -1) { skipNext.add(idx); skipNext.add(idx + 1); }
  }
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (skipNext.has(i)) continue;
    if (args[i] === modeFlag) continue;
    if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option "${args[i]}".`);
      console.error(`Usage: apra-fleet auth ${modeFlag} [--llm <provider>] [<token> | secure.<name> | --secure <name>]`);
      process.exit(1);
    }
    positionals.push(args[i]);
  }

  // Provider
  let provider = llmArg;
  if (!provider) {
    const { readInstallConfig } = await import('./config.js');
    const config = readInstallConfig();
    const installed = Object.keys(config.providers);
    provider = installed.length === 1 ? installed[0] : 'claude';
  }
  const validProviders = Object.keys(PROVIDER_AUTH_ENV);
  if (!validProviders.includes(provider)) {
    console.error(`Error: Unknown provider "${provider}". Valid: ${validProviders.join(', ')}`);
    process.exit(1);
  }

  // Token
  const rawOrRef = positionals[0] ?? null;
  const storeRef = secureName ?? (rawOrRef?.startsWith('secure.') ? rawOrRef.slice('secure.'.length) : null);

  let token: string;
  if (storeRef) {
    const { credentialResolve } = await import('blindfold');
    const entry = credentialResolve(storeRef, '*');
    if (!entry) {
      console.error(`✗ Credential "${storeRef}" not found in persistent store.`);
      console.error(`  Run: apra-fleet secret --set ${storeRef} --persist`);
      process.exit(1);
      throw new Error(); // unreachable, satisfies TS
    }
    if ('denied' in entry) { console.error(`✗ ${entry.denied}`); process.exit(1); throw new Error(); }
    if ('expired' in entry) { console.error(`✗ ${entry.expired}`); process.exit(1); throw new Error(); }
    token = entry.plaintext;
  } else if (rawOrRef) {
    token = rawOrRef;
  } else {
    console.error('✗ No token provided.');
    console.error(`Usage: apra-fleet auth ${modeFlag} [--llm <provider>] [<token> | secure.<name> | --secure <name>]`);
    process.exit(1);
    throw new Error(); // unreachable
  }

  return { provider, token };
}

// ---------------------------------------------------------------------------
// --oauth: write token to provider credential file
// ---------------------------------------------------------------------------

interface OAuthCredentialPatch {
  credentialPath: string;
  patch: Record<string, unknown>;
}

function getOAuthCredentialPatch(provider: string, token: string): OAuthCredentialPatch | null {
  switch (provider) {
    case 'claude':
      return {
        credentialPath: path.join(os.homedir(), '.claude', '.credentials.json'),
        patch: { claudeAiOauth: { accessToken: token } },
      };
    default:
      return null;
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      const tv = (target[key] as Record<string, unknown> | undefined) ?? {};
      target[key] = deepMerge(tv, sv as Record<string, unknown>);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

async function handleOAuth(args: string[]): Promise<void> {
  const { provider, token } = await parseTokenArgs(args, '--oauth');

  const credPatch = getOAuthCredentialPatch(provider, token);
  if (!credPatch) {
    console.error(`✗ Provider "${provider}" does not support OAuth token provisioning.`);
    console.error(`  Gemini and other API-key-only providers: use apra-fleet auth --api-key instead.`);
    process.exit(1);
    return;
  }

  try {
    fs.mkdirSync(path.dirname(credPatch.credentialPath), { recursive: true });

    let current: Record<string, unknown> = {};
    if (fs.existsSync(credPatch.credentialPath)) {
      try {
        current = JSON.parse(fs.readFileSync(credPatch.credentialPath, 'utf-8')) as Record<string, unknown>;
      } catch { /* overwrite corrupt file */ }
    }

    const merged = deepMerge(current, credPatch.patch);
    fs.writeFileSync(credPatch.credentialPath, JSON.stringify(merged, null, 2), { mode: 0o600 });

    console.log(`✓ OAuth token written for ${provider}`);
    console.log(`  File: ${credPatch.credentialPath}`);
  } catch (err: any) {
    console.error(`✗ Failed to write credentials: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// --api-key: set provider API key in shell profiles / system env
// ---------------------------------------------------------------------------

function setApiKeyInProfiles(envVarName: string, value: string): void {
  if (process.platform === 'win32') {
    // Windows: set as user-level persistent environment variable
    const escaped = value.replace(/'/g, "''"); // PowerShell single-quote escape
    execSync(`powershell -Command "[Environment]::SetEnvironmentVariable('${envVarName}', '${escaped}', 'User')"`, { stdio: 'pipe' });
    return;
  }

  // Linux / macOS: append to shell profiles
  const home = os.homedir();
  const profiles = process.platform === 'darwin'
    ? ['.bashrc', '.zshrc', '.profile'].map(f => path.join(home, f))
    : ['.bashrc', '.profile'].map(f => path.join(home, f));

  // Escape value for use inside double-quoted bash string
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
  const exportLine = `export ${envVarName}="${escaped}"`;

  for (const profile of profiles) {
    try {
      let content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
      // Remove any existing export for this var
      content = content.split('\n').filter(l => !l.match(new RegExp(`^export ${envVarName}=`))).join('\n');
      if (!content.endsWith('\n') && content.length > 0) content += '\n';
      content += `${exportLine}\n`;
      fs.writeFileSync(profile, content);
    } catch { /* best effort per profile */ }
  }
}

async function handleApiKey(args: string[]): Promise<void> {
  const { provider, token } = await parseTokenArgs(args, '--api-key');

  const envVarName = PROVIDER_AUTH_ENV[provider];

  try {
    setApiKeyInProfiles(envVarName, token);
    if (process.platform === 'win32') {
      console.log(`✓ API key set for ${provider}`);
      console.log(`  Env var: ${envVarName} (user-level, persistent)`);
    } else {
      const profiles = process.platform === 'darwin'
        ? ['~/.bashrc', '~/.zshrc', '~/.profile']
        : ['~/.bashrc', '~/.profile'];
      console.log(`✓ API key set for ${provider}`);
      console.log(`  Env var: ${envVarName}`);
      console.log(`  Profiles updated: ${profiles.join(', ')}`);
    }
  } catch (err: any) {
    console.error(`✗ Failed to set API key: ${err.message}`);
    process.exit(1);
  }
}
