import { getStrategy } from '../services/strategy.js';
import type { Agent } from '../types.js';

export interface ModelTierValidationResult {
  warnings: string[];
}

/**
 * Validates model_tiers against `opencode models` output.
 * Returns warnings for unrecognized model IDs; never throws.
 * Silently skips if opencode is not installed or command fails.
 */
export async function validateOpenCodeModelTiers(
  agent: Agent,
  modelTiers: { cheap?: string; standard?: string; premium?: string },
): Promise<ModelTierValidationResult> {
  const strategy = getStrategy(agent);
  let available: string[] = [];

  try {
    const result = await strategy.execCommand('opencode models 2>&1', 15000);
    if (result.code !== 0 || !result.stdout.trim()) {
      return { warnings: [] }; // can't validate -- skip silently
    }
    // Parse: extract non-empty lines, strip whitespace
    available = result.stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));
  } catch {
    return { warnings: [] };
  }

  const specifiedModels = Object.entries(modelTiers)
    .filter(([, v]) => !!v)
    .map(([k, v]) => ({ tier: k, model: v as string }));

  const invalid = specifiedModels.filter(({ model }) => !available.includes(model));
  if (invalid.length === 0) return { warnings: [] };

  const invalidList = invalid.map(({ tier, model }) => `${tier}="${model}"`).join(', ');
  const availableList = available.map(m => `  - ${m}`).join('\n');
  return {
    warnings: [
      `The following model_tiers models were not found in "opencode models": ${invalidList}\n`
      + `  Available models:\n${availableList}\n`
      + `  Use update_member to correct model_tiers.`,
    ],
  };
}
