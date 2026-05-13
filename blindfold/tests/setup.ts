import path from 'node:path';
import os from 'node:os';

process.env.NODE_ENV = 'test';
process.env.BLINDFOLD_DATA_DIR = path.join(os.tmpdir(), `blindfold-test-${process.pid}`);
