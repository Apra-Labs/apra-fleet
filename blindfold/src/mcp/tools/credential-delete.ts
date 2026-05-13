import { z } from 'zod';
import { credentialDelete } from '../../credential-store.js';
import { getLogger } from '../../config.js';

export const credentialDeleteSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe('Name of the credential to delete'),
});

export type CredentialDeleteInput = z.infer<typeof credentialDeleteSchema>;

export async function credentialDeleteHandler(input: CredentialDeleteInput): Promise<string> {
  const deleted = credentialDelete(input.name);
  if (deleted) {
    getLogger().info('credential_delete', `name=${input.name}`);
    return `Credential "${input.name}" deleted.`;
  }
  return `Credential "${input.name}" not found.`;
}
