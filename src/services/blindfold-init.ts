import { initBlindfold, type Logger } from 'blindfold';
import path from 'node:path';
import os from 'node:os';

const fleetLogger: Logger = {
  info: (tag, msg) => { try { process.stderr.write(`[fleet] blindfold [${tag}] ${msg}\n`); } catch {} },
  warn: (tag, msg) => { try { process.stderr.write(`[fleet:warn] blindfold [${tag}] ${msg}\n`); } catch {} },
  error: (tag, msg) => { try { process.stderr.write(`[fleet:error] blindfold [${tag}] ${msg}\n`); } catch {} },
};

let initialized = false;

export function initFleetBlindfold(): void {
  if (initialized) return;
  initBlindfold({
    dataDir: process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data'),
    productName: 'apra-fleet',
    pipeName: 'apra-fleet-auth',
    logger: fleetLogger,
  });
  initialized = true;
}
