import net from 'node:net';
import { getSocketPath } from '../services/auth-socket.js';

/**
 * Read a password from stdin with hidden input (echo '*' per character).
 */
function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);

    if (!process.stdin.isTTY) {
      // Non-interactive: read a line from stdin
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
        const nl = data.indexOf('\n');
        if (nl !== -1) {
          resolve(data.slice(0, nl));
        }
      });
      process.stdin.on('end', () => resolve(data.trim()));
      return;
    }

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    let password = '';

    const onData = (ch: string) => {
      const code = ch.charCodeAt(0);

      if (ch === '\r' || ch === '\n') {
        // Enter
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(password);
      } else if (code === 3) {
        // Ctrl+C
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        reject(new Error('Cancelled'));
      } else if (code === 127 || code === 8) {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else if (code >= 32) {
        // Printable character
        password += ch;
        process.stderr.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

export async function runAuth(args: string[]): Promise<void> {
  const memberName = args[0];

  if (!memberName) {
    console.error('Usage: apra-fleet auth <member-name>');
    console.error('  Provides an SSH password for a pending fleet registration.');
    process.exit(1);
  }

  console.error(`\napra-fleet — Enter SSH password\n`);
  console.error(`  Member: ${memberName}\n`);

  let password: string;
  try {
    password = await readPassword('  Password: ');
  } catch {
    console.error('Cancelled.');
    process.exit(1);
    return; // unreachable but satisfies TS
  }

  if (!password) {
    console.error('  ✗ Empty password. Aborting.');
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
          console.error('\n  ✓ Password received. You can close this window.\n');
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
