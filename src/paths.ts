import path from 'node:path';
import os from 'node:os';

export const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');

export const APRA_BASE = path.join(os.homedir(), '.apra-fleet');
export const WORKSPACES_DIR = path.join(APRA_BASE, 'workspaces');
export const WORKSPACES_INDEX = path.join(APRA_BASE, 'workspaces.json');
