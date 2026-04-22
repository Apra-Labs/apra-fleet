import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { loadPrivateKey, verifyAppConnectivity } from '../services/github-app.js';
import { setGitHubApp } from '../services/git-config.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';
import { credentialResolve } from '../services/credential-store.js';
import { FLEET_DIR } from '../paths.js';
const STORED_KEY_PATH = path.join(FLEET_DIR, 'github-app.pem');
const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_]{1,64})\}\}/;

export const setupGitAppSchema = z.object({
  app_id: z.string().regex(/^\d+$/, 'App ID must be numeric').describe('The GitHub App ID (numeric string)'),
  private_key_path: z.string().describe('Path to the GitHub App private key (.pem) file. Supports {{secure.NAME}} token — if the resolved value starts with -----BEGIN it is treated as PEM key content directly (no file needed).'),
  installation_id: z.number().describe('The GitHub App installation ID for your organization'),
});

export type SetupGitAppInput = z.infer<typeof setupGitAppSchema>;

export async function setupGitApp(input: SetupGitAppInput): Promise<string> {
  // Resolve {{secure.NAME}} token in private_key_path if present
  let keyPath = input.private_key_path;
  let tempKeyPath: string | undefined;
  const tokenMatch = TOKEN_RE.exec(input.private_key_path);
  if (tokenMatch) {
    const entry = credentialResolve(tokenMatch[1]);
    if (!entry) return `❌ Credential "${tokenMatch[1]}" not found. Run credential_store_set first.`;
    const resolved = entry.plaintext;
    if (resolved.startsWith('-----BEGIN')) {
      tempKeyPath = path.join(os.tmpdir(), `apra-fleet-gitapp-${crypto.randomBytes(8).toString('hex')}.pem`);
      fs.writeFileSync(tempKeyPath, resolved, { mode: 0o600 });
      keyPath = tempKeyPath;
    } else {
      keyPath = resolved;
    }
  }

  try {
    // Validate and read private key
    let privateKey: string;
    try {
      privateKey = loadPrivateKey(keyPath);
    } catch (err: any) {
      return `❌ ${err.message}`;
    }

    // Verify connectivity before storing anything
    let result: Awaited<ReturnType<typeof verifyAppConnectivity>>;
    try {
      result = await verifyAppConnectivity(input.app_id, privateKey, input.installation_id);
    } catch (err: any) {
      return `❌ GitHub API verification failed: ${err.message}`;
    }

    if (!result.ok) {
      return `❌ GitHub App verification failed: ${result.error}`;
    }

    // Copy PEM to fleet dir
    if (!fs.existsSync(FLEET_DIR)) {
      fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(STORED_KEY_PATH, privateKey + '\n', { mode: 0o600 });
    enforceOwnerOnly(STORED_KEY_PATH);

    // Store config
    setGitHubApp({
      appId: input.app_id,
      privateKeyPath: STORED_KEY_PATH,
      installationId: input.installation_id,
      createdAt: new Date().toISOString(),
    });

    return `✅ GitHub App configured successfully\n`
      + `  App: ${result.appName} (ID: ${input.app_id})\n`
      + `  Org: ${result.orgName}\n`
      + `  Installation: ${input.installation_id}\n`
      + `  Private key stored: ${STORED_KEY_PATH}`;
  } finally {
    if (tempKeyPath) {
      try { fs.unlinkSync(tempKeyPath); } catch { /* best effort */ }
    }
  }
}
