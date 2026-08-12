/**
 * email-notify -- demonstrates sending email via the credential store.
 *
 * Secrets (API keys, passwords) live in the fleet credential store.
 * Non-secret config (host, port, user, from, recipient) is loaded from
 * a config.json file in this directory -- safe to commit, no secrets.
 *
 * Setup:
 *   1. Copy config.json.example to config.json and fill in your values.
 *   2. Store your secret:
 *      apra-fleet secret --set smtp_password --persist    (for SMTP)
 *      apra-fleet secret --set sendgrid_api_key --persist (for SendGrid)
 *   3. Run: apra-fleet workflow email-notify
 *
 * The workflow checks if the required credential exists. If not, it calls
 * credential_store_set to trigger the OOB prompt so the user can enter it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Phase 1: Load config ---

const configPath = resolve(__dirname, 'config.json');
if (!existsSync(configPath)) {
  console.error('[FAIL] config.json not found.');
  console.error('       Copy config.json.example to config.json and fill in your values.');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const requiredFields = ['provider', 'from', 'to'];
if (config.provider === 'smtp') requiredFields.push('host', 'user');

for (const field of requiredFields) {
  if (!config[field]) {
    console.error(`[FAIL] Missing required field "${field}" in config.json.`);
    process.exit(1);
  }
}

console.log(`[OK] Config loaded: provider=${config.provider}, to=${config.to}`);

// --- Phase 2: Connect to fleet ---

const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution')
  .catch(() => ({}));

if (!connectFleet) {
  console.error('[FAIL] Could not import @apralabs/apra-fleet-client. Is fleet installed?');
  process.exit(1);
}

const { fleetApi, mcpClient } = await connectFleet({ env: process.env }).catch(e => {
  console.error(`[FAIL] Could not connect to fleet server: ${e.message}`);
  process.exit(1);
  return {};
});

console.log('[OK] Connected to fleet server.');

// --- Phase 3: Check credential, prompt if missing ---

const credentialName = config.provider === 'smtp' ? 'smtp_password' : 'sendgrid_api_key';

const credListResult = await mcpClient.callTool('credential_store_list', {});
const credList = JSON.parse(credListResult.content[0].text);
const hasCredential = credList.credentials?.some(c => c.name === credentialName);

if (!hasCredential) {
  console.log(`[..] Credential "${credentialName}" not found. Prompting for it now...`);
  const setResult = await mcpClient.callTool('credential_store_set', {
    name: credentialName,
    prompt: `Enter your ${config.provider === 'smtp' ? 'SMTP password' : 'SendGrid API key'}`,
    persist: true,
  });
  console.log(`[OK] ${setResult.content[0].text}`);
} else {
  console.log(`[OK] Credential "${credentialName}" found in store.`);
}

// --- Phase 4: Send email ---
//
// CI note: in a pipeline with no human present, seed the credential by
// running the CLI directly in a pipeline step (stdin, never a command
// string): see docs/email-workflow-guide.md "CI / Pipeline" section.

console.log(`[..] Sending email to ${config.to}...`);

const sendArgs = {
  provider: config.provider,
  from: config.from,
  to: config.to,
  subject: config.subject || 'Notification from apra-fleet workflow',
  body: config.body || 'This email was sent by the email-notify example workflow. Secrets never left the credential store.',
};

if (config.provider === 'smtp') {
  sendArgs.host = config.host;
  sendArgs.port = config.port || 587;
  sendArgs.user = config.user;
  sendArgs.secure = config.secure || false;
}

const sendResult = await fleetApi.sendEmail(sendArgs);
const result = JSON.parse(sendResult.content[0].text);

if (result.ok) {
  console.log(`[OK] Email sent. messageId=${result.messageId}`);
} else {
  console.error(`[FAIL] Send failed: ${result.error}`);
  process.exit(1);
}

process.exit(0);
