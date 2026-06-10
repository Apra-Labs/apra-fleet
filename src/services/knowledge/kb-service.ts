import { SqliteProvider } from './sqlite-provider.js';
import type { MemoryProvider, ProviderConfig } from './types.js';

export class KBService {
  private provider: MemoryProvider;

  constructor(config?: ProviderConfig) {
    this.provider = new SqliteProvider();
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
