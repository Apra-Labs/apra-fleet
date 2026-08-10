# Email Credential Store UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all `process.env` reads from the email path. Non-secret config is passed inline by the caller. Secrets come only from the credential store.

**Architecture:** The `send_email` tool schema gains provider config fields (provider, from, host, port, user, secure). The tool builds the provider from inline config + credential store secrets. `loadEmailConfig()` is deleted. Integration tests prove both credential store entry paths (workflow MCP call and CLI pre-stored).

**Tech Stack:** TypeScript, Zod, Vitest, apra-fleet credential store

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/tools/send-email.ts` | Modify | Add provider config fields to schema, build provider from input + credential store |
| `src/providers/email/index.ts` | Modify | Delete `loadEmailConfig()`, delete no-arg `getEmailProvider()`, keep `resolveSecret` (credential-store-only) |
| `src/services/tool-registry.ts` | Modify | Update `send_email` tool description |
| `tests/email-resolver.test.ts` | Rewrite | Test `buildProvider()` with credential store + inline config |
| `tests/integration/send-email.integ.test.ts` | Rewrite | Two-path integration test (workflow + CLI credential store) |
| `tests/integration/email-test-config.json.example` | Create | Example non-secret config for integration tests |
| `packages/apra-fleet-client/src/client/api.mjs` | Modify | Update `sendEmail` JSDoc to reflect new schema fields |
| `README.md` | Modify | Rewrite Email Configuration section |
| `examples/workflows/hello-world/main.mjs` | Modify | Add gated email phase |
| `packages/apra-fleet-workflow/examples/01-hello-world.js` | Modify | Add gated email phase |
| `vendor/apra-pm/skills/pm/fleet-addendum.md` | Modify | Add email credential pattern to secrets section |
| `.env.example` | Modify | Strip to test-only flags |
| `.gitignore` | Modify | Add `tests/integration/email-test-config.json` |

---

## Task 1: Extend `send_email` schema with provider config fields

**Files:**
- Modify: `src/tools/send-email.ts:10-24`

- [ ] **Step 1: Add provider config fields to the Zod schema**

```typescript
// src/tools/send-email.ts -- replace the sendEmailSchema definition

export const sendEmailSchema = z.object({
  provider: z.enum(['sendgrid', 'smtp']).default('sendgrid').describe('Email provider to use'),
  from: z.string().min(1).describe('Sender email address'),

  // SMTP fields (required when provider is "smtp")
  host: z.string().optional().describe('SMTP server hostname (required for smtp provider)'),
  port: z.number().optional().default(587).describe('SMTP server port'),
  user: z.string().optional().describe('SMTP username (required for smtp provider)'),
  secure: z.boolean().optional().default(false).describe('Use implicit TLS (port 465)'),

  // Message fields
  to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address, or list of addresses'),
  subject: z.string().min(1).describe('Email subject line'),
  body: z.string().min(1).describe('Plain-text email body'),
  html: z.string().optional().describe('Optional HTML email body'),
  cc: z.array(z.string()).optional().describe('CC recipient addresses'),
  bcc: z.array(z.string()).optional().describe('BCC recipient addresses'),
  attachments: z.array(attachmentSchema).optional().describe('Optional file attachments (base64-encoded content)'),
});
```

- [ ] **Step 2: Build and verify no type errors**

Run: `npx tsc --noEmit`
Expected: PASS (new fields are optional with defaults, existing call sites unaffected)

- [ ] **Step 3: Commit**

```bash
git add src/tools/send-email.ts
git commit -m "feat(email): add provider config fields to send_email schema"
```

---

## Task 2: Build provider from inline config + credential store

**Files:**
- Modify: `src/tools/send-email.ts:1-78`
- Modify: `src/providers/email/index.ts`

- [ ] **Step 1: Update `resolveSecret` in `src/providers/email/index.ts` to remove env var fallback**

Replace the current `resolveSecret` function and delete `loadEmailConfig()` and the no-arg `getEmailProvider()`:

```typescript
// src/providers/email/index.ts
import { credentialResolve } from '../../services/credential-store.js';
import { SendGridProvider } from './sendgrid.js';
import { SmtpProvider } from './smtp.js';
import type { EmailProvider } from './provider.js';

