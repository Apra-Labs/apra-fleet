import net from 'node:net';
// @inquirer/password v5.x: masks input with '*' by default.
// No built-in reveal toggle exists in this version — input stays masked throughout.
import password from '@inquirer/password';
import { getSocketPath } from '../services/auth-socket.js';
import { secureInput } from '../utils/secure-input.js';

export async function runAuth(args: string[]): Promise<void> {
  const isApiKey = args.includes('--api-key');
  const isConfirm = args.includes('--confirm');
  const memberName = args.find(a => !a.startsWith('--'));

  if (!memberName) {
    console.error('Usage: apra-fleet auth [--api-key|--confirm] <member-name>');
    console.error('  Provides an SSH password or API key for a pending fleet operation.');
    process.exit(1);
  }

  if (isConfirm) {
    console.error(`\napra-fleet — Network Egress Confirmation\n`);
    console.error(`  Credential: ${memberName}\n`);
    console.error(`  A command using this credential is about to access the network.\n`);
  } else if (isApiKey) {
    console.error(`\napra-fleet — Enter API key\n`);
    console.error(`  Member: ${memberName}\n`);
  } else {
    console.error(`\napra-fleet — Enter SSH password\n`);
    console.error(`  Member: ${memberName}\n`);
  }

  let inputValue: string;
  try {
    const prompt = isConfirm ? '  Type "yes" to allow network access: ' : isApiKey ? '  API key: ' : '  Password: ';
    password = await secureInput({ prompt });
  } catch {
    console.error('Cancelled.');
    process.exit(1);
    return; // unreachable but satisfies TS
  }

  if (isConfirm) {
    if (password.toLowerCase() !== 'yes') {
      console.error('  ✗ Confirmation not received. Aborting.');
      process.exit(1);
      return;
    }
  } else if (!password) {
    console.error(isApiKey ? '  ✗ Empty API key. Aborting.' : '  ✗ Empty password. Aborting.');
    process.exit(1);
  }

  // Connect to the auth socket
  const sockPath = getSocketPath();

  await new Promise<void>((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: memberName, password: inputValue }) + '\n';
      // Best-effort clear — JS strings are immutable; original may persist in V8 heap until GC
      inputValue = '';
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
          const successMsg = isConfirm
            ? '\n  ✓ Confirmed. You can close this window.\n'
            : isApiKey ? '\n  ✓ API key received. You can close this window.\n' : '\n  ✓ Password received. You can close this window.\n';
          console.error(successMsg);
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
