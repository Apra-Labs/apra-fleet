import net from 'node:net';
import readline from 'node:readline';
import { getSocketPath } from '../services/auth-socket.js';
import { collectSecret } from '../utils/collect-secret.js';
import {
  BoundSecretError,
  credentialSetValue,
  credentialList,
  credentialDelete,
  credentialUpdate,
  isLiveSecret,
  LiveRegistrationError,
  prepareLiveSecret,
  saveLiveSecret,
  SecretInUseError,
  type CredentialUpdatePatch,
  type NetworkPolicy,
  type LiveSecretSpec,
} from '../services/credential-store.js';
import { mintLiveSecret } from '../services/live-secret-cache.js';
import { LiveSecretError } from '../services/live-secret-runner.js';
import { hasMemberInstallMarker } from './install-guard.js';

const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

const LIVE_USAGE_INLINE = "  apra-fleet secret --live <name> --inline '<script with {{secret.R}}>'";
const LIVE_USAGE_FILE = "  apra-fleet secret --live <name> [--env 'VAR={{secret.R}}']... <script file> [args]";

export async function runSecret(args: string[]): Promise<void> {
  // Title the OOB credential-entry console the server opened on Windows
  // (env name = OOB_WINDOW_TITLE_ENV in services/auth-socket.ts).
  const oobTitle = process.env.APRA_FLEET_OOB_WINDOW_TITLE;
  if (oobTitle && process.platform === 'win32') {
    try { process.title = oobTitle; } catch { /* cosmetic only */ }
  }

  // After `--live <name>` the args belong to the script, or are its inline text.
  const ownArgs = args[0] === '--live' ? args.slice(0, 2) : args;
  if (ownArgs.includes('--help') || ownArgs.includes('-h') || args.length === 0) {
    console.error('Usage:');
    console.error('  apra-fleet secret --set <name> [--persist] [-y]');
    console.error(LIVE_USAGE_INLINE);
    console.error(LIVE_USAGE_FILE);
    console.error('  apra-fleet secret --list');
    console.error('  apra-fleet secret --update <name> [--members <list>] [--ttl <seconds>] [--allow|--deny]');
    console.error('  apra-fleet secret --delete <name>');
    console.error('  apra-fleet secret --delete --all');
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args[0] === '--set') {
    await handleSet(args.slice(1));
  } else if (args[0] === '--live') {
    await handleLive(args.slice(1));
  } else if (args[0] === '--list') {
    await handleList();
  } else if (args[0] === '--update') {
    await handleUpdate(args.slice(1));
  } else if (args[0] === '--delete') {
    await handleDelete(args.slice(1));
  } else if (args[0] === '--confirm') {
    refuseRemovedConfirm();
  } else {
    console.error('Usage: apra-fleet secret --set <name> [--persist]');
    process.exit(1);
  }
}

/** Text for an inline script that arrived as more than one argument. Fixed: the arguments may hold a value. */
const INLINE_EXTRA_ARGS = 'FAILED: inline-extra-args: --inline takes one script and cannot be combined with a script path. If you did not add more arguments, Windows PowerShell 5.1 stripped the double quotes of your inline script and split it: avoid double quotes in inline scripts there, or use a script file.';

/**
 * The script form of `--live`, or a usage failure. Options come first; parsing
 * stops at the first argument that is not one, which is the script path, and the
 * rest goes to the script untouched. `--` is optional, because npm's PowerShell
 * shim drops a bare `--`; it is how a script path starting with `-` is passed.
 */
function parseLiveArgs(args: string[]): LiveSecretSpec | { failure: string | null } {
  if (args[0] === '--inline') {
    if (!args[1]) return { failure: null };
    return args.length === 2 ? { inline: args[1] } : { failure: INLINE_EXTRA_ARGS };
  }
  const env: Array<{ env: string; value: string }> = [];
  let i = 0;
  for (; args[i] === '--env'; i += 2) {
    const pair = args[i + 1];
    const eq = pair?.indexOf('=') ?? -1;
    if (eq <= 0) return { failure: null };
    env.push({ env: pair.slice(0, eq), value: pair.slice(eq + 1) });
  }
  if (args[i] === '--') i++;
  else if (args[i]?.startsWith('-')) return { failure: null };
  if (!args[i]) return { failure: null };
  return { program: args[i], args: args.slice(i + 1), env };
}

