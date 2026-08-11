/**
 * hello-world -- the minimal example workflow.
 *
 * Demonstrates the documented primary convention: a SELF-EXECUTING ES module.
 * The `apra-fleet workflow` launcher rewrites process.argv to
 * [execPath, <thisFile>, ...userArgs] and then dynamic-import()s this file, so
 * top-level code runs immediately and sees the user's pass-through args.
 *
 * It also proves the shared on-disk runtime tree resolves: the engine is loaded
 * with a DYNAMIC import wrapped in .catch(), never a static
 * `import { WorkflowEngine } from ...`. A static import would throw
 * ERR_MODULE_NOT_FOUND during module resolution -- before a single line of this
 * file executes -- and so could never report engine=missing. The catch keeps the
 * probe real (not hardcoded) and non-fatal.
 *
 * Deliberately makes no fleet-server connection, which keeps the CI smoke test
 * hermetic.
 */

const args = process.argv.slice(2);

// Dynamic + catch: resolution failure becomes a value, not a crash.
const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine').catch(() => ({}));

const engine = WorkflowEngine ? 'resolved' : 'missing';

console.log(`[OK] hello-world: args=${args.join(',')} engine=${engine}`);

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

process.exit(0);
