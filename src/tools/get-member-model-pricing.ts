import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { getProvider } from '../providers/index.js';
import { getMemberModelPricing as resolveMemberModelPricing } from '../services/model-pricing.js';
import type { Agent } from '../types.js';

export const getMemberModelPricingSchema = z.object({
  ...memberIdentifier,
}).strict();

export type GetMemberModelPricingInput = z.infer<typeof getMemberModelPricingSchema>;

/**
 * apra-fleet-dv5.5: returns this member's resolved tier -> concrete-model
 * pricing, so a client-side cost tracker (apra-fleet-dv5.6) can price
 * dispatches against the model actually resolved for a tier, instead of a
 * tier-band estimate. A tier is `null` when its resolved model has no
 * known price -- this tool never fabricates a price for an unlisted model.
 */
export async function getMemberModelPricing(input: GetMemberModelPricingInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return JSON.stringify({ error: agentOrError });
  const agent = agentOrError as Agent;

  const provider = getProvider(agent.llmProvider);
  const pricing = resolveMemberModelPricing(agent, provider);
  return JSON.stringify({
    member_id: agent.id,
    member_name: agent.friendlyName,
    llm_provider: agent.llmProvider ?? 'claude',
    pricing,
  });
}