/**
 * Register a live secret: check the bindings, run the script once in this
 * process, and save it only if that worked. The token is discarded and the
 * script's output is never shown. No failure path echoes the script text.
 */
async function handleLive(args: string[]): Promise<void> {
  // Temporary limit for 0.4.5, to be removed: renewal comes only from the
  // orchestrator, so fleet would not manage a live secret registered on a remote
  // member. The marker is in the data dir this command would write to.
  if (hasMemberInstallMarker()) {
    console.error("FAILED: member-install: this is a remote member's install (data/member-install.json), where a live secret cannot be registered. Register it on the orchestrator, which is the only place fleet renews live secrets. If this machine is your orchestrator, rerun apra-fleet install: a full install clears that marker.");
    process.exit(1);
  }
  const name = args[0];
  const spec = parseLiveArgs(args.slice(1));
  if (!name || name.startsWith('-') || 'failure' in spec) {
    const failure = name && !name.startsWith('-') && 'failure' in spec ? spec.failure : null;
    if (failure) {
      console.error(failure);
    } else {
      console.error('Usage:');
      console.error(LIVE_USAGE_INLINE);
      console.error(LIVE_USAGE_FILE);
    }
    process.exit(1);
  }
  if (!NAME_REGEX.test(name)) {
    console.error(`x Invalid credential name: ${name}`);
    console.error('  Name must match [a-zA-Z0-9_-]{1,64}');
    process.exit(1);
  }
  try {
    const record = prepareLiveSecret(name, spec);
    const minted = await mintLiveSecret(record);
    saveLiveSecret(record);
    console.log(`OK: expires ${minted.expiresAt}`);
  } catch (err) {
    if (err instanceof LiveRegistrationError) {
      console.error(`FAILED: ${err.reasonCode}: ${err.message}`);
    } else if (err instanceof LiveSecretError) {
      const exit = err.exitCode === null ? '' : ` exit=${err.exitCode}`;
      console.error(`FAILED: ${err.reasonCode}${exit}`);
    } else {
      console.error('FAILED: unexpected');
    }
    process.exit(1);
  }
}

/** `--confirm` went with the confirm network policy; a stale script gets the reason, not a usage line. */
function refuseRemovedConfirm(): void {
  console.error('x --confirm was removed: the confirm network policy no longer exists.');
  console.error('  Choose a policy instead: apra-fleet secret --update <name> --allow, or --deny.');
  process.exit(1);
}

async function handleList(): Promise<void> {
  const credentials = credentialList();

  if (credentials.length === 0) {
    console.log('No secrets stored.');
    return;
  }

  const rows: string[][] = [];
  const headers = ['NAME', 'SCOPE', 'POLICY', 'MEMBERS', 'EXPIRES'];
  rows.push(headers);

  for (const cred of credentials) {
    const membersStr = Array.isArray(cred.allowedMembers) ? cred.allowedMembers.join(',') : cred.allowedMembers;
    const expiresStr = cred.expiresAt ? new Date(cred.expiresAt).toLocaleString() : '—';
    rows.push([cred.name, cred.kind ?? cred.scope, cred.network_policy, membersStr, expiresStr]);
  }

  // Calculate column widths
  const colWidths = headers.map((_, i) => Math.max(...rows.map(r => r[i].length)));

  // Print header
  console.log(rows[0].map((h, i) => h.padEnd(colWidths[i])).join('  '));
  console.log(colWidths.map(w => '—'.repeat(w)).join('  '));

  // Print rows
  for (let i = 1; i < rows.length; i++) {
    console.log(rows[i].map((cell, j) => cell.padEnd(colWidths[j])).join('  '));
  }
}

