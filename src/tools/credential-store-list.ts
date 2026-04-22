import { z } from 'zod';
import { credentialList } from '../services/credential-store.js';

export const credentialStoreListSchema = z.object({});

export async function credentialStoreList(): Promise<string> {
  const entries = credentialList();
  return JSON.stringify(entries, null, 2);
}