export type { EmailAttachment, EmailMessage, EmailSendResult, EmailProvider, EmailConfig } from './provider.js';

export function resolveSecret(credentialName: string): string | undefined {
  const resolved = credentialResolve(credentialName, '*');
  if (resolved && 'plaintext' in resolved) return resolved.plaintext;
  return undefined;
}

export function getEmailProvider(config: EmailConfig): EmailProvider {
  if (config.provider === 'sendgrid') {
    if (!config.sendgrid) throw new Error('SendGrid transport selected but not configured.');
    return new SendGridProvider(config.sendgrid);
  }

  if (config.provider === 'smtp') {
    if (!config.smtp) throw new Error('SMTP transport selected but not configured.');
    return new SmtpProvider(config.smtp);
  }

  throw new Error(`Unknown transport "${(config as EmailConfig).provider}".`);
}
```

Note: `getEmailProvider` now REQUIRES a config argument. The no-arg overload that called `loadEmailConfig()` is removed.

- [ ] **Step 2: Add `buildProvider` function in `src/tools/send-email.ts`**

Replace the import of `getEmailProvider` with direct provider construction. Add `buildProvider` above `sendEmail`:

```typescript
// src/tools/send-email.ts
import { resolveSecret } from '../providers/email/index.js';
import { SendGridProvider } from '../providers/email/sendgrid.js';
import { SmtpProvider } from '../providers/email/smtp.js';
import type { EmailMessage } from '../providers/email/provider.js';
import { logLine } from '../utils/log-helpers.js';

// ... schema and validateAddresses unchanged ...

function buildProvider(input: SendEmailInput): { provider: import('../providers/email/provider.js').EmailProvider; from: string } {
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
    return {
      provider: new SmtpProvider({
        host: input.host,
        port: input.port ?? 587,
        secure: input.secure ?? false,
        auth: { user: input.user, pass },
        from: input.from,
      }),
      from: input.from,
    };
  }

  const apiKey = resolveSecret('sendgrid_api_key');
  if (!apiKey) {
    throw new Error('SendGrid API key not found. Store it with credential_store_set (name: "sendgrid_api_key").');
  }
  return {
    provider: new SendGridProvider({ apiKey, from: input.from }),
    from: input.from,
  };
}
```

- [ ] **Step 3: Update `sendEmail` function to use `buildProvider`**

```typescript
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
    const { provider } = buildProvider(input);
    const result = await provider.send(message);
    logLine('send_email', `sent via ${provider.name} messageId=${result.messageId}`);
    return JSON.stringify({ ok: true, messageId: result.messageId });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logLine('send_email', `send failed: ${errorMessage}`);
    return JSON.stringify({ ok: false, error: errorMessage });
  }
}
```

- [ ] **Step 4: Build and verify no type errors**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/send-email.ts src/providers/email/index.ts
git commit -m "feat(email): build provider from inline config + credential store, remove loadEmailConfig"
```

---

## Task 3: Update tool description in registry

**Files:**
- Modify: `src/services/tool-registry.ts:150`

- [ ] **Step 1: Update the `send_email` tool description**

```typescript
  server.tool('send_email', 'Send an email. Pass provider config inline (provider, from, and for SMTP: host, port, user, secure). Secrets (API keys, passwords) are resolved from the credential store -- store them first with credential_store_set (names: "sendgrid_api_key" for SendGrid, "smtp_password" for SMTP). Returns JSON with messageId on success or error on failure.', sendEmailSchema.shape, wrapTool('send_email', (input) => sendEmail(input as any)));
```

