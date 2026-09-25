import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import type { LlmProvider } from '../types.js';

export type ModelTier = 'cheap' | 'standard' | 'premium';

/** A statically declared workflow package (apra-fleet-iywi.3 / F13). See
 *  src/services/workflow-packages.ts for how this merges with
 *  runtime-registered packages. */
export interface WorkflowPackageConfigEntry {
  id: string;
  baseUrl: string;
}

export interface UserConfig {
  providers?: Partial<Record<LlmProvider, {
    modelMapping?: Partial<Record<ModelTier, string>>;
  }>>;
  logging?: {
    /** How many characters of a command/prompt to keep on its fleet-log line. */
    previewChars?: number;
  };
  /** Context-headroom admission control overrides (apra-fleet-eft.81.1).
   *  See src/services/context-admission.ts for the fleet defaults and the
   *  three-band decision this config tunes. */
  contextAdmission?: {
    /** S/M/L -> token estimate, for execute_prompt's `context_size` shorthand. */
    sizeBucketTokens?: Partial<Record<'S' | 'M' | 'L', number>>;
    /** Tokens reserved below the raw window before a dispatch is flagged near-margin. */
    safetyMarginTokens?: number;
    /** Per-provider context window (tokens), overriding the built-in defaults. */
    contextWindows?: Partial<Record<LlmProvider, number>>;
    /** 'enforce' (default) rejects over-demand dispatches; 'warn' never rejects,
     *  only attaches the structured warning. */
    mode?: 'enforce' | 'warn';
  };
  /** Statically declared workflow packages (apra-fleet-iywi.3 / F13). NO
   *  default -- absent means no config-declared packages, not an empty
   *  array pinned by this module. These merge with runtime-registered
   *  packages in src/services/workflow-packages.ts and cannot be removed
   *  through the unregister route (see that module's OWNERSHIP notes). */
  workflowPackages?: WorkflowPackageConfigEntry[];
}

/**
 * Default length of the command/prompt preview kept on a fleet-log line. The
 * line exists to identify which dispatch it is, not to preserve the full text
 * (which would bloat the log and persist unmasked data on disk); `watch` reads
 * the full prompt from the session transcript instead. Override via
 * `logging.previewChars` in config.json.
 */
export const DEFAULT_LOG_PREVIEW_CHARS = 256;

const VALID_PROVIDERS = new Set<string>(['claude', 'codex', 'copilot', 'agy']);
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

  if (obj.contextAdmission && typeof obj.contextAdmission === 'object' && !Array.isArray(obj.contextAdmission)) {
    const ca = obj.contextAdmission as Record<string, unknown>;
    const parsedCa: NonNullable<UserConfig['contextAdmission']> = {};

    if (ca.sizeBucketTokens && typeof ca.sizeBucketTokens === 'object' && !Array.isArray(ca.sizeBucketTokens)) {
      const buckets = ca.sizeBucketTokens as Record<string, unknown>;
      const validBuckets: Partial<Record<'S' | 'M' | 'L', number>> = {};
      for (const [bucketKey, bucketVal] of Object.entries(buckets)) {
        if (bucketKey !== 'S' && bucketKey !== 'M' && bucketKey !== 'L') {
          console.error(`[fleet] user config: unknown contextAdmission.sizeBucketTokens key "${bucketKey}", skipping`);
          continue;
        }
        if (typeof bucketVal === 'number' && Number.isFinite(bucketVal) && bucketVal >= 0) {
          validBuckets[bucketKey] = bucketVal;
        } else {
          console.error(`[fleet] user config: contextAdmission.sizeBucketTokens.${bucketKey} must be a non-negative number, ignoring`);
        }
      }
      parsedCa.sizeBucketTokens = validBuckets;
    }

    if (ca.safetyMarginTokens !== undefined) {
      if (typeof ca.safetyMarginTokens === 'number' && Number.isFinite(ca.safetyMarginTokens) && ca.safetyMarginTokens >= 0) {
        parsedCa.safetyMarginTokens = ca.safetyMarginTokens;
      } else {
        console.error('[fleet] user config: contextAdmission.safetyMarginTokens must be a non-negative number, ignoring');
      }
    }

    if (ca.contextWindows && typeof ca.contextWindows === 'object' && !Array.isArray(ca.contextWindows)) {
      const windows = ca.contextWindows as Record<string, unknown>;
      const validWindows: Partial<Record<LlmProvider, number>> = {};
      for (const [provKey, winVal] of Object.entries(windows)) {
        if (!VALID_PROVIDERS.has(provKey)) {
          console.error(`[fleet] user config: unknown provider "${provKey}" in contextAdmission.contextWindows, skipping`);
          continue;
        }
        if (typeof winVal === 'number' && Number.isFinite(winVal) && winVal >= 0) {
          validWindows[provKey as LlmProvider] = winVal;
        } else {
          console.error(`[fleet] user config: contextAdmission.contextWindows.${provKey} must be a non-negative number, ignoring`);
        }
      }
      parsedCa.contextWindows = validWindows;
    }

    if (ca.mode !== undefined) {
      if (ca.mode === 'enforce' || ca.mode === 'warn') {
        parsedCa.mode = ca.mode;
      } else {
        console.error('[fleet] user config: contextAdmission.mode must be "enforce" or "warn", ignoring');
      }
    }

    result.contextAdmission = parsedCa;
  }

  if (Array.isArray(obj.workflowPackages)) {
    const validEntries: WorkflowPackageConfigEntry[] = [];
    for (const entry of obj.workflowPackages) {
      if (
        typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).id === 'string' && (entry as Record<string, unknown>).id !== '' &&
        typeof (entry as Record<string, unknown>).baseUrl === 'string' && (entry as Record<string, unknown>).baseUrl !== ''
      ) {
        const e = entry as Record<string, unknown>;
        validEntries.push({ id: e.id as string, baseUrl: e.baseUrl as string });
      } else {
        console.error('[fleet] user config: malformed workflowPackages entry, skipping');
      }
    }
    result.workflowPackages = validEntries;
  } else if (obj.workflowPackages !== undefined) {
    console.error('[fleet] user config: workflowPackages must be an array, ignoring');
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

/** Config-declared workflow packages -- [] (not undefined) when absent, for
 *  callers (src/services/workflow-packages.ts) that always want an array to
 *  merge against. */
export function getWorkflowPackagesConfig(): WorkflowPackageConfigEntry[] {
  return loadUserConfig().workflowPackages ?? [];
}

/** Reset the cached config -- for testing only. */
export function _resetCache(): void {
  cached = undefined;
}
