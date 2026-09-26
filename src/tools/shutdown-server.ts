import { z } from 'zod';
import fs from 'node:fs';
import { closeAllConnections } from '../services/ssh.js';
import type { HttpTransportHandle } from '../services/http-transport.js';
import { SERVER_INFO_PATH } from '../paths.js';

export const shutdownServerSchema = z.object({});

let httpHandle: HttpTransportHandle | null = null;

// Tracked so a test (or any other caller that needs to tear down cleanly
// before the deferred exit fires) can cancel it via cancelScheduledExit().
// Without this, under load a test run can outlive the 100ms delay: the timer
// fires after the owning test file has finished and its process.exit spy has
// been restored, so it calls the REAL process.exit and vitest reports an
// uncaught exception even though every assertion passed.
let pendingExitTimer: NodeJS.Timeout | undefined;

export function setHttpHandle(handle: HttpTransportHandle): void {
  httpHandle = handle;
}

export function scheduleProcessExit(delayMs = 100): void {
  if (pendingExitTimer) {
    clearTimeout(pendingExitTimer);
  }
  pendingExitTimer = setTimeout(() => {
    pendingExitTimer = undefined;
    process.exit(0);
  }, delayMs);
}

export function cancelScheduledExit(): void {
  if (pendingExitTimer) {
    clearTimeout(pendingExitTimer);
    pendingExitTimer = undefined;
  }
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
  scheduleProcessExit();
  return 'Server shutting down. Run /mcp to start a fresh instance.';
}