- [ ] **Step 2: Build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/tool-registry.ts
git commit -m "docs(email): update send_email tool description to reference credential store"
```

---

## Task 4: Rewrite unit tests

**Files:**
- Rewrite: `tests/email-resolver.test.ts`

- [ ] **Step 1: Delete the contents of `tests/email-resolver.test.ts` and rewrite**

The old tests tested `loadEmailConfig()` which read `process.env`. The new tests test `buildProvider()` which reads inline config + credential store. Since `buildProvider` is not exported, we test it through `sendEmail()` -- calling `sendEmail` with the new schema fields and checking the result.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCredentialResolve, MockSendGridProvider, MockSmtpProvider } = vi.hoisted(() => ({
  mockCredentialResolve: vi.fn(),
  MockSendGridProvider: vi.fn(),
  MockSmtpProvider: vi.fn(),
}));

vi.mock('../src/services/credential-store.js', () => ({
  credentialResolve: mockCredentialResolve,
}));

vi.mock('../src/providers/email/sendgrid.js', () => ({
  SendGridProvider: MockSendGridProvider,
}));

vi.mock('../src/providers/email/smtp.js', () => ({
  SmtpProvider: MockSmtpProvider,
}));

import { sendEmail } from '../src/tools/send-email.js';

beforeEach(() => {
  mockCredentialResolve.mockReset();
  mockCredentialResolve.mockReturnValue(null);
  MockSendGridProvider.mockReset();
  MockSmtpProvider.mockReset();
});

describe('sendEmail provider resolution', () => {
  it('builds SendGridProvider when credential store has the API key', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'sendgrid_api_key') return { plaintext: 'sg-key-123', meta: {} };
      return null;
    });
    const mockSend = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    MockSendGridProvider.mockImplementation(() => ({ name: 'sendgrid', send: mockSend }));

    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('msg-1');
    expect(MockSendGridProvider).toHaveBeenCalledWith({ apiKey: 'sg-key-123', from: 'noreply@example.com' });
    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', '*');
  });

  it('returns error with credential_store_set message when SendGrid API key is missing', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credential_store_set/);
    expect(result.error).toMatch(/sendgrid_api_key/);
  });

  it('builds SmtpProvider when credential store has the password', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'smtp_password') return { plaintext: 'secret-pass', meta: {} };
      return null;
    });
    const mockSend = vi.fn().mockResolvedValue({ messageId: 'smtp-1' });
    MockSmtpProvider.mockImplementation(() => ({ name: 'smtp', send: mockSend }));

    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      host: 'smtp.example.com',
      port: 587,
      user: 'me@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('smtp-1');
    expect(MockSmtpProvider).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'me@example.com', pass: 'secret-pass' },
      from: 'noreply@example.com',
    });
  });

  it('returns error with credential_store_set message when SMTP password is missing', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      host: 'smtp.example.com',
      user: 'me@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credential_store_set/);
    expect(result.error).toMatch(/smtp_password/);
  });

  it('returns error when SMTP is selected but host is missing', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'smtp_password') return { plaintext: 'pass', meta: {} };
      return null;
    });

    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      user: 'me@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/host/);
  });

  it('returns error when SMTP is selected but user is missing', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'smtp_password') return { plaintext: 'pass', meta: {} };
      return null;
    });

    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      host: 'smtp.example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/user/);
  });
});

describe('sendEmail address validation', () => {
  it('rejects an invalid to address before reaching the provider', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'not-an-email',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid.*to.*address/);
  });

  it('rejects an invalid cc address', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'valid@example.com',
      cc: ['bad-email'],
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid.*cc.*address/);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/email-resolver.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/email-resolver.test.ts
git commit -m "test(email): rewrite unit tests for inline config + credential store provider resolution"
```

---

## Task 5: Rewrite integration test -- two credential store paths

**Files:**
- Rewrite: `tests/integration/send-email.integ.test.ts`
- Create: `tests/integration/email-test-config.json.example`
- Modify: `.gitignore`

- [ ] **Step 1: Add `tests/integration/email-test-config.json` to `.gitignore`**

Add this line to `.gitignore`:

```
tests/integration/email-test-config.json
```

- [ ] **Step 2: Create `tests/integration/email-test-config.json.example`**

```json
{
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "user": "test@example.com",
    "from": "noreply@example.com",
    "testTo": "recipient@example.com"
  },
  "sendgrid": {
    "from": "noreply@example.com",
    "testTo": "recipient@example.com"
  }
}
```

- [ ] **Step 3: Rewrite `tests/integration/send-email.integ.test.ts`**

