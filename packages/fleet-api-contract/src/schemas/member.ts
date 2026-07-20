import { z } from 'zod';

/**
 * Provider enum -- any LLM, or 'none' (plain executor). NOT Claude-centric.
 * 'none' is required per us9.14 (member.md provider must allow no-LLM
 * executors).
 */
export const ProviderSchema = z.enum([
  'claude',
  'gemini',
  'codex',
  'copilot',
  'agy',
  'opencode',
  'none',
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const MemberStatusSchema = z.enum(['busy', 'online', 'offline', 'awaiting-connect']);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

/** Member -- a JWT-scoped agent (any LLM, or none) within a workspace. */
export const MemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: ProviderSchema,
  model: z.string().nullable().describe("null when provider === 'none'"),
  machine: z.string().min(1).describe('Host running apra-fleet.exe'),
  folder: z.string().min(1).describe('Work folder on the member machine'),
  status: MemberStatusSchema.describe('Last-known, pushed over SSE -- never implies live polling'),
  lastSeen: z.number().int().nonnegative().nullable().describe('Seconds ago'),
  lastPrompt: z.string().nullable().describe('Real, sourced last prompt -- never fabricated'),
  lastPromptAt: z.number().int().nonnegative().nullable().describe('Seconds ago'),
  tags: z.array(z.string()),
  jwtExp: z.number().int().nonnegative().describe('Seconds until JWT expiry (0 = expired)'),
  agentVer: z.string().min(1),
  reservedBy: z.string().nullable().describe('sprintId owning this member\'s reservation, or null if unreserved (apra-fleet-eft.10 server-side reservation)'),
});
export type Member = z.infer<typeof MemberSchema>;

export const CreateMemberRequestSchema = z.object({
  name: z.string().min(1),
  provider: ProviderSchema,
  machine: z.string().min(1),
  folder: z.string().min(1),
});
export type CreateMemberRequest = z.infer<typeof CreateMemberRequestSchema>;

/** Returned exactly once at issuance/rotation -- never re-returned. */
export const MemberTokenResponseSchema = z.object({
  member: MemberSchema,
  jwt: z.string().min(1).describe('Shown once; store it now'),
});
export type MemberTokenResponse = z.infer<typeof MemberTokenResponseSchema>;
