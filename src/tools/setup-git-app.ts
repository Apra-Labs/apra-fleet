import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPrivateKey, verifyAppConnectivity } from '../services/github-app.js';
import { setGitHubApp } from '../services/git-config.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
const STORED_KEY_PATH = path.join(FLEET_DIR, 'github-app.pem');

export const setupGitAppSchema = z.object({
  app_id: z.string().describe('The GitHub App ID (numeric string)'),
  private_key_path: z.string().describe('Path to the GitHub App private key (.pem) file'),
  installation_id: z.number().describe('The GitHub App installation ID for your organization'),
});

export type SetupGitAppInput = z.infer<typeof setupGitAppSchema>;

export async function setupGitApp(input: SetupGitAppInput): Promise<string> {
  // Validate and read private key
  let privateKey: string;
  try {
    privateKey = loadPrivateKey(input.private_key_path);
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
}
