import { z } from 'zod';
import { resolveSecret } from '../providers/email/index.js';
import { SendGridProvider } from '../providers/email/sendgrid.js';
import { SmtpProvider } from '../providers/email/smtp.js';
import type { EmailMessage, EmailProvider } from '../providers/email/provider.js';
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

function validateAddresses(input: SendEmailInput): string[] {
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

  return errors;
}

function buildProvider(input: SendEmailInput): EmailProvider {
  if (input.provider === 'smtp') {
    const pass = resolveSecret('smtp_password');
    if (!pass) {
      throw new Error('SMTP password not found. Store it with credential_store_set (name: "smtp_password").');
    }
    if (!input.host) {
      throw new Error('SMTP requires "host" field.');
    }
    if (!input.user) {
      throw new Error('SMTP requires "user" field.');
    }
    return new SmtpProvider({
      host: input.host,
      port: input.port ?? 587,
      secure: input.secure ?? false,
      auth: { user: input.user, pass },
      from: input.from,
    });
  }

  const apiKey = resolveSecret('sendgrid_api_key');
  if (!apiKey) {
    throw new Error('SendGrid API key not found. Store it with credential_store_set (name: "sendgrid_api_key").');
  }
  return new SendGridProvider({ apiKey, from: input.from });
}

export async function sendEmail(input: SendEmailInput): Promise<string> {
  const validationErrors = validateAddresses(input);
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
    const provider = buildProvider(input);
    const result = await provider.send(message);
    logLine('send_email', `sent via ${provider.name} messageId=${result.messageId}`);
    return JSON.stringify({ ok: true, messageId: result.messageId });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logLine('send_email', `send failed: ${errorMessage}`);
    return JSON.stringify({ ok: false, error: errorMessage });
  }
}
