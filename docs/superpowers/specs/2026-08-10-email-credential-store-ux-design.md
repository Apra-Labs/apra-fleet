# Email Setup UX: Zero Env Vars

**Date:** 2026-08-10
**Branch:** feat/workflow-email-tool
**Status:** Draft

## Problem

The current email layer reads all config from `process.env` -- secrets AND
non-secret config like SMTP_HOST, EMAIL_FROM, EMAIL_PROVIDER. This couples the
tool to the server's environment and forces users into env var management.
Fleet already has a credential store for secrets. Non-secret config should be
passed by the workflow itself, not baked into the server process.

## Principles

1. **Secrets go through `credential_store_set`.** No exceptions, no
   alternatives shown in examples.
2. **Non-secret config is passed by the caller.** The workflow loads its own
   config however it wants (JSON file, hardcoded, whatever) and passes it in
   the `send_email` call. The server reads nothing from `process.env` for
   email.
3. **No secrets in any example.** Not in JSON, not in .env, not in bash
   exports. People copy examples blindly.
4. **No env vars anywhere in the email path.** Not for secrets, not for config.
   The `send_email` tool is fully self-contained: config comes in the call,
   secrets come from the credential store.

## Architecture change

### Before (current)

```
Workflow calls send_email(to, subject, body)
  --> server runs loadEmailConfig()
    --> reads EMAIL_PROVIDER, SMTP_HOST, SMTP_USER, EMAIL_FROM from process.env
    --> reads SENDGRID_API_KEY / SMTP_PASS from credential store, falls back to process.env
  --> builds provider, sends email
```

### After (new)

```
Workflow calls send_email(provider, host, port, user, from, to, subject, body)
  --> server reads secrets from credential store (sendgrid_api_key / smtp_password)
  --> builds provider from inline config + credential store secrets, sends email
  --> process.env is never touched
```

The caller owns the non-secret config. The server owns the secrets. Nothing
reads `process.env`.

## Changes

### 1. Tool schema -- `src/tools/send-email.ts`

Add provider config fields to `sendEmailSchema`:

```typescript
provider: z.enum(['sendgrid', 'smtp']).default('sendgrid')
  .describe('Email provider to use'),
from: z.string().describe('Sender email address'),

// SMTP-specific (required when provider is "smtp")
host: z.string().optional()
  .describe('SMTP server hostname (required for smtp provider)'),
port: z.number().optional().default(587)
  .describe('SMTP server port'),
user: z.string().optional()
  .describe('SMTP username (required for smtp provider)'),
secure: z.boolean().optional().default(false)
  .describe('Use implicit TLS (port 465)'),
```

Secrets are NOT in the schema. They come from the credential store:
- `sendgrid_api_key` for SendGrid
- `smtp_password` for SMTP

### 2. Tool implementation -- `src/tools/send-email.ts`

Update `sendEmail()` to build the provider config from the input fields +
credential store, instead of calling `loadEmailConfig()`:

```typescript
async function buildProvider(input: SendEmailInput): EmailProvider {
  if (input.provider === 'smtp') {
    const pass = resolveSecret('smtp_password', '');
    if (!pass) throw new Error(
      'SMTP password not found. Store it with credential_store_set (name: "smtp_password").'
    );
    if (!input.host || !input.user) throw new Error(
      'SMTP requires host and user fields.'
    );
    return new SmtpProvider({
      host: input.host, port: input.port ?? 587,
      secure: input.secure ?? false,
      auth: { user: input.user, pass },
      from: input.from,
    });
  }

  // sendgrid
  const apiKey = resolveSecret('sendgrid_api_key', '');
  if (!apiKey) throw new Error(
    'SendGrid API key not found. Store it with credential_store_set (name: "sendgrid_api_key").'
  );
  return new SendGridProvider({ apiKey, from: input.from });
}
```

`resolveSecret` still checks the credential store. The second argument (env
var fallback name) is set to empty string -- no env fallback. Only the
credential store is checked.

### 3. Remove `loadEmailConfig()` -- `src/providers/email/index.ts`

Delete `loadEmailConfig()` entirely. It is the function that reads
`process.env`. No other code should call it after this change.

Keep `getEmailProvider(config)` if other code passes explicit config objects,
but remove the no-arg overload that calls `loadEmailConfig()`. If nothing else
calls `getEmailProvider`, remove it too -- the tool builds the provider
directly.

Exports to keep: types (`EmailConfig`, `EmailProvider`, `EmailMessage`, etc.),
`SendGridProvider`, `SmtpProvider`, `resolveSecret` (for credential store
lookups). The `resolveSecret` function drops its env var fallback parameter.

### 4. Tool description -- `src/services/tool-registry.ts` (line 150)

New description:

