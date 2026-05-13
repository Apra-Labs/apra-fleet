import { z } from 'zod';
import { resolveSecureTokens, containsSecureTokens } from '../../token-resolver.js';

export const resolveSecureSchema = z.object({
  text: z.string().describe('Text containing {{secure.NAME}} tokens to resolve'),
  caller: z.string().optional().describe('Name of the calling member (for scoped credentials)'),
  os: z.enum(['linux', 'macos', 'windows']).optional().describe('Target OS for shell escaping (default: current platform)'),
  shell_escape: z.boolean().default(true).describe('Whether to apply shell escaping to resolved values (default: true)'),
});

export type ResolveSecureInput = z.infer<typeof resolveSecureSchema>;

export async function resolveSecureHandler(input: ResolveSecureInput): Promise<string> {
  if (!containsSecureTokens(input.text)) {
    return JSON.stringify({ resolved: input.text, redact_patterns: [] });
  }

  const result = resolveSecureTokens(input.text, {
    caller: input.caller,
    shellEscape: input.shell_escape,
    os: input.os,
  });

  if ('error' in result) {
    return JSON.stringify({ error: result.error });
  }

  return JSON.stringify({
    resolved: result.resolved,
    redact_patterns: result.credentials.map(c => c.plaintext),
  });
}
