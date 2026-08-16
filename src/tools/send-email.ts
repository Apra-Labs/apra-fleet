import { z } from 'zod';
import { createEmailProvider, resolveSecret } from '../providers/email/index.js';
import type { EmailConfig, EmailMessage, EmailProvider, EmailProviderName } from '../providers/email/provider.js';
import { resolveSessionCaller } from '../utils/session-caller.js';
import { logLine } from '../utils/log-helpers.js';

// Same validator zod already uses elsewhere -- one definition of "valid email"
// for both the MCP schema and the pre-credential runtime checks below.
const emailAddress = z.string().email();

const attachmentSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1).describe('Base64-encoded attachment content'),
  contentType: z.string().optional(),
});

export const sendEmailSchema = z.object({
  provider: z.enum(['sendgrid', 'smtp']).default('sendgrid').describe('Email provider to use'),
  from: emailAddress.describe('Sender email address'),

  host: z.string().optional().describe('SMTP server hostname (required for smtp provider)'),
  port: z.number().optional().default(587).describe('SMTP server port'),
  user: z.string().optional().describe('SMTP username (required for smtp provider)'),
  secure: z.boolean().optional().default(false).describe('Use implicit TLS (port 465). When false, STARTTLS is required; plaintext AUTH is refused.'),

  to: z.union([emailAddress, z.array(emailAddress)]).describe('Recipient email address, or list of addresses'),
  subject: z.string().min(1).describe('Email subject line'),
  body: z.string().min(1).describe('Plain-text email body'),
  html: z.string().optional().describe('Optional HTML email body'),
  cc: z.array(emailAddress).optional().describe('CC recipient addresses'),
  bcc: z.array(emailAddress).optional().describe('BCC recipient addresses'),
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
    if (!emailAddress.safeParse(addr).success) errors.push(`Invalid 'to' address: ${addr}`);
  }
  for (const addr of input.cc ?? []) {
    if (!emailAddress.safeParse(addr).success) errors.push(`Invalid 'cc' address: ${addr}`);
  }
  for (const addr of input.bcc ?? []) {
    if (!emailAddress.safeParse(addr).success) errors.push(`Invalid 'bcc' address: ${addr}`);
  }
  if (!emailAddress.safeParse(input.from).success) {
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

interface ProviderSpec {
  credentialName: string;
  missingMessage: string;
  emptyMessage: string;
  toConfig: (input: SendEmailInput, secret: string) => EmailConfig;
}

const PROVIDER_SPECS: Record<EmailProviderName, ProviderSpec> = {
  smtp: {
    credentialName: 'smtp_password',
    missingMessage: 'SMTP password not found. Store it with credential_store_set (name: "smtp_password").',
    emptyMessage: 'SMTP password is empty.',
    toConfig: (input, secret) => ({
      provider: 'smtp',
      from: input.from,
      smtp: {
        host: input.host!,
        port: input.port ?? 587,
        secure: input.secure ?? false,
        auth: { user: input.user!, pass: secret },
        from: input.from,
      },
    }),
  },
  sendgrid: {
    credentialName: 'sendgrid_api_key',
    missingMessage: 'SendGrid API key not found. Store it with credential_store_set (name: "sendgrid_api_key").',
    emptyMessage: 'SendGrid API key is empty.',
    toConfig: (input, secret) => ({
      provider: 'sendgrid',
      from: input.from,
      sendgrid: { apiKey: secret, from: input.from },
    }),
  },
};

function buildProvider(input: SendEmailInput, callingMember: string): EmailProvider {
  const spec = PROVIDER_SPECS[input.provider];
  const secret = resolveSecret(spec.credentialName, callingMember);
  if (secret === undefined) {
    throw new Error(spec.missingMessage);
  }
  if (secret === '') {
    throw new Error(spec.emptyMessage);
  }
  return createEmailProvider(spec.toConfig(input, secret));
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
    const provider = buildProvider(input, resolveSessionCaller(extra?.sessionId).identity);
    const result = await provider.send(message);
    logLine('send_email', `sent via ${provider.name} messageId=${result.messageId}`);
    return JSON.stringify({ ok: true, messageId: result.messageId });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logLine('send_email', `send failed: ${errorMessage}`);
    return JSON.stringify({ ok: false, error: errorMessage });
  }
}
