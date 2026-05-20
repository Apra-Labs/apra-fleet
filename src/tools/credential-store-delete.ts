import { z } from 'zod';
import { credentialDelete } from 'blindfold';
import { logLine } from '../utils/log-helpers.js';

export const credentialStoreDeleteSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe('Name of the credential to delete'),
});

export type CredentialStoreDeleteInput = z.infer<typeof credentialStoreDeleteSchema>;

export async function credentialStoreDelete(input: CredentialStoreDeleteInput): Promise<string> {
  const deleted = credentialDelete(input.name);
  if (deleted) {
    logLine('credential_store_delete', `name=${input.name}`);
    return `✅ Credential "${input.name}" deleted.`;
  }
  return `❌ Credential "${input.name}" not found.`;
}