async function handleUpdate(args: string[]): Promise<void> {
  if (args.includes('--confirm')) refuseRemovedConfirm();

  const name = args[0];
  if (!name) {
    console.error('Usage: apra-fleet secret --update <name> [--members <list>] [--ttl <seconds>] [--allow|--deny]');
    process.exit(1);
  }

  if (!NAME_REGEX.test(name)) {
    console.error(`✗ Invalid credential name: ${name}`);
    console.error('  Name must match [a-zA-Z0-9_-]{1,64}');
    process.exit(1);
  }

  const patch: CredentialUpdatePatch = {};

  // Parse --allow or --deny
  if (args.includes('--allow')) {
    patch.network_policy = 'allow';
  } else if (args.includes('--deny')) {
    patch.network_policy = 'deny';
  }

  // Parse --members
  const membersIdx = args.indexOf('--members');
  if (membersIdx !== -1 && membersIdx + 1 < args.length) {
    patch.members = args[membersIdx + 1];
  }

  // Parse --ttl
  const ttlIdx = args.indexOf('--ttl');
  if (ttlIdx !== -1 && ttlIdx + 1 < args.length) {
    const ttlSeconds = parseInt(args[ttlIdx + 1], 10);
    if (isNaN(ttlSeconds) || ttlSeconds <= 0) {
      console.error('✗ Invalid TTL: must be a positive number');
      process.exit(1);
    }
    patch.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  if (Object.keys(patch).length === 0) {
    console.error('✗ No fields to update — specify at least one of: --allow, --deny, --members, --ttl');
    process.exit(1);
  }

  if (patch.expiresAt !== undefined && isLiveSecret(name)) {
    console.error(`x --ttl does not apply to live secret ${name}: its expiry comes from its token`);
    process.exit(1);
  }

  let result: ReturnType<typeof credentialUpdate>;
  try {
    result = credentialUpdate(name, patch);
  } catch (err) {
    if (!(err instanceof BoundSecretError)) throw err;
    console.error(`x ${err.message}`);
    process.exit(1);
    return;
  }
  if (!result) {
    console.error(`✗ Credential not found: ${name}`);
    process.exit(1);
  }

  console.log(`✓ Credential updated: ${name}`);
}

async function handleDelete(args: string[]): Promise<void> {
  const deleteAll = args.includes('--all');
  const name = deleteAll ? undefined : args[0];

  if (deleteAll) {
    // Prompt for confirmation
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question('Delete all secrets? Type yes to confirm: ', (ans) => {
        rl.close();
        resolve(ans);
      });
    });

    if (answer !== 'yes') {
      console.log('Cancelled.');
      return;
    }

    // Live secrets first: they hold the bindings that keep the other secrets from being deleted.
    const allCreds = credentialList();
    const liveFirst = [...allCreds.filter((c) => c.kind === 'live'), ...allCreds.filter((c) => c.kind !== 'live')];
    let deletedCount = 0;
    for (const cred of liveFirst) {
      if (credentialDelete(cred.name)) {
        deletedCount++;
      }
    }
    console.log(`✓ Deleted ${deletedCount} credential(s).`);
  } else {
    if (!name) {
      console.error('Usage: apra-fleet secret --delete <name> | apra-fleet secret --delete --all');
      process.exit(1);
    }

    if (!NAME_REGEX.test(name)) {
      console.error(`✗ Invalid credential name: ${name}`);
      console.error('  Name must match [a-zA-Z0-9_-]{1,64}');
      process.exit(1);
    }

    let deleted: boolean;
    try {
      deleted = credentialDelete(name);
    } catch (err) {
      if (!(err instanceof SecretInUseError)) throw err;
      console.error(`x ${err.message}`);
      console.error('  Delete the live secret that uses it first: apra-fleet secret --delete <live secret>');
      process.exit(1);
      return;
    }
    if (!deleted) {
      console.error(`✗ Credential not found: ${name}`);
      process.exit(1);
    }

    console.log(`✓ Credential deleted: ${name}`);
  }
}

