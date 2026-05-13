import net from 'node:net';
import readline from 'node:readline';
import { getSocketPath } from '../services/auth-socket.js';

export async function runAuth(args: string[]): Promise<void> {
  const isConfirm = args.includes('--confirm');
  const memberName = args.find((a) => !a.startsWith('--'));

  if (!memberName) {
    console.error('Usage: apra-fleet auth --confirm <member-name>');
    process.exit(1);
  }

  if (!isConfirm) {
    console.error('Usage: apra-fleet auth --confirm <member-name>');
    process.exit(1);
  }

  // Reject unknown flags before prompting for user input
  const knownFlagExact = new Set(['--confirm']);
  for (const a of args) {
    if (!a.startsWith('-')) continue; // positional (member name)
    if (knownFlagExact.has(a)) continue;
    console.error(`Error: Unknown option "${a}". Usage: apra-fleet auth --confirm <member-name>`);
    process.exit(1);
  }

  console.error(`\napra-fleet — Network Egress Confirmation\n`);
  console.error(`  Credential: ${memberName}\n`);
  console.error(`  A command using this credential is about to access the network.\n`);

  let inputValue: string;
  try {
    inputValue = await new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question('  Type "yes" to allow network access: ', (answer) => {
        rl.close();
        resolve(answer);
      });
      rl.on('close', () => resolve(''));
      rl.on('error', reject);
    });
  } catch {
    console.error('Cancelled.');
    process.exit(1);
    return;
  }

  if (inputValue.toLowerCase() !== 'yes') {
    console.error('  ✗ Confirmation not received. Aborting.');
    process.exit(1);
    return;
  }

  const sockPath = getSocketPath();

  await new Promise<void>((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: memberName, password: inputValue }) + '\n';
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
          console.error('\n  ✓ Confirmed. You can close this window.\n');
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
