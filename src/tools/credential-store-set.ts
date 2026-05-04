import { z } from 'zod';
import { collectOobApiKey, hasPendingAuth, getPendingPassword, createPendingAuth, ensureAuthSocket, getSocketPath, launchAuthTerminal } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { credentialSet } from '../services/credential-store.js';
import { logLine } from '../utils/log-helpers.js';

export const credentialStoreSetSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]{1,64}$/).describe('Credential name (alphanumeric and underscores, max 64 chars)'),
  prompt: z.string().describe('Prompt to display to the user when collecting the secret'),
  persist: z.boolean().default(false).describe('If true, encrypt and persist the credential across server restarts'),
  network_policy: z.enum(['allow', 'confirm', 'deny']).default('confirm').describe(
    'Network egress policy: "allow" = always proceed, "confirm" = prompt before network commands, "deny" = block network commands'
  ),
  members: z.string().default('*').describe(
    'Comma-separated list of member friendly names allowed to use this credential, or "*" for all members (default: "*")'
  ),
  ttl_seconds: z.number().positive().optional().describe(
    'Time-to-live in seconds. If set, the credential expires after this many seconds and is automatically purged.'
  ),
});

export type CredentialStoreSetInput = z.infer<typeof credentialStoreSetSchema>;

export async function credentialStoreSet(input: CredentialStoreSetInput): Promise<string> {
  // Check if password has already arrived from a previous call
  if (hasPendingAuth(input.name)) {
    const encPw = getPendingPassword(input.name);
    if (encPw) {
      const plaintext = decryptPassword(encPw);
      const allowedMembers: string[] | '*' = input.members === '*'
        ? '*'
        : input.members.split(',').map(s => s.trim()).filter(Boolean);
      const meta = credentialSet(input.name, plaintext, input.persist, input.network_policy, allowedMembers, input.ttl_seconds);
      return JSON.stringify({ handle: `sec://${meta.name}`, scope: meta.scope });
    }
  }

  // No password arrived yet, so check if we should set up a fresh pending request
  if (!hasPendingAuth(input.name)) {
    await ensureAuthSocket();
    createPendingAuth(input.name);
    const waitingMsg = `Waiting for secret ${input.name}. Run: apra-fleet secret --set ${input.name}`;
    logLine('credential_store_set', waitingMsg);
    launchAuthTerminal(input.name, ['--api-key'], (_exitCode) => {
      // On terminal exit, no action needed — password will be collected via socket or not
    });
    return waitingMsg;
  }

  // Pending auth exists but no password yet — return waiting message
  return `Waiting for secret ${input.name}. Run: apra-fleet secret --set ${input.name}`;
}
