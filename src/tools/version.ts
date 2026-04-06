import { z } from 'zod';
import { serverVersion } from '../version.js';

export const versionSchema = z.object({});

export async function version(): Promise<string> {
  return `apra-fleet ${serverVersion}`;
}
