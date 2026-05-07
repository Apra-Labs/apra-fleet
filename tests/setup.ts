import path from 'node:path';
import os from 'node:os';

process.env.APRA_FLEET_DATA_DIR = path.join(os.tmpdir(), 'apra-fleet-test-data');
