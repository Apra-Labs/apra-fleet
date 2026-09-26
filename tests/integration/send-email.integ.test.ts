/**
 * Real end-to-end email integration test.
 *
 * Proves secrets flow through the credential store, not env vars.
 * Pre-store secrets before running:
 *   apra-fleet secret --set sendgrid_api_key --persist
 *   apra-fleet secret --set smtp_password --persist
 *
 * Non-secret config comes from tests/integration/email-test-config.json
 * (gitignored -- copy email-test-config.json.example and fill in values).
 * The test is gated on this file existing -- no env vars needed.
 *
 * Run:
 *   npx vitest run tests/integration/send-email.integ.test.ts
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sendEmail } from '../../src/tools/send-email.js';

const CONFIG_PATH = resolve(import.meta.dirname, 'email-test-config.json');
const HAS_CONFIG = existsSync(CONFIG_PATH);

interface TestConfig {
  smtp: { host: string; port: number; user: string; from: string; testTo: string };
  sendgrid: { from: string; testTo: string };
}

const testConfig: TestConfig | null = HAS_CONFIG
  ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  : null;

describe.skipIf(!HAS_CONFIG)('send-email integration (credential store paths)', () => {
  describe.skipIf(!testConfig?.smtp)('SMTP', () => {
    it('sends with pre-stored credential (CLI path)', async () => {
      const result = JSON.parse(await sendEmail({
        provider: 'smtp',
        host: testConfig!.smtp.host,
        port: testConfig!.smtp.port,
        user: testConfig!.smtp.user,
        from: testConfig!.smtp.from,
        to: testConfig!.smtp.testTo,
        subject: '[apra-fleet] integ test - credential store path',
        body: 'Secret was pre-stored via apra-fleet secret CLI.',
      }));

      if (!result.ok && result.error.includes('credential_store_set')) {
        console.log('Skipping SMTP: smtp_password not pre-stored via CLI');
        return;
      }

      expect(result.ok).toBe(true);
      expect(result.messageId).toBeTruthy();
    });
  });

  describe.skipIf(!testConfig?.sendgrid)('SendGrid', () => {
    it('sends with pre-stored credential (CLI path)', async () => {
      const result = JSON.parse(await sendEmail({
        provider: 'sendgrid',
        from: testConfig!.sendgrid.from,
        to: testConfig!.sendgrid.testTo,
        subject: '[apra-fleet] integ test - credential store path',
        body: 'Secret was pre-stored via apra-fleet secret CLI.',
      }));

      if (!result.ok && result.error.includes('credential_store_set')) {
        console.log('Skipping SendGrid: sendgrid_api_key not pre-stored via CLI');
        return;
      }

      expect(result.ok).toBe(true);
      expect(result.messageId).toBeTruthy();
    });
  });

});