```
'Send an email. Pass provider config inline (provider, from, host, port,
user for SMTP). Secrets (API keys, passwords) are resolved from the
credential store -- store them first with credential_store_set (names:
"sendgrid_api_key" for SendGrid, "smtp_password" for SMTP). Returns JSON
with messageId on success or error on failure.'
```

### 5. README.md -- Email Configuration section (lines 256-378)

Rewrite entirely.

**Storing secrets (one-time):**

```bash
# SendGrid
apra-fleet secret --set sendgrid_api_key --persist

# SMTP
apra-fleet secret --set smtp_password --persist
```

Or via MCP tool:

```
credential_store_set(name: "sendgrid_api_key", prompt: "Enter SendGrid API key", persist: true)
```

**Calling send_email from a workflow:**

```javascript
// Load your own config however you want
import config from './email-config.json' assert { type: 'json' };

export async function main(context) {
  const { fleetApi, log } = context;

  const result = await fleetApi.sendEmail({
    provider: 'smtp',
    host: config.smtp.host,
    port: config.smtp.port,
    user: config.smtp.user,
    from: config.smtp.from,
    // password resolves from credential store -- never in this file
    to: 'team@example.com',
    subject: 'Sprint Report',
    body: 'All tasks completed.'
  });
  log(`Sent: ${result.messageId}`);
}
```

No secrets in the workflow. No secrets in the JSON config file. The JSON file
has host, port, user, from -- all non-secret. Example `email-config.json`:

```json
{
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "user": "notifications@example.com",
    "from": "noreply@example.com"
  }
}
```

### 6. Hello-world workflow -- `examples/workflows/hello-world/main.mjs`

Extend with a second phase showing the email pattern. Gated -- skips
gracefully if no fleet connection or email not configured.

```javascript
// Phase 2: Email (optional -- skip if fleet not connected)
const { mcpClient, fleetApi } = await connectFleet({ env: process.env }).catch(() => ({}));

if (fleetApi) {
  const result = await fleetApi.sendEmail({
    provider: 'sendgrid',
    from: 'hello@example.com',
    to: 'team@example.com',
    subject: 'Hello from apra-fleet workflow',
    body: 'Sent without any secrets in this file.'
  });
  console.log(`[OK] email sent: messageId=${result.messageId}`);
} else {
  console.log('[SKIP] email phase: no fleet connection');
}
```

Also update `packages/apra-fleet-workflow/examples/01-hello-world.js`.

### 7. Fleet skill addendum -- `vendor/apra-pm/skills/pm/fleet-addendum.md`

Add to the "Secrets and credentials" section:

```
Email provider secrets follow the same pattern: store with
credential_store_set (names: "sendgrid_api_key" or "smtp_password").
The send_email tool takes non-secret config inline (provider, host,
port, user, from) -- the workflow owns that config, not the server.
Never pass email secrets in workflow prompts or config files.
```

### 8. `.env.example` -- strip to test-only

Remove everything except test opt-in flags and test routing addresses:

```
SEND_EMAIL_INTEG=1
SENDGRID_TEST_FROM=
SENDGRID_TEST_TO=
SMTP_TEST_FROM=
SMTP_TEST_TO=
```

No secrets. No server config. These are test parameters only.

### 9. `packages/apra-fleet-client` -- update client wrapper

Per CLAUDE.md convention, update the client wrapper to match the new
send_email schema (the added provider/host/port/user/from fields).

## Testing Strategy

### Unit tests -- `tests/email-resolver.test.ts`

