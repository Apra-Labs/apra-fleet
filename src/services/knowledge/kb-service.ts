import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../paths.js';
import { SqliteProvider } from './sqlite-provider.js';
import { HttpKbProvider } from './http-provider.js';
import { decryptPassword } from '../../utils/crypto.js';
import type { MemoryProvider, ProviderConfig } from './types.js';

export { computeFileHash, computeFileHashBatch, checkStaleness } from './file-hash.js';
export type { FileHashResult } from './file-hash.js';

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

function readKbConfigFromDisk(): Record<string, string> {
  try {
    if (fs.existsSync(KB_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')) as Record<string, string>;
    }
  } catch { /* fall through */ }
  return {};
}

export class KBService {
  private provider: MemoryProvider;

  constructor(config?: ProviderConfig) {
    const diskConfig = readKbConfigFromDisk();
    const effectiveProvider = config?.provider ?? diskConfig.provider ?? 'sqlite';

    if (effectiveProvider === 'http') {
      const url = config?.url ?? diskConfig.url ?? '';
      let token = '';
      if (diskConfig.token_encrypted) {
        try { token = decryptPassword(diskConfig.token_encrypted); } catch { /* empty token */ }
      }
      this.provider = new HttpKbProvider(url, token);
    } else {
      this.provider = new SqliteProvider(config?.dbPath);
    }
  }

  getProvider(): MemoryProvider {
    return this.provider;
  }
}

let _instance: KBService | null = null;

export function getKBService(config?: ProviderConfig): KBService {
  if (!_instance) {
    _instance = new KBService(config);
  }
  return _instance;
}

export function resetKBService(): void {
  _instance = null;
}
