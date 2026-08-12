import { z } from 'zod';
import { resolveSecret } from '../providers/email/index.js';
import { SendGridProvider } from '../providers/email/sendgrid.js';
import { SmtpProvider } from '../providers/email/smtp.js';
import type { EmailMessage, EmailProvider } from '../providers/email/provider.js';
import { sessionRegistry } from '../services/session-registry.js';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import { logLine } from '../utils/log-helpers.js';

// Basic RFC-5322-ish email format check -- not exhaustive, just catches
// obviously malformed input before we attempt a network call.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const attachmentSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1).describe('Base64-encoded attachment content'),
  contentType: z.string().optional(),
});

export const sendEmailSchema = z.object({
  provider: z.enum(['sendgrid', 'smtp']).default('sendgrid').describe('Email provider to use'),
  from: z.string().min(1).describe('Sender email address'),

  host: z.string().optional().describe('SMTP server hostname (required for smtp provider)'),
  port: z.number().optional().default(587).describe('SMTP server port'),
  user: z.string().optional().describe('SMTP username (required for smtp provider)'),
  secure: z.boolean().optional().default(false).describe('Use implicit TLS (port 465)'),

  to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address, or list of addresses'),
  subject: z.string().min(1).describe('Email subject line'),
  body: z.string().min(1).describe('Plain-text email body'),
  html: z.string().optional().describe('Optional HTML email body'),
  cc: z.array(z.string()).optional().describe('CC recipient addresses'),
  bcc: z.array(z.string()).optional().describe('BCC recipient addresses'),
  attachments: z.array(attachmentSchema).optional().describe('Optional file attachments (base64-encoded content)'),
});

export type SendEmailInput = z.infer<typeof sendEmailSchema>;

/**
 * All cheap input validation, in one place, run BEFORE any credential-store
 * round trip: address formats, header-injection rejection (CR/LF in from/
 * subject), and the smtp host/user requirement. This is the single runtime
 * source of truth for the "smtp requires host+user" rule -- the MCP SDK's
 * tool registration only accepts a flat ZodRawShape (sendEmailSchema.shape),
 * so the rule cannot live in the schema as a discriminated union.
 */
function validateInput(input: SendEmailInput): string[] {
  const errors: string[] = [];
  const toList = Array.isArray(input.to) ? input.to : [input.to];

  if (toList.length === 0) errors.push(`'to' must include at least one recipient`);
  for (const addr of toList) {
    if (!EMAIL_RE.test(addr)) errors.push(`Invalid 'to' address: ${addr}`);
  }
  for (const addr of input.cc ?? []) {
    if (!EMAIL_RE.test(addr)) errors.push(`Invalid 'cc' address: ${addr}`);
  }
  for (const addr of input.bcc ?? []) {
    if (!EMAIL_RE.test(addr)) errors.push(`Invalid 'bcc' address: ${addr}`);
  }
  if (!EMAIL_RE.test(input.from)) {
    errors.push(`Invalid 'from' address: ${input.from}`);
  }
  if (/[\r\n]/.test(input.subject)) {
    errors.push(`'subject' must not contain CR/LF characters`);
  }
  if (input.provider === 'smtp') {
    if (!input.host) errors.push('SMTP requires "host" field.');
    if (!input.user) errors.push('SMTP requires "user" field.');
  }

  return errors;
}

/**
 * Derive the caller identity for credential scoping. A connected member
 * session is identified by its MCP session (extra.sessionId, populated by the
 * SDK's HTTP transport) and gets its member friendly name -- so allowedMembers
 * restrictions on email credentials are enforced. A caller with no registered
 * member session (the orchestrator on stdio or HTTP) is the fleet operator
 * and resolves with the '*' operator scope, same as the CLI.
 */
function resolveCallingMember(extra?: { sessionId?: string }): string {
  const sessionId = extra?.sessionId;
  if (!sessionId) return '*';
  const session = sessionRegistry.findBySessionId(sessionId);
  if (!session) return '*';
  const agent = getAgentOrFail(session.member_id);
  return typeof agent === 'string' ? session.member_id : agent.friendlyName;
}

function buildProvider(input: SendEmailInput, callingMember: string): EmailProvider {
  if (input.provider === 'smtp') {
    const pass = resolveSecret('smtp_password', callingMember);
    if (!pass) {
      throw new Error('SMTP password not found. Store it with credential_store_set (name: "smtp_password").');
    }
    return new SmtpProvider({
      host: input.host!,
      port: input.port ?? 587,
      secure: input.secure ?? false,
      auth: { user: input.user!, pass },
      from: input.from,
    });
  }

  const apiKey = resolveSecret('sendgrid_api_key', callingMember);
  if (!apiKey) {
    throw new Error('SendGrid API key not found. Store it with credential_store_set (name: "sendgrid_api_key").');
  }
  return new SendGridProvider({ apiKey, from: input.from });
}

export async function sendEmail(input: SendEmailInput, extra?: { sessionId?: string }): Promise<string> {
  const validationErrors = validateInput(input);
  if (validationErrors.length > 0) {
    logLine('send_email', `validation failed: ${validationErrors.join('; ')}`);
    return JSON.stringify({ ok: false, error: validationErrors.join('; ') });
  }

  const message: EmailMessage = {
    to: input.to,
    subject: input.subject,
    body: input.body,
    html: input.html,
    cc: input.cc,
    bcc: input.bcc,
    attachments: input.attachments,
  };

  try {
    const provider = buildProvider(input, resolveCallingMember(extra));
    const result = await provider.send(message);
    logLine('send_email', `sent via ${provider.name} messageId=${result.messageId}`);
    return JSON.stringify({ ok: true, messageId: result.messageId });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logLine('send_email', `send failed: ${errorMessage}`);
    return JSON.stringify({ ok: false, error: errorMessage });
  }
}