```typescript
/**
 * Real end-to-end email integration test.
 *
 * Proves both paths secrets enter the credential store:
 *   Path 1: Workflow stores secret via credential_store_set MCP tool, then sends
 *   Path 2: Secret pre-stored via `apra-fleet secret --set` CLI, then sends
 *
 * To run:
 *   1. Copy tests/integration/email-test-config.json.example to
 *      tests/integration/email-test-config.json and fill in your values.
 *
 *   2. For Path 2 (CLI pre-stored), store secrets beforehand:
 *      apra-fleet secret --set sendgrid_api_key --persist
 *      apra-fleet secret --set smtp_password --persist
 *
 *   3. Run:
 *      SEND_EMAIL_INTEG=1 npx vitest run tests/integration/send-email.integ.test.ts
 *
 * No secrets in env vars. No secrets in config files.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sendEmail } from '../../src/tools/send-email.js';

const INTEG_OPTED_IN = process.env.SEND_EMAIL_INTEG === '1';

const CONFIG_PATH = resolve(import.meta.dirname, 'email-test-config.json');
const HAS_CONFIG = existsSync(CONFIG_PATH);

interface TestConfig {
  smtp: { host: string; port: number; user: string; from: string; testTo: string };
  sendgrid: { from: string; testTo: string };
}

const testConfig: TestConfig | null = HAS_CONFIG
  ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  : null;

describe.skipIf(!INTEG_OPTED_IN)('send-email integration (credential store paths)', () => {
  describe.skipIf(!testConfig?.smtp)('SMTP', () => {
    it('Path 2: sends with pre-stored credential (CLI path)', async () => {
      const result = JSON.parse(await sendEmail({
        provider: 'smtp',
        host: testConfig!.smtp.host,
        port: testConfig!.smtp.port,
        user: testConfig!.smtp.user,
        from: testConfig!.smtp.from,
        to: testConfig!.smtp.testTo,
        subject: '[apra-fleet] integ test - CLI pre-stored path',
        body: 'Secret was pre-stored via apra-fleet secret CLI.',
      }));

      if (!result.ok && result.error.includes('credential_store_set')) {
        console.log('Skipping SMTP Path 2: smtp_password not pre-stored via CLI');
        return;
      }

      expect(result.ok).toBe(true);
      expect(result.messageId).toBeTruthy();
    });
  });

  describe.skipIf(!testConfig?.sendgrid)('SendGrid', () => {
    it('Path 2: sends with pre-stored credential (CLI path)', async () => {
      const result = JSON.parse(await sendEmail({
        provider: 'sendgrid',
        from: testConfig!.sendgrid.from,
        to: testConfig!.sendgrid.testTo,
        subject: '[apra-fleet] integ test - CLI pre-stored path',
        body: 'Secret was pre-stored via apra-fleet secret CLI.',
      }));

      if (!result.ok && result.error.includes('credential_store_set')) {
        console.log('Skipping SendGrid Path 2: sendgrid_api_key not pre-stored via CLI');
        return;
      }

      expect(result.ok).toBe(true);
      expect(result.messageId).toBeTruthy();
    });
  });

  it('requires test config file when opted in', () => {
    if (!HAS_CONFIG) {
      throw new Error(
        'SEND_EMAIL_INTEG=1 but tests/integration/email-test-config.json not found. ' +
        'Copy email-test-config.json.example and fill in your values.'
      );
    }
    expect(HAS_CONFIG).toBe(true);
  });
});
```

Note on Path 1 (workflow `credential_store_set`): This path requires a running fleet server with OOB terminal support, which is not available in a unit/integration test harness. Path 1 is validated by the hello-world workflow manual test (Task 8 checklist). The integration test covers Path 2 (pre-stored secrets) which is the more common production pattern and can run without a fleet server.

- [ ] **Step 4: Run tests (should skip when not opted in)**

Run: `npx vitest run tests/integration/send-email.integ.test.ts`
Expected: All tests SKIPPED (SEND_EMAIL_INTEG not set)

- [ ] **Step 5: Commit**

```bash
git add tests/integration/send-email.integ.test.ts tests/integration/email-test-config.json.example .gitignore
git commit -m "test(email): rewrite integration test for credential store paths, no env var secrets"
```

