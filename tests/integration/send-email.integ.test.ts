/**
 * apra-fleet-ddg.9: real end-to-end email send integration test.
 *
 * Exercises the SendGrid and SMTP providers against REAL credentials and
 * sends an ACTUAL email (subject, body, cc, and a small attachment). This
 * never runs as part of a routine `npm test` -- it is gated behind
 * SEND_EMAIL_INTEG=1 so a member's normal test run never burns a live send
 * or requires live credentials to be present.
 *
 * To run for real:
 *   SEND_EMAIL_INTEG=1 \
 *   SENDGRID_API_KEY=... SENDGRID_TEST_FROM=... SENDGRID_TEST_TO=... \
 *   SMTP_HOST=... SMTP_PORT=... SMTP_USER=... SMTP_PASS=... SMTP_TEST_FROM=... SMTP_TEST_TO=... \
 *   npx vitest run tests/integration/send-email.integ.test.ts
 *
 * Each provider's block additionally skips itself (rather than failing)
 * when its own required env vars are not present, so operators can opt a
 * single provider in without configuring both.
 */
import { describe, it, expect } from 'vitest';

import { SendGridProvider } from '../../src/providers/email/sendgrid.js';
import { SmtpProvider } from '../../src/providers/email/smtp.js';
import type { EmailMessage } from '../../src/services/email/types.js';

const INTEG_OPTED_IN = process.env.SEND_EMAIL_INTEG === '1';

// A tiny base64-encoded plain-text attachment ("apra-fleet integ test\n").
const TEST_ATTACHMENT_CONTENT = Buffer.from('apra-fleet integ test\n', 'utf8').toString('base64');

function buildMessage(from: string, to: string): EmailMessage {
  return {
    to,
    cc: [to],
    subject: '[apra-fleet] send-email integration test',
    body: 'This is a real end-to-end test send from tests/integration/send-email.integ.test.ts (apra-fleet-ddg.9).',
    from,
    attachments: [
      {
        filename: 'apra-fleet-integ-test.txt',
        content: TEST_ATTACHMENT_CONTENT,
        contentType: 'text/plain',
      },
    ],
  };
}

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_TEST_FROM = process.env.SENDGRID_TEST_FROM ?? process.env.EMAIL_FROM;
const SENDGRID_TEST_TO = process.env.SENDGRID_TEST_TO ?? SENDGRID_TEST_FROM;
const SENDGRID_CONFIGURED = Boolean(SENDGRID_API_KEY && SENDGRID_TEST_FROM && SENDGRID_TEST_TO);

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_TEST_FROM = process.env.SMTP_TEST_FROM ?? process.env.EMAIL_FROM ?? SMTP_USER;
const SMTP_TEST_TO = process.env.SMTP_TEST_TO ?? SMTP_TEST_FROM;
const SMTP_CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_TEST_FROM && SMTP_TEST_TO);

describe.skipIf(!INTEG_OPTED_IN)('send-email integration (real credentials, real send)', () => {
  describe.skipIf(!SENDGRID_CONFIGURED)('SendGrid provider', () => {
    it('sends a real email with subject, body, cc, and attachment', async () => {
      const provider = new SendGridProvider({
        apiKey: SENDGRID_API_KEY as string,
        from: SENDGRID_TEST_FROM as string,
      });

      const result = await provider.send(buildMessage(SENDGRID_TEST_FROM as string, SENDGRID_TEST_TO as string));

      expect(result.messageId).toBeTruthy();
    });
  });

  describe.skipIf(!SMTP_CONFIGURED)('SMTP provider', () => {
    it('sends a real email with subject, body, cc, and attachment', async () => {
      const provider = new SmtpProvider({
        host: SMTP_HOST as string,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER as string, pass: SMTP_PASS as string },
        from: SMTP_TEST_FROM as string,
      });

      const result = await provider.send(buildMessage(SMTP_TEST_FROM as string, SMTP_TEST_TO as string));

      expect(result.messageId).toBeTruthy();
    });
  });

  it('requires at least one transport to be configured when opted in', () => {
    if (!SENDGRID_CONFIGURED && !SMTP_CONFIGURED) {
      throw new Error(
        'SEND_EMAIL_INTEG=1 but neither SendGrid (SENDGRID_API_KEY/SENDGRID_TEST_FROM/SENDGRID_TEST_TO) ' +
          'nor SMTP (SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_TEST_FROM/SMTP_TEST_TO) credentials were provided.',
      );
    }
    expect(SENDGRID_CONFIGURED || SMTP_CONFIGURED).toBe(true);
  });
});
