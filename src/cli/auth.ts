import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import readline from 'node:readline';
import { getSocketPath } from '../services/auth-socket.js';

export async function runAuth(args: string[]): Promise<void> {
  if (args.includes('--oauth')) {
    return handleOAuth(args);
  }

  const isConfirm = args.includes('--confirm');
  const memberName = args.find((a) => !a.startsWith('--'));

  if (!memberName) {
    console.error('Usage: apra-fleet auth --confirm <member-name>');
    process.exit(1);
  }

  if (!isConfirm) {
    console.error('Usage: apra-fleet auth --confirm <member-name>');
    process.exit(1);
  }

  // Reject unknown flags before prompting for user input
  const knownFlagExact = new Set(['--confirm']);
  for (const a of args) {
    if (!a.startsWith('-')) continue; // positional (member name)
    if (knownFlagExact.has(a)) continue;
    console.error(`Error: Unknown option "${a}". Usage: apra-fleet auth --confirm <member-name>`);
    process.exit(1);
  }

  console.error(`\napra-fleet — Network Egress Confirmation\n`);
  console.error(`  Credential: ${memberName}\n`);
  console.error(`  A command using this credential is about to access the network.\n`);

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
    console.error('  ✗ Confirmation not received. Aborting.');
    process.exit(1);
    return;
  }

  const sockPath = getSocketPath();

  await new Promise<void>((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: memberName, password: inputValue }) + '\n';
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
          console.error('\n  ✓ Confirmed. You can close this window.\n');
          resolve();
        } else {
          console.error(`\n  ✗ Error: ${resp.error}\n`);
          reject(new Error(resp.error));
        }
      } catch {
        console.error('\n  ✗ Invalid response from server.\n');
        reject(new Error('Invalid server response'));
      }
      client.end();
    });

    client.on('error', (err) => {
      console.error(`\n  ✗ Could not connect to apra-fleet server.`);
      console.error(`    Is the MCP server running?\n`);
      reject(err);
    });
  }).catch(() => {
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// OAuth token provisioning — writes directly to the provider's credential file
// on this machine. Designed for CI runners and automated setup.
//
// Usage:
//   apra-fleet auth --oauth [--llm <provider>] <token>
//   apra-fleet auth --oauth [--llm <provider>] secure.<name>
//   apra-fleet auth --oauth [--llm <provider>] --secure <name>
//
// <provider> defaults to the single installed provider, or 'claude' if ambiguous.
// secure.<name> / --secure <name> resolve from the persistent credential store.
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
  // Parse --llm <provider>
  const llmIdx = args.indexOf('--llm');
  const llmArg = llmIdx !== -1 && llmIdx + 1 < args.length ? args[llmIdx + 1] : null;

  // Parse --secure <name>
  const secureIdx = args.indexOf('--secure');
  const secureName = secureIdx !== -1 && secureIdx + 1 < args.length ? args[secureIdx + 1] : null;

  // Collect positional args (skip flags and their values)
  const skipNext = new Set<number>();
  for (const flagName of ['--llm', '--secure']) {
    const idx = args.indexOf(flagName);
    if (idx !== -1) { skipNext.add(idx); skipNext.add(idx + 1); }
  }
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (skipNext.has(i)) continue;
    if (args[i] === '--oauth') continue;
    if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option "${args[i]}".`);
      console.error('Usage: apra-fleet auth --oauth [--llm <provider>] [<token> | secure.<name> | --secure <name>]');
      process.exit(1);
    }
    positionals.push(args[i]);
  }

  // Determine provider
  let provider = llmArg ?? null;
  if (!provider) {
    const { readInstallConfig } = await import('./config.js');
    const config = readInstallConfig();
    const installed = Object.keys(config.providers);
    provider = installed.length === 1 ? installed[0] : 'claude';
  }

  const validProviders = ['claude', 'gemini', 'codex', 'copilot'];
  if (!validProviders.includes(provider)) {
    console.error(`Error: Unknown provider "${provider}". Valid: ${validProviders.join(', ')}`);
    process.exit(1);
  }

  // Resolve token
  let token: string;
  const rawOrRef = positionals[0] ?? null;

  // Determine if we need to look up from credential store
  const storeRef = secureName ?? (rawOrRef?.startsWith('secure.') ? rawOrRef.slice('secure.'.length) : null);

  if (storeRef) {
    const { credentialResolve } = await import('../services/credential-store.js');
    const entry = credentialResolve(storeRef, '*');
    if (!entry) {
      console.error(`✗ Credential "${storeRef}" not found in persistent store.`);
      console.error(`  Run: apra-fleet secret --set ${storeRef} --persist`);
      process.exit(1);
      return;
    }
    if ('denied' in entry) { console.error(`✗ ${entry.denied}`); process.exit(1); return; }
    if ('expired' in entry) { console.error(`✗ ${entry.expired}`); process.exit(1); return; }
    token = entry.plaintext;
  } else if (rawOrRef) {
    token = rawOrRef;
  } else {
    console.error('✗ No token provided.');
    console.error('Usage: apra-fleet auth --oauth [--llm <provider>] [<token> | secure.<name> | --secure <name>]');
    process.exit(1);
    return;
  }

  // Get provider-specific credential file and JSON patch
  const credPatch = getOAuthCredentialPatch(provider, token);
  if (!credPatch) {
    console.error(`✗ Provider "${provider}" does not support OAuth token provisioning yet.`);
    process.exit(1);
    return;
  }

  // Deep-merge patch into existing credential file (create if absent)
  try {
    fs.mkdirSync(path.dirname(credPatch.credentialPath), { recursive: true });

    let current: Record<string, unknown> = {};
    if (fs.existsSync(credPatch.credentialPath)) {
      try {
        current = JSON.parse(fs.readFileSync(credPatch.credentialPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        // Overwrite corrupt file
      }
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
