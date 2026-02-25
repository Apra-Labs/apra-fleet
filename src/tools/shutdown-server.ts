import { z } from 'zod';
import { closeAllConnections } from '../services/ssh.js';

export const shutdownServerSchema = z.object({});

export async function shutdownServer(): Promise<string> {
  closeAllConnections();
  setTimeout(() => process.exit(0), 100);
  return 'Server shutting down. Run /mcp to start a fresh instance.';
}
