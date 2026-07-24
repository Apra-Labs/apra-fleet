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
    // Close the transport BEFORE deleting the singleton pointer, not after --
    // a caller polling checkRunningInstance() (server.json gone => not
    // running) must never see "stopped" while the process is still up
    // because close() failed partway through. Deleting first turned that
    // exact failure into a false-positive "verified stopped" for any client
    // race-handling this response (apra-fleet-client's shutdownServer()).
    await httpHandle.close();
    try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
  }
  closeAllConnections();
  setTimeout(() => process.exit(0), 100);
  return 'Server shutting down. Run /mcp to start a fresh instance.';
}
