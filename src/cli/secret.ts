import net from 'node:net';
import readline from 'node:readline';
import { getSocketPath } from '../services/auth-socket.js';
import { collectSecret } from '../utils/collect-secret.js';
import { credentialSet, credentialList, credentialDelete, credentialUpdate, type CredentialUpdatePatch } from '../services/credential-store.js';

const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export async function runSecret(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.error('Usage:');
    console.error('  apra-fleet secret --set <name> [--persist]');
    console.error('  apra-fleet secret --list');
    console.error('  apra-fleet secret --update <name> [--members <list>] [--ttl <seconds>] [--allow|--deny]');
    console.error('  apra-fleet secret --delete <name>');
    console.error('  apra-fleet secret --delete --all');
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args[0] === '--set') {
    await handleSet(args.slice(1));
  } else if (args[0] === '--list') {
    await handleList();
  } else if (args[0] === '--update') {
    await handleUpdate(args.slice(1));
  } else if (args[0] === '--delete') {
    await handleDelete(args.slice(1));
  } else {
    console.error('Usage: apra-fleet secret --set <name> [--persist]');
    process.exit(1);
  }
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
    rows.push([cred.name, cred.scope, cred.network_policy, membersStr, expiresStr]);
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

  const result = credentialUpdate(name, patch);
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

    // Delete all
    const allCreds = credentialList();
    let deletedCount = 0;
    for (const cred of allCreds) {
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

    if (!credentialDelete(name)) {
      console.error(`✗ Credential not found: ${name}`);
      process.exit(1);
    }

    console.log(`✓ Credential deleted: ${name}`);
  }
}

async function handleSet(args: string[]): Promise<void> {
  const name = args[0];
  const persist = args.includes('--persist');
  const askPersist = args.includes('--ask-persist');
  const promptIdx = args.indexOf('--prompt');
  const customPrompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined;

  if (!name) {
    console.error('Usage: apra-fleet secret --set <name> [--persist]');
    process.exit(1);
  }

  if (!NAME_REGEX.test(name)) {
    console.error(`✗ Invalid credential name: ${name}`);
    console.error('  Name must match [a-zA-Z0-9_-]{1,64}');
    process.exit(1);
  }

  const displayPrompt = customPrompt ?? `Enter value for ${name}`;
  let secretValue = await collectSecret(displayPrompt);

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
      credentialSet(name, secretValue, true, 'allow');
      console.error(`✓ Secret stored for ${name}.`);
      console.error(`  ℹ Network policy: allow. Use 'apra-fleet secret --update ${name} --deny' to restrict.`);
    } catch (err: any) {
      console.error(`✗ Failed to store secret: ${err.message}`);
      process.exit(1);
    }
  } else if (persist) {
    // OOB delivery + persist: store the secret
    try {
      credentialSet(name, secretValue, true, 'allow');
      console.error(`✓ Secret also stored for future use.`);
      console.error(`  ℹ Network policy: allow. Use 'apra-fleet secret --update ${name} --deny' to restrict.`);
    } catch (err: any) {
      console.error(`✗ Failed to store secret: ${err.message}`);
      process.exit(1);
    }
  }
}
