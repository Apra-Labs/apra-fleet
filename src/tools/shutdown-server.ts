import { z } from 'zod';
import fs from 'node:fs';
import { closeAllConnections } from '../services/ssh.js';
import type { HttpTransportHandle } from '../services/http-transport.js';
import { SERVER_INFO_PATH } from '../paths.js';

export const shutdownServerSchema = z.object({});

let httpHandle: HttpTransportHandle | null = null;

export function setHttpHandle(handle: HttpTransportHandle): void {
  httpHandle = handle;
}

export async function shutdownServer(): Promise<string> {
  if (httpHandle) {
    try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
    await httpHandle.close();
  }
  closeAllConnections();
  setTimeout(() => process.exit(0), 100);
  return 'Server shutting down. Run /mcp to start a fresh instance.';
}