**Rename to `tests/email-send.test.ts`** (or keep the name, but the tests
change focus from "resolver" to "tool builds provider from input + credential
store").

**Remove tests for `loadEmailConfig()`** -- the function no longer exists.

**New tests:**

1. **SendGrid: credential store has key, build succeeds.** Mock
   `credentialResolve('sendgrid_api_key')` to return a key. Call the new
   `buildProvider({provider: 'sendgrid', from: '...'})`. Verify
   `SendGridProvider` is constructed with the store key.

2. **SendGrid: credential store empty, throws with credential_store_set
   message.** Mock `credentialResolve` to return null. Call `buildProvider`.
   Expect error matching `/credential_store_set.*sendgrid_api_key/`.

3. **SMTP: credential store has password, build succeeds.** Mock
   `credentialResolve('smtp_password')` to return a password. Call
   `buildProvider({provider: 'smtp', host: '...', user: '...', from: '...'})`.
   Verify `SmtpProvider` is constructed with the store password and the
   inline host/user/from.

4. **SMTP: credential store empty, throws with credential_store_set
   message.** Same pattern.

5. **SMTP: missing required host/user fields, throws.** Credential store has
   password but input is missing host. Expect error about missing fields.

6. **Unknown provider, throws.** `provider: 'carrier-pigeon'` -- expect error.

7. **Address validation still works.** The existing `validateAddresses` tests
   remain unchanged.

### Integration test -- `tests/integration/send-email.integ.test.ts`

**Rewrite entirely.** Two test paths that prove both ways a secret enters the
credential store, and both end with a real email send.

#### Path 1: Workflow sets its own secret via `credential_store_set`

This is how a deterministic workflow operates in production -- it cannot ask a
human to run a CLI command mid-execution. The workflow calls
`credential_store_set` through the MCP client to store the secret, then calls
`send_email`.

```typescript
describe('Path 1: workflow stores secret via credential_store_set', () => {
  it('stores smtp_password via MCP, then sends email', async () => {
    // Step 1: workflow stores the secret via MCP tool
    // (in real life, the OOB terminal opens and the user types the secret;
    //  in the test, we use the programmatic credential_store_set path)
    await fleetApi.credentialStoreSet({
      name: 'smtp_password',
      prompt: 'Enter SMTP password',
      persist: false,
    });

    // Step 2: workflow calls send_email with inline config
    const result = await sendEmail({
      provider: 'smtp',
      host: testConfig.smtp.host,
      port: testConfig.smtp.port,
      user: testConfig.smtp.user,
      from: testConfig.smtp.from,
      to: testConfig.smtp.testTo,
      subject: '[apra-fleet] integ test - workflow path',
      body: 'Secret stored by workflow via credential_store_set.'
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.messageId).toBeTruthy();
  });
});
```

This proves the full deterministic workflow loop: store secret -> send email.
No human in the middle.

#### Path 2: User pre-stores secret via CLI, workflow just sends

This is the "set it once, use it forever" path. The user runs the CLI command
before the workflow ever executes:

```bash
apra-fleet secret --set smtp_password --persist
```

The test assumes the secret is already in the credential store (stored by the
developer before running the test suite). The workflow only calls `send_email`.

```typescript
describe('Path 2: secret pre-stored via CLI, workflow sends', () => {
  // Pre-condition: developer ran `apra-fleet secret --set smtp_password --persist`
  // before this test. If not, sendEmail returns an error and we skip.

  it('sends email with pre-stored credential', async () => {
    const result = await sendEmail({
      provider: 'smtp',
      host: testConfig.smtp.host,
      port: testConfig.smtp.port,
      user: testConfig.smtp.user,
      from: testConfig.smtp.from,
      to: testConfig.smtp.testTo,
      subject: '[apra-fleet] integ test - CLI pre-stored path',
      body: 'Secret was pre-stored via apra-fleet secret CLI.'
    });
    const parsed = JSON.parse(result);

    if (!parsed.ok && parsed.error.includes('credential_store_set')) {
      console.log('Skipping: smtp_password not pre-stored via CLI');
      return;
    }

    expect(parsed.ok).toBe(true);
    expect(parsed.messageId).toBeTruthy();
  });
});
```

#### Test config

Non-secret test parameters (host, port, user, test recipient addresses) come
from a gitignored `tests/integration/email-test-config.json`:

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

No secrets in this file. No env vars. Add `tests/integration/email-test-config.json`
to `.gitignore`.

#### Skip logic

Both paths are gated behind `SEND_EMAIL_INTEG=1` (the existing opt-in flag --
this is a test control flag, not email config). If the credential store does
not have the required secret, Path 2 skips gracefully. Path 1 stores its own
secret so it does not need a skip gate.

#### Same pattern for SendGrid

Both paths are duplicated for SendGrid (credential name: `sendgrid_api_key`).
Four test blocks total: workflow-path SMTP, CLI-path SMTP, workflow-path
SendGrid, CLI-path SendGrid.

### Hello-world workflow test

`packages/apra-fleet-workflow/test/apra-fleet-workflow-examples.test.mjs`:

- Verify hello-world still exits 0 when no fleet connection (email phase
  skips gracefully with `[SKIP]` message).
- No new test for "email actually sends" -- that is the integration test's
  job. The workflow test just verifies the gate works.

### Manual verification checklist

- [ ] `npm test` -- all unit tests pass
- [ ] `npm run build` -- no build errors
- [ ] Store `sendgrid_api_key` in credential store, call `send_email` with
      inline config -- email sends
- [ ] Call `send_email` with no secret in credential store -- error message
      says `credential_store_set`
- [ ] Run hello-world workflow without fleet -- exits 0, prints `[SKIP]`
- [ ] Run hello-world workflow with fleet + email configured -- sends email
- [ ] Grep entire repo for `process.env.SENDGRID`, `process.env.SMTP_PASS`,
      `process.env.EMAIL_PROVIDER` -- zero hits

## Out of scope

- No `apra-fleet config email` CLI command
- No changes to `credential_store_set` itself
- No changes to the `{{secure.NAME}}` resolution mechanism
- SMTP/SendGrid adapter internals unchanged (they take a config object,
  that contract stays the same)
