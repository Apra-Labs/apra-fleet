# Email in Workflows

Workflows send email via the `send_email` fleet tool. Secrets (API keys,
passwords) live in the fleet credential store -- encrypted, never visible to
the workflow. Non-secret config (provider, host, port, from address) is passed
inline by the workflow, loaded however the author prefers.

## One-time setup

Store your email secret in the credential store. This is done once per
machine, not per workflow.

**SMTP:**

```bash
apra-fleet secret --set smtp_password --persist
```

**SendGrid:**

```bash
apra-fleet secret --set sendgrid_api_key --persist
```

An OOB terminal opens, you type the secret, it gets encrypted and stored.
The secret never appears in any file, log, or chat.

An LLM agent can also store credentials via the MCP tool:

```
credential_store_set({ name: "smtp_password", prompt: "Enter SMTP password", persist: true })
```

The OOB prompt still opens for the human -- the agent never sees the secret.

## Sending email from a workflow

A workflow calls `send_email` through the fleet MCP client. Non-secret config
is passed inline. The credential store provides the password/API key
automatically.

```javascript
import { connectFleet } from '@apralabs/apra-fleet-client/server-resolution';

const { fleetApi } = await connectFleet({ env: process.env });

const result = JSON.parse(await fleetApi.sendEmail({
  provider: 'smtp',
  host: 'smtp.gmail.com',
  port: 587,
  user: 'notifications@example.com',
  from: 'noreply@example.com',
  to: 'team@example.com',
  subject: 'Sprint complete',
  body: 'All tasks passed verification.'
}));

if (result.ok) {
  console.log(`Sent: ${result.messageId}`);
} else {
  console.error(`Failed: ${result.error}`);
}
```

No secrets in this code. The SMTP password resolves from the credential store
server-side.

## Loading config from a file

For reusable workflows, keep non-secret config in a JSON file:

```json
{
  "provider": "smtp",
  "host": "smtp.gmail.com",
  "port": 587,
  "user": "notifications@example.com",
  "from": "noreply@example.com",
  "to": "team@example.com"
}
```

This file is safe to commit -- it has no secrets. Load it in your workflow:

```javascript
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('./config.json', 'utf8'));

await fleetApi.sendEmail({
  provider: config.provider,
  host: config.host,
  port: config.port,
  user: config.user,
  from: config.from,
  to: config.to,
  subject: 'Sprint complete',
  body: 'All tasks passed.'
});
```

## Handling missing credentials

A workflow can check if the required credential exists and prompt the user
to store it if not. This makes the workflow self-contained -- the user does
not need to run a separate CLI command first.

```javascript
const credentialName = config.provider === 'smtp' ? 'smtp_password' : 'sendgrid_api_key';

// credential_store_list returns a JSON array of { name, scope, ... } entries.
const credList = JSON.parse(await fleetApi.credentialStoreList({}));
const hasCredential = Array.isArray(credList) && credList.some(c => c.name === credentialName);

if (!hasCredential) {
  console.log(`Credential "${credentialName}" not found. Prompting...`);
  await fleetApi.credentialStoreSet({
    name: credentialName,
    prompt: `Enter your ${config.provider === 'smtp' ? 'SMTP password' : 'SendGrid API key'}`,
    persist: true,
  });
}
```

The `credential_store_set` call opens the OOB terminal. The user types the
secret once. All subsequent `send_email` calls resolve it automatically.

## CI / Pipeline: setting credentials programmatically

In a CI pipeline or automated environment where no human is present to type
the secret, run the CLI directly in a pipeline step and pipe the value from
your vault over stdin:

```bash
# In your CI step (not via execute_command):
aws secretsmanager get-secret-value --secret-id smtp-password \
  --query SecretString --output text \
  | apra-fleet secret --set smtp_password --persist -y
```

The `-y` flag reads the value from stdin instead of opening the OOB terminal.
Swap the left-hand side for however your vault exposes secrets (Azure Key
Vault, HashiCorp Vault, a CI-masked environment variable, etc.).

Do NOT route this through the `execute_command` MCP tool: the secret would
be embedded in the command string, which is visible to the LLM session and
recorded in the command audit trail. Piping over stdin in a direct CI step
keeps the value out of command strings and process listings.

## Complete example

See `examples/workflows/email-notify/` for a runnable workflow that
demonstrates the full pattern:

1. Loads config from `config.json`
2. Connects to the fleet server
3. Checks if the credential exists, prompts if not
4. Sends the email
5. Reports success or failure

To run it:

```bash
cd examples/workflows/email-notify
cp config.json.example config.json   # edit with your values
apra-fleet workflow email-notify
```

## send_email parameter reference

| Parameter | Type | Required | Description |
|---|---|---|---|
| `provider` | `"sendgrid"` or `"smtp"` | no (default: `"sendgrid"`) | Email provider |
| `from` | string | yes | Sender email address |
| `host` | string | SMTP only | SMTP server hostname |
| `port` | number | no (default: 587) | SMTP server port |
| `user` | string | SMTP only | SMTP username |
| `secure` | boolean | no (default: false) | Implicit TLS (port 465) |
| `to` | string or string[] | yes | Recipient address(es) |
| `subject` | string | yes | Subject line |
| `body` | string | yes | Plain-text body |
| `html` | string | no | HTML body |
| `cc` | string[] | no | CC addresses |
| `bcc` | string[] | no | BCC addresses |
| `attachments` | attachment[] | no | Base64-encoded file attachments |

Secrets resolved from the credential store:
- **SendGrid:** `sendgrid_api_key`
- **SMTP:** `smtp_password`

Returns: `{ ok: true, messageId }` on success, `{ ok: false, error }` on failure.
