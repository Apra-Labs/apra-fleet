import net from 'node:net';
import { getSocketPath } from '../services/auth-socket.js';
import { secureInput } from '../utils/secure-input.js';

export async function runAuth(args: string[]): Promise<void> {
  const isApiKey = args.includes('--api-key');
  const memberName = args.find(a => !a.startsWith('--'));

  if (!memberName) {
    console.error('Usage: apra-fleet auth [--api-key] <member-name>');
    console.error('  Provides an SSH password or API key for a pending fleet operation.');
    process.exit(1);
  }

  if (isApiKey) {
    console.error(`\napra-fleet — Enter API key\n`);
    console.error(`  Member: ${memberName}\n`);
  } else {
    console.error(`\napra-fleet — Enter SSH password\n`);
    console.error(`  Member: ${memberName}\n`);
  }

  let password: string;
  try {
    password = await secureInput({ prompt: isApiKey ? '  API key: ' : '  Password: ' });
  } catch {
    console.error('Cancelled.');
    process.exit(1);
    return; // unreachable but satisfies TS
  }

  if (!password) {
    console.error(isApiKey ? '  ✗ Empty API key. Aborting.' : '  ✗ Empty password. Aborting.');
    process.exit(1);
  }

  // Connect to the auth socket
  const sockPath = getSocketPath();

  await new Promise<void>((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: memberName, password }) + '\n';
      // Best-effort clear — JS strings are immutable; original may persist in V8 heap until GC
      password = '';
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
          console.error(isApiKey ? '\n  ✓ API key received. You can close this window.\n' : '\n  ✓ Password received. You can close this window.\n');
          resolve();
        } else {
          console.error(`\n  ✗ Error: ${resp.error}\n`);
          reject(new Error(resp.error));
        }
      } catch {
        console.error('\n  ✗ Invalid response from server.\n');
        reject(new Error('Invalid server response'));
      }
      client.end();
    });

    client.on('error', (err) => {
      console.error(`\n  ✗ Could not connect to apra-fleet server.`);
      console.error(`    Is the MCP server running?\n`);
      reject(err);
    });
  }).catch(() => {
    process.exit(1);
  });
}
