import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import type { LlmProvider, CodeIntelProvider } from '../types.js';

export type ModelTier = 'cheap' | 'standard' | 'premium';

export interface UserConfig {
  providers?: Partial<Record<LlmProvider, {
    modelMapping?: Partial<Record<ModelTier, string>>;
  }>>;
  logging?: {
    /** How many characters of a command/prompt to keep on its fleet-log line. */
    previewChars?: number;
  };
  codeIntelProvider?: CodeIntelProvider;
}

/**
 * Default length of the command/prompt preview kept on a fleet-log line. The
 * line exists to identify which dispatch it is, not to preserve the full text
 * (which would bloat the log and persist unmasked data on disk); `watch` reads
 * the full prompt from the session transcript instead. Override via
 * `logging.previewChars` in config.json.
 */
export const DEFAULT_LOG_PREVIEW_CHARS = 256;

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

  if (obj.logging && typeof obj.logging === 'object' && !Array.isArray(obj.logging)) {
    const logging = obj.logging as Record<string, unknown>;
    const preview = logging.previewChars;
    if (typeof preview === 'number' && Number.isFinite(preview) && preview >= 0) {
      result.logging = { previewChars: Math.floor(preview) };
    } else if (preview !== undefined) {
      console.error('[fleet] user config: logging.previewChars must be a non-negative number, ignoring');
    }
  }

  const VALID_CODE_INTEL = new Set(['codebase-memory', 'gitnexus', 'none']);
  if (typeof obj.codeIntelProvider === 'string' && VALID_CODE_INTEL.has(obj.codeIntelProvider)) {
    result.codeIntelProvider = obj.codeIntelProvider as CodeIntelProvider;
  } else if (obj.codeIntelProvider !== undefined) {
    console.error('[fleet] user config: invalid codeIntelProvider, ignoring');
  }

  cached = result;
  return cached;
}

export function getModelOverride(provider: LlmProvider, tier: ModelTier): string | undefined {
  const config = loadUserConfig();
  return config.providers?.[provider]?.modelMapping?.[tier];
}

/** Characters of command/prompt text to keep on a fleet-log line (config-driven). */
export function getLogPreviewChars(): number {
  return loadUserConfig().logging?.previewChars ?? DEFAULT_LOG_PREVIEW_CHARS;
}

/** Global code-intelligence provider from config.json (undefined = not configured). */
export function getGlobalCodeIntelProvider(): CodeIntelProvider | undefined {
  return loadUserConfig().codeIntelProvider;
}

/** Reset the cached config -- for testing only. */
export function _resetCache(): void {
  cached = undefined;
}
