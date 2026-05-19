import path from 'node:path';
import os from 'node:os';

export const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');

export const DEFAULT_PORT = parseInt(process.env.APRA_FLEET_PORT ?? '', 10) || 7523;
