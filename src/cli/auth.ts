import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

/** Provider -> auth env var name */
const PROVIDER_AUTH_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  codex: 'OPENAI_API_KEY',
  copilot: 'COPILOT_GITHUB_TOKEN',
  agy: 'ANTIGRAVITY_API_KEY',
};

export async function runAuth(args: string[]): Promise<void> {
  if (args.includes('--oauth')) {
    return handleOAuth(args);
  }
  if (args.includes('--api-key')) {
    return handleApiKey(args);
  }

  console.error('Usage:');
  console.error('  apra-fleet auth --oauth [--llm <provider>] [<token> | secure.<name> | --secure <name>]');
  console.error('  apra-fleet auth --api-key [--llm <provider>] [<token> | secure.<name> | --secure <name>]');
  process.exit(1);
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
    const { credentialResolve } = await import('../services/credential-store.js');
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
        patch: { claudeAiOauth: parseClaudeOAuthSecret(token) },
      };
    default:
      return null;
  }
}

// The secret may be either a bare access token or a full claudeAiOauth JSON
// object (accessToken, refreshToken, expiresAt, scopes, ...). A bare token
// yields a credentials file the Claude CLI rejects as "Not logged in"
// unless the synthesized session shape below is written -- so callers that
// have the full object (e.g. the integ smoke test seeding from the runner's
// real credentials file) must be able to pass it through intact.
//
// apra-fleet-eft.48.3 (regression follow-up to apra-fleet-eft.48 /
// stabilization Issue 43): when only a bare token is available (no full
// session object -- e.g. the playbook's CLAUDE_CODE_OAUTH_TOKEN fallback
// when no real ~/.claude/.credentials.json exists to seed from), synthesize
// the minimally-sufficient additional field(s) below so the written file is
// still CLI-acceptable, rather than silently writing an accessToken-only
// file that reproduces "Not logged in - Please run /login".
export function parseClaudeOAuthSecret(secret: string): Record<string, unknown> {
  const trimmed = secret.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.accessToken === 'string') {
        return parsed as Record<string, unknown>;
      }
    } catch { /* fall through to bare-token handling */ }
  }
  return { accessToken: secret, ...bareTokenSyntheticSessionFields() };
}

// A bare token carries no real expiry/refresh/scope information, so this
// cannot fabricate those -- it synthesizes only the fields the installed
// Claude CLI needs to treat the file as a valid logged-in session. This is
// a local session-shape marker only: it does not affect whether the actual
// (real, caller-supplied) access token is accepted by the network -- that
// still depends entirely on the token's own real validity. Callers that
// have the real expiresAt/refreshToken/scopes/subscriptionType should pass
// the full JSON blob instead (see the branch above), which preserves the
// genuine values intact rather than synthesizing this fallback.
//
// apra-fleet-eft.48.6 (regression follow-up to apra-fleet-eft.48.3, whose
// expiresAt-only synthesis STILL reproduced "Not logged in"): empirically
// (clean-env `env -i HOME=$SANDBOX ... claude -p ...` repro against the
// installed claude CLI 2.1.212), the deciding field the CLI checks is
// `scopes` -- it only treats the credentials file as logged-in when
// `claudeAiOauth.scopes` contains `user:inference`. accessToken+expiresAt
// alone is rejected; adding the `user:inference` scope reaches past auth
// (to a model-not-found error), matching the passing env-var control in
// apra-fleet-eft.48's notes. expiresAt is retained so the synthesized
// session also carries a far-future, non-expired timestamp.
const BARE_TOKEN_SYNTHETIC_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// The scope the installed Claude CLI requires to accept an OAuth
// credentials file as a valid logged-in session (see comment above).
const BARE_TOKEN_SYNTHETIC_SCOPES = ['user:inference', 'user:profile'];

function bareTokenSyntheticSessionFields(): Record<string, unknown> {
  return {
    expiresAt: Date.now() + BARE_TOKEN_SYNTHETIC_SESSION_TTL_MS,
    scopes: [...BARE_TOKEN_SYNTHETIC_SCOPES],
  };
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
