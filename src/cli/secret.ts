import net from 'node:net';
import { getSocketPath } from '../services/auth-socket.js';
import { secureInput } from '../utils/secure-input.js';
import { credentialSet } from '../services/credential-store.js';

const NAME_REGEX = /^[a-zA-Z0-9_]{1,64}$/;

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
    console.error('--list not yet implemented');
    process.exit(1);
  } else if (args[0] === '--update') {
    console.error('--update not yet implemented');
    process.exit(1);
  } else if (args[0] === '--delete') {
    console.error('--delete not yet implemented');
    process.exit(1);
  } else {
    console.error('Usage: apra-fleet secret --set <name> [--persist]');
    process.exit(1);
  }
}

async function handleSet(args: string[]): Promise<void> {
  const name = args[0];
  const persist = args.includes('--persist');

  if (!name) {
    console.error('Usage: apra-fleet secret --set <name> [--persist]');
    process.exit(1);
  }

  if (!NAME_REGEX.test(name)) {
    console.error(`✗ Invalid credential name: ${name}`);
    console.error('  Name must match [a-zA-Z0-9_]{1,64}');
    process.exit(1);
  }

  let secretValue: string;
  try {
    secretValue = await secureInput({ prompt: `Enter value for ${name}: ` });
  } catch {
    console.error('Cancelled.');
    process.exit(1);
    return;
  }

  if (!secretValue) {
    console.error('✗ Empty value. Aborting.');
    process.exit(1);
  }

  const sockPath = getSocketPath();
  const waitForServer = new Promise<boolean>((resolve) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: name, password: secretValue }) + '\n';
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
          console.error(`✗ Server error: ${resp.error}`);
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
      console.error(`✗ No pending request for ${name}. Use --persist to store for future use.`);
      process.exit(1);
    }

    // Persist mode: store the secret
    try {
      credentialSet(name, secretValue, true, 'confirm');
      console.error(`✓ Secret stored for ${name}.`);
    } catch (err: any) {
      console.error(`✗ Failed to store secret: ${err.message}`);
      process.exit(1);
    }
  } else if (persist) {
    // OOB delivery + persist: store the secret
    try {
      credentialSet(name, secretValue, true, 'confirm');
      console.error(`✓ Secret also stored for future use.`);
    } catch (err: any) {
      console.error(`✗ Failed to store secret: ${err.message}`);
      process.exit(1);
    }
  }
}