function policyNote(name: string, policy: NetworkPolicy): string {
  return policy === 'allow'
    ? `  i Network policy: allow. Use 'apra-fleet secret --update ${name} --deny' to restrict.`
    : `  i Network policy: ${policy}.`;
}

async function handleSet(args: string[]): Promise<void> {
  const name = args[0];
  const persist = args.includes('--persist');
  const askPersist = args.includes('--ask-persist');
  const nonInteractive = args.includes('-y');
  const promptIdx = args.indexOf('--prompt');
  const customPrompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined;

  if (!name) {
    console.error('Usage: apra-fleet secret --set <name> [--persist] [-y]');
    process.exit(1);
  }

  if (!NAME_REGEX.test(name)) {
    console.error(`✗ Invalid credential name: ${name}`);
    console.error('  Name must match [a-zA-Z0-9_-]{1,64}');
    process.exit(1);
  }

  // Validate flags before prompting for user input
  const knownFlagExact = new Set(['--persist', '--ask-persist', '-y', '--prompt']);
  for (const a of args.slice(1)) {
    if (!a.startsWith('-')) continue; // positional value (e.g. value for --prompt)
    if (knownFlagExact.has(a)) continue;
    console.error(`Error: Unknown option "${a}". Run 'apra-fleet secret --help' for usage.`);
    process.exit(1);
  }

  let secretValue: string;
  if (nonInteractive) {
    secretValue = await new Promise<string>((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => {
        const trimmed = data.trim();
        if (!trimmed) {
          console.error('✗ Empty value on stdin. Aborting.');
          process.exit(1);
        }
        resolve(trimmed);
      });
      process.stdin.on('error', reject);
      process.stdin.resume();
    });
  } else {
    const displayPrompt = customPrompt ?? `Enter value for ${name}`;
    secretValue = await collectSecret(displayPrompt);
  }

  let finalPersist = persist;
  if (askPersist && !persist) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question('  Persist this secret? (y/n): ', (ans) => {
        rl.close();
        resolve(ans);
      });
    });
    finalPersist = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  }

  const sockPath = getSocketPath();
  // Captured before the socket handler below wipes secretValue, so the
  // local --persist path (which runs after that wipe, once we know whether
  // the OOB delivery succeeded) still has a value to store instead of
  // silently persisting an empty string.
  let persistValue = secretValue;
  const waitForServer = new Promise<boolean>((resolve) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: name, password: secretValue, persist: finalPersist }) + '\n';
      secretValue = '';
      client.write(msg);
    });

    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;

      const line = buffer.slice(0, nl);
      try {
        const resp = JSON.parse(line);
        if (resp.ok) {
          console.error(`✓ Secret delivered for ${name}. You can close this window.`);
          resolve(true);
        } else {
          resolve(false);
        }
      } catch {
        console.error('✗ Invalid response from server.');
        resolve(false);
      }
      client.end();
    });

    client.on('error', () => {
      // No server listening: handle based on persist flag
      resolve(false);
    });

    client.on('close', () => {
      // If we haven't resolved yet, the server wasn't listening
      resolve(false);
    });
  });

  const delivered = await waitForServer;

  if (!delivered) {
    if (!persist) {
      console.error(`ℹ No waiting request — use --persist to store.`);
      process.exit(1);
    }

    // Persist mode: store the secret
    try {
      const meta = credentialSetValue(name, persistValue, { persist: true });
      console.error(`✓ Secret stored for ${name}.`);
      console.error(policyNote(name, meta.network_policy));
    } catch (err: any) {
      console.error(`✗ Failed to store secret: ${err.message}`);
      process.exit(1);
    }
  } else if (persist) {
    // OOB delivery + persist: store the secret
    try {
      const meta = credentialSetValue(name, persistValue, { persist: true });
      console.error(`✓ Secret also stored for future use.`);
      console.error(policyNote(name, meta.network_policy));
    } catch (err: any) {
      console.error(`✗ Failed to store secret: ${err.message}`);
      process.exit(1);
    }
  }
  persistValue = '';
}
