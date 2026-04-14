import { z } from 'zod';
import { collectOobApiKey } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { credentialSet } from '../services/credential-store.js';

export const credentialStoreSetSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]{1,64}$/).describe('Credential name (alphanumeric and underscores, max 64 chars)'),
  prompt: z.string().describe('Prompt to display to the user when collecting the secret'),
  persist: z.boolean().default(false).describe('If true, encrypt and persist the credential across server restarts'),
  network_policy: z.enum(['allow', 'confirm', 'deny']).default('confirm').describe(
    'Network egress policy: "allow" = always proceed, "confirm" = prompt before network commands, "deny" = block network commands'
  ),
});

export type CredentialStoreSetInput = z.infer<typeof credentialStoreSetSchema>;

export async function credentialStoreSet(input: CredentialStoreSetInput): Promise<string> {
  const oob = await collectOobApiKey(input.name, 'credential_store_set');
  if (oob.fallback) return oob.fallback;
  if (!oob.password) return '❌ No credential received.';

  const plaintext = decryptPassword(oob.password);
  const meta = credentialSet(input.name, plaintext, input.persist, input.network_policy);

  return JSON.stringify({ handle: `sec://${meta.name}`, scope: meta.scope });
}
