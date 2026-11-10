import { z } from 'zod';
import { provisionAuthForKind, ProvisionAuthError, type ProvisionKindFailure, type ProvisionKindResult } from '../services/provision-auth-kinds.js';

export const provisionKbAuthSchema = z.object({
  member_id: z.string().optional().describe('UUID of the member (or use member_name)'),
  member_name: z.string().optional().describe('Friendly name of the member (alternative to member_id)'),
  secret: z.string().min(1).describe('Name of a static or live secret on this fleet server (the orchestrator) that holds or mints the KB token. Its network_policy must not be deny, and it must be shared with the member. Never a value or a {{secret.NAME}} placeholder: just NAME.'),
  remote: z.string().describe('The KB server URL, http(s), as the member reaches it. For a local member it must be the remote the orchestrator KB config already names.'),
  reason: z.enum(['rejected']).optional().describe('Pass "rejected" when the KB server refused the token this secret last gave out (E-KB-HTTP-AUTH reason rejected): a cached live token is dropped and a new one minted first, so the refused one is not pushed again.'),
});

export type ProvisionKbAuthInput = z.infer<typeof provisionKbAuthSchema>;

/** A refusal or failure, as a tool error result. Names only, never a value. */
export class ProvisionKbAuthToolError extends Error {
  readonly structuredContent: { ok: false; code: 'E-PROVISION-AUTH'; reason: ProvisionKindFailure; message: string };
  constructor(err: ProvisionAuthError) {
    super(`E-PROVISION-AUTH: ${err.reason}: ${err.message}`);
    this.name = 'ProvisionKbAuthToolError';
    this.structuredContent = { ok: false, code: 'E-PROVISION-AUTH', reason: err.reason, message: err.message };
  }
}

/**
 * provision_kb_auth: provision_auth with kind kb. A local member gets nothing
 * pushed and the KB config is checked, never changed; a remote member gets the
 * token as a static secret with its expiry, its KB pointed at it if needed, and
 * one KB call to check it. See src/services/provision-kb.ts.
 */
export async function provisionKbAuth(input: ProvisionKbAuthInput): Promise<{ text: string; structuredContent: Record<string, unknown> }> {
  let result: ProvisionKindResult;
  try {
    result = await provisionAuthForKind({ kind: 'kb', ...input });
  } catch (err) {
    if (err instanceof ProvisionAuthError) throw new ProvisionKbAuthToolError(err);
    throw err;
  }
  const ok = result.verification.status === 'verified';
  const verified = result.verification.status === 'verified'
    ? 'verified'
    : `failed: ${result.verification.reason} (${result.verification.detail})`;
  const text = `${ok ? '[OK]' : '[WARN]'} KB token from secret "${result.secret}" provisioned to member "${result.member.name}"; ` +
    `expires ${result.expiresAt ?? 'never'}; verification ${verified}`;
  return { text, structuredContent: { ok, ...result } };
}
