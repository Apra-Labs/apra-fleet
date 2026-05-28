import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import type { LlmProvider } from '../types.js';

export type ModelTier = 'cheap' | 'standard' | 'premium';

export interface UserConfig {
  providers?: Partial<Record<LlmProvider, {
    modelMapping?: Partial<Record<ModelTier, string>>;
  }>>;
}

const VALID_PROVIDERS = new Set<string>(['claude', 'gemini', 'codex', 'copilot', 'agy']);
const VALID_TIERS = new Set<string>(['cheap', 'standard', 'premium']);

let cached: UserConfig | undefined;

export function loadUserConfig(): UserConfig {
  if (cached !== undefined) return cached;

  const configPath = path.join(FLEET_DIR, 'config.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    cached = {};
    return cached;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[fleet] user config malformed, ignoring');
    cached = {};
    return cached;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('[fleet] user config malformed, ignoring');
    cached = {};
    return cached;
  }

  const obj = parsed as Record<string, unknown>;
  const result: UserConfig = {};

  if (obj.providers && typeof obj.providers === 'object' && !Array.isArray(obj.providers)) {
    const providers = obj.providers as Record<string, unknown>;
    result.providers = {};

    for (const [provKey, provVal] of Object.entries(providers)) {
      if (!VALID_PROVIDERS.has(provKey)) {
        console.error(`[fleet] user config: unknown provider "${provKey}", skipping`);
        continue;
      }
      if (typeof provVal !== 'object' || provVal === null || Array.isArray(provVal)) continue;

      const provObj = provVal as Record<string, unknown>;
      if (provObj.modelMapping && typeof provObj.modelMapping === 'object' && !Array.isArray(provObj.modelMapping)) {
        const mapping = provObj.modelMapping as Record<string, unknown>;
        const validMapping: Partial<Record<ModelTier, string>> = {};

        for (const [tierKey, tierVal] of Object.entries(mapping)) {
          if (!VALID_TIERS.has(tierKey)) {
            console.error(`[fleet] user config: unknown tier "${tierKey}" in provider "${provKey}", skipping`);
            continue;
          }
          if (typeof tierVal === 'string') {
            validMapping[tierKey as ModelTier] = tierVal;
          }
        }

        (result.providers as Record<string, { modelMapping?: Partial<Record<ModelTier, string>> }>)[provKey] = { modelMapping: validMapping };
      }
    }
  }

  cached = result;
  return cached;
}

export function getModelOverride(provider: LlmProvider, tier: ModelTier): string | undefined {
  const config = loadUserConfig();
  return config.providers?.[provider]?.modelMapping?.[tier];
}

/** Reset the cached config -- for testing only. */
export function _resetCache(): void {
  cached = undefined;
}
