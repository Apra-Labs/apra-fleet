import { z } from 'zod';
import { credentialDelete, isLiveSecret, SecretInUseError } from '../services/credential-store.js';
import { logLine } from '../utils/log-helpers.js';

export const credentialStoreDeleteSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe('Name of the credential to delete'),
});

export type CredentialStoreDeleteInput = z.infer<typeof credentialStoreDeleteSchema>;

export async function credentialStoreDelete(input: CredentialStoreDeleteInput): Promise<string> {
  if (isLiveSecret(input.name)) {
    return `[x] '${input.name}' is a live secret and cannot be deleted through this tool. Use the CLI: apra-fleet secret --delete ${input.name}.`;
  }
  let deleted: boolean;
  try {
    deleted = credentialDelete(input.name);
  } catch (err) {
    if (!(err instanceof SecretInUseError)) throw err;
    return `[x] '${input.name}' was not deleted: ${err.message}. Delete those live secrets first: apra-fleet secret --delete <live secret>.`;
  }
  if (deleted) {
    logLine('credential_store_delete', `name=${input.name}`);
    return `✅ Credential "${input.name}" deleted.`;
  }
  return `❌ Credential "${input.name}" not found.`;
}
