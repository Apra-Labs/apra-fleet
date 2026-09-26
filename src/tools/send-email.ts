import { z } from 'zod';
import { createEmailProvider, resolveSecret } from '../providers/email/index.js';
import type { EmailConfig, EmailMessage, EmailProvider, EmailProviderName } from '../providers/email/provider.js';
import { emailPayloadBytes, MAX_EMAIL_PAYLOAD_BYTES } from '../providers/email/headers.js';
import { assertQuotedParamSafe, headerError } from '../providers/email/headers.js';
import { resolveSessionCaller } from '../utils/session-caller.js';
import { logLine } from '../utils/log-helpers.js';

// Same validator zod already uses elsewhere -- one definition of "valid email"
// for both the MCP schema and direct sendEmail() callers.
const emailAddress = z.string().email();

const quotedParam = z.string().min(1).refine((v) => !/[\r\n"\\]/.test(v), {
  message: 'must not contain CR/LF, quotes, or backslashes',
});

const attachmentSchema = z.object({
  filename: quotedParam.describe('Attachment filename'),
  content: z.string().min(1).describe('Base64-encoded attachment content'),
  contentType: quotedParam.optional().describe('MIME content type'),
});

export const sendEmailSchema = z.object({
  provider: z.enum(['sendgrid', 'smtp']).default('sendgrid').describe('Email provider to use'),
  from: emailAddress.describe('Sender email address'),

  host: z.string().optional().describe('SMTP server hostname (required for smtp provider)'),
  port: z.number().optional().describe('SMTP server port (default 587, or 465 when secure is true)'),
  user: z.string().optional().describe('SMTP username (required for smtp provider)'),
  secure: z.boolean().optional().default(false).describe('Use implicit TLS (port 465). When false, STARTTLS is required; plaintext AUTH is refused.'),

  to: z.union([emailAddress, z.array(emailAddress)]).describe('Recipient email address, or list of addresses'),
  subject: z.string().min(1).describe('Email subject line'),
  body: z.string().min(1).describe('Plain-text email body'),
  html: z.string().optional().describe('Optional HTML email body'),
  cc: z.array(emailAddress).optional().describe('CC recipient addresses'),
  bcc: z.array(emailAddress).optional().describe('BCC recipient addresses'),
  attachments: z.array(attachmentSchema).optional().describe('Optional file attachments (base64-encoded content, 10MB total payload cap)'),
});

export type SendEmailInput = z.infer<typeof sendEmailSchema>;

function formatSchemaError(err: z.ZodError): string {
  return err.issues.map((issue) => {
    const key = String(issue.path[0] ?? 'input');
    if (key === 'to' || key === 'cc' || key === 'bcc' || key === 'from') {
      return `Invalid '${key}' address`;
    }
    if (key === 'attachments') {
      return `Invalid attachment: ${issue.message}`;
    }
    return issue.message;
  }).join('; ');
}

/**
 * Cross-field and injection checks that the flat MCP ZodRawShape cannot
 * express: empty `to` list, CR/LF in header fields, SMTP host/user, port
 * pairing, and payload size. Address format is handled by sendEmailSchema
 * (including for direct sendEmail() callers via safeParse below).
 */
function validateInput(input: SendEmailInput): string[] {
  const errors: string[] = [];
  const toList = Array.isArray(input.to) ? input.to : [input.to];

  if (toList.length === 0) errors.push(`'to' must include at least one recipient`);

  const fromErr = headerError('from', input.from);
  if (fromErr) errors.push(fromErr);
  for (const addr of toList) {
    const err = headerError('to', addr);
    if (err) errors.push(err);
  }
  for (const addr of input.cc ?? []) {
    const err = headerError('cc', addr);
    if (err) errors.push(err);
  }
  for (const addr of input.bcc ?? []) {
    const err = headerError('bcc', addr);
    if (err) errors.push(err);
  }
  const subjectErr = headerError('subject', input.subject);
  if (subjectErr) errors.push(subjectErr);

  if (input.provider === 'smtp') {
    if (!input.host) errors.push('SMTP requires "host" field.');
    if (!input.user) errors.push('SMTP requires "user" field.');
  }

  const bytes = emailPayloadBytes(input);
  if (bytes > MAX_EMAIL_PAYLOAD_BYTES) {
    errors.push(`Email payload is ${bytes} bytes; maximum is ${MAX_EMAIL_PAYLOAD_BYTES} bytes.`);
  }

  for (const att of input.attachments ?? []) {
    try {
      assertQuotedParamSafe('attachment filename', att.filename);
      if (att.contentType) assertQuotedParamSafe('attachment contentType', att.contentType);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return errors;
}

interface ProviderSpec {
  credentialName: string;
  missingMessage: string;
  emptyMessage: string;
  toConfig: (input: SendEmailInput, secret: string) => EmailConfig;
}

function smtpPort(input: SendEmailInput): number {
  if (input.port !== undefined) return input.port;
  return input.secure ? 465 : 587;
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
        port: smtpPort(input),
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

async function buildProvider(input: SendEmailInput, callingMember: string): Promise<EmailProvider> {
  const spec = PROVIDER_SPECS[input.provider];
  const secret = await resolveSecret(spec.credentialName, callingMember);
  if (secret === undefined) {
    throw new Error(spec.missingMessage);
  }
  if (secret === '') {
    throw new Error(spec.emptyMessage);
  }
  return createEmailProvider(spec.toConfig(input, secret));
}

export async function sendEmail(input: SendEmailInput, extra?: { sessionId?: string }): Promise<string> {
  const parsed = sendEmailSchema.safeParse(input);
  if (!parsed.success) {
    const error = formatSchemaError(parsed.error);
    logLine('send_email', `validation failed: ${error}`);
    return JSON.stringify({ ok: false, error });
  }
  const validInput = parsed.data;

  const validationErrors = validateInput(validInput);
  if (validationErrors.length > 0) {
    logLine('send_email', `validation failed: ${validationErrors.join('; ')}`);
    return JSON.stringify({ ok: false, error: validationErrors.join('; ') });
  }

  const message: EmailMessage = {
    to: validInput.to,
    subject: validInput.subject,
    body: validInput.body,
    html: validInput.html,
    cc: validInput.cc,
    bcc: validInput.bcc,
    attachments: validInput.attachments,
  };

  try {
    const provider = await buildProvider(validInput, resolveSessionCaller(extra?.sessionId).identity);
    const result = await provider.send(message);
    logLine('send_email', `sent via ${provider.name} messageId=${result.messageId}`);
    return JSON.stringify({ ok: true, messageId: result.messageId });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logLine('send_email', `send failed: ${errorMessage}`);
    return JSON.stringify({ ok: false, error: errorMessage });
  }
}