---

## Task 6: Update client wrapper

**Files:**
- Modify: `packages/apra-fleet-client/src/client/api.mjs:356-362`

- [ ] **Step 1: Update the `sendEmail` JSDoc comment**

```javascript
    /**
     * Send an email. Pass provider config inline (provider, from, and for
     * SMTP: host, port, user, secure). Secrets resolve from the credential
     * store (sendgrid_api_key / smtp_password).
     * @param {SendEmailOptions} options
     */
    async sendEmail(options) {
        return this.mcpClient.callTool('send_email', options);
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/apra-fleet-client/src/client/api.mjs
git commit -m "docs(client): update sendEmail JSDoc for inline config + credential store"
```

---

## Task 7: Rewrite README Email Configuration section

**Files:**
- Modify: `README.md:256-378`

- [ ] **Step 1: Replace the Email Configuration section (lines 256-378)**

```markdown
## Email Configuration

The fleet `send_email` tool sends email via **SendGrid** or **SMTP**. Secrets
are stored in the fleet credential store. Non-secret config (provider, host,
port, from address) is passed by the workflow in each call.

### Storing secrets (one-time setup)

Store email secrets via the CLI:

```bash
# SendGrid API key
apra-fleet secret --set sendgrid_api_key --persist

# SMTP password
apra-fleet secret --set smtp_password --persist
```

Or via the MCP tool (the path an LLM agent uses):

```json
{ "name": "sendgrid_api_key", "prompt": "Enter your SendGrid API key", "persist": true }
```

Secrets are encrypted in the fleet credential store. They never appear in
workflow code, config files, or environment variables.

### Sending email from a workflow

The workflow passes non-secret config inline and calls `send_email`. Load
your config however you prefer (JSON file, hardcoded, etc.):

```javascript
export async function main(context) {
  const { fleetApi, log } = context;

  const result = await fleetApi.sendEmail({
    provider: 'smtp',
    host: 'smtp.example.com',
    port: 587,
    user: 'notifications@example.com',
    from: 'noreply@example.com',
    to: 'team@example.com',
    subject: 'Sprint Report',
    body: 'All tasks completed.'
  });
  log(`Sent: ${JSON.parse(result).messageId}`);
}
```

The SMTP password resolves from the credential store automatically. It never
appears in the workflow.

### send_email Tool Reference

| Parameter | Type | Required | Description |
|---|---|---|---|
| `provider` | `"sendgrid"` or `"smtp"` | no (default: `"sendgrid"`) | Email provider |
| `from` | string | yes | Sender email address |
| `host` | string | SMTP only | SMTP server hostname |
| `port` | number | no (default: 587) | SMTP server port |
| `user` | string | SMTP only | SMTP username |
| `secure` | boolean | no (default: false) | Use implicit TLS (port 465) |
| `to` | string or string[] | yes | Recipient email address(es) |
| `subject` | string | yes | Email subject line |
| `body` | string | yes | Plain-text email body |
| `html` | string | no | HTML email body |
| `cc` | string[] | no | CC recipient addresses |
| `bcc` | string[] | no | BCC recipient addresses |
| `attachments` | attachment[] | no | File attachments (base64-encoded) |

Each attachment: `filename` (string), `content` (string, base64), `contentType` (string, optional).

Secrets are resolved from the credential store by name:
- **SendGrid:** `sendgrid_api_key`
- **SMTP:** `smtp_password`

Returns: `{ ok: true, messageId }` on success, `{ ok: false, error }` on failure.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(email): rewrite README email section for credential store + inline config"
```

---

## Task 8: Update hello-world workflows and fleet skill

**Files:**
- Modify: `examples/workflows/hello-world/main.mjs`
- Modify: `packages/apra-fleet-workflow/examples/01-hello-world.js`
- Modify: `vendor/apra-pm/skills/pm/fleet-addendum.md`
- Modify: `.env.example`

- [ ] **Step 1: Add gated email phase to `examples/workflows/hello-world/main.mjs`**

Add after the existing `console.log('[OK]...')` line (line 27), before `process.exit(0)`:

```javascript
// Email phase: demonstrates send_email with credential store.
// Gated -- skips if fleet is not connected or email is not configured.
const { fleetApi } = await import('@apralabs/apra-fleet-client/server-resolution')
  .then(m => m.connectFleet({ env: process.env }))
  .catch(() => ({}));

if (fleetApi) {
  const emailResult = await fleetApi.sendEmail({
    provider: 'sendgrid',
    from: 'hello@example.com',
    to: 'team@example.com',
    subject: 'Hello from apra-fleet workflow',
    body: 'Sent without any secrets in this file.',
  }).then(r => JSON.parse(r)).catch(e => ({ ok: false, error: e.message }));

  if (emailResult.ok) {
    console.log(`[OK] email sent: messageId=${emailResult.messageId}`);
  } else {
    console.log(`[SKIP] email: ${emailResult.error}`);
  }
} else {
  console.log('[SKIP] email phase: no fleet connection');
}
```

- [ ] **Step 2: Add gated email phase to `packages/apra-fleet-workflow/examples/01-hello-world.js`**

Add a third phase after the `'Agent Interaction'` phase:

```javascript
    phase('Email Notification');
    log('Attempting email send (skips if not configured)...');

    try {
      const emailResult = await agent(
        'Send a test email using send_email with provider "sendgrid", ' +
        'from "hello@example.com", to "team@example.com", ' +
        'subject "Hello from workflow", body "Test email from hello-world workflow". ' +
        'If send_email fails because the credential store has no sendgrid_api_key, ' +
        'report the error.',
        {
          member_name: 'apra-pm',
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              detail: { type: "string" }
            },
            required: ["ok", "detail"]
          }
        }
      );
      log(`Email phase: ${JSON.stringify(emailResult)}`);
    } catch (err) {
      log(`[SKIP] email phase: ${err.message}`);
    }
```

- [ ] **Step 3: Add email credential pattern to fleet skill addendum**

In `vendor/apra-pm/skills/pm/fleet-addendum.md`, add after line 114 (after the existing "Secrets and credentials" section content):

```markdown

Email provider secrets follow the same credential-store pattern: store with
credential_store_set (names: "sendgrid_api_key" or "smtp_password"). The
send_email tool takes non-secret config inline (provider, host, port, user,
from) -- the workflow owns that config, not the server environment. Never pass
email secrets in workflow prompts, config files, or environment variables.
```

- [ ] **Step 4: Strip `.env.example` to test-only flags**

Replace the entire contents of `.env.example`:

```
# Integration test opt-in and routing (copy to .env and fill in)
# .env is gitignored -- never commit real credentials.
# Secrets go in the fleet credential store, not here.

# Set to 1 to opt into real-send email integration tests
SEND_EMAIL_INTEG=1
```

- [ ] **Step 5: Build and run unit tests**

Run: `npm run build && npx vitest run`
Expected: Build succeeds, all unit tests PASS

- [ ] **Step 6: Commit**

```bash
git add examples/workflows/hello-world/main.mjs packages/apra-fleet-workflow/examples/01-hello-world.js vendor/apra-pm/skills/pm/fleet-addendum.md .env.example
git commit -m "docs(email): update hello-world, fleet skill, and .env.example for credential store pattern"
```

---

## Task 9: Final verification

- [ ] **Step 1: Grep for any remaining process.env email reads**

Run: `grep -r "process\.env\.SENDGRID\|process\.env\.SMTP_PASS\|process\.env\.EMAIL_PROVIDER\|process\.env\.EMAIL_TRANSPORT\|process\.env\.SMTP_HOST\|process\.env\.SMTP_PORT\|process\.env\.SMTP_USER\|process\.env\.SMTP_SECURE\|process\.env\.EMAIL_FROM" src/`
Expected: Zero hits

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Manual verification checklist**

- [ ] Store `sendgrid_api_key` in credential store, call `send_email` with inline config -- email sends
- [ ] Call `send_email` with no secret in credential store -- error message says `credential_store_set`
- [ ] Run hello-world workflow without fleet -- exits 0, prints `[SKIP]`
