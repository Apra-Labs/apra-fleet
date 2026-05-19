import net from 'node:net';
import readline from 'node:readline';
import { getSocketPath } from '../auth-socket.js';

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);

    if (!process.stdin.isTTY) {
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
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(password);
      } else if (code === 3) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        reject(new Error('Cancelled'));
      } else if (code === 127 || code === 8) {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else if (code >= 32) {
        password += ch;
        process.stderr.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

export async function runAuth(args: string[]): Promise<void> {
  const isConfirm = args.includes('--confirm');
  const memberName = args.find(a => !a.startsWith('--'));

  if (!memberName) {
    console.error('Usage: blindfold auth [--confirm] <name>');
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(memberName)) {
    console.error('Error: member name must contain only alphanumeric, underscore, or hyphen characters (max 64).');
    process.exit(1);
  }

  if (isConfirm) {
    const contextIdx = args.indexOf('--context');
    const rawCommandContext = contextIdx !== -1 && contextIdx + 1 < args.length ? args[contextIdx + 1] : undefined;
    const onIdx = args.indexOf('--on');
    const rawMemberContext = onIdx !== -1 && onIdx + 1 < args.length ? args[onIdx + 1] : undefined;
    const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ');
    const commandContext = rawCommandContext !== undefined ? sanitize(rawCommandContext) : undefined;
    const memberContext = rawMemberContext !== undefined ? sanitize(rawMemberContext) : undefined;

    console.error(`\nblindfold — Network Egress Confirmation\n`);
    if (commandContext && memberContext) {
      console.error(`  This command on ${memberContext} will send credential "${memberName}" over the network:`);
      console.error(`  ${commandContext}`);
    } else {
      console.error(`  Credential "${memberName}" will be sent over the network.`);
      if (memberContext) console.error(`  Member:  ${memberContext}`);
      if (commandContext) console.error(`  Command: ${commandContext}`);
    }
    console.error('');
  } else {
    console.error(`\nblindfold — Enter password\n`);
    console.error(`  Name: ${memberName}\n`);
  }

  let password: string;
  try {
    if (isConfirm) {
      password = await new Promise<string>((resolve, reject) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question('  Type "yes" to allow network access: ', (answer) => {
          rl.close();
          resolve(answer);
        });
        rl.on('close', () => resolve(''));
        rl.on('error', reject);
      });
    } else {
      password = await readPassword('  Password: ');
    }
  } catch {
    console.error('Cancelled.');
    process.exit(1);
    return;
  }

  if (!isConfirm && !password) {
    console.error('  ✗ Empty password. Aborting.');
    process.exit(1);
  }

  if (isConfirm) {
    if (password.toLowerCase() !== 'yes') {
      console.error('  ✗ Denied.');
      process.exit(1);
    }
    password = 'yes';
  }

  const sockPath = getSocketPath();

  await new Promise<void>((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      const msg = JSON.stringify({ type: 'auth', member_name: memberName, password }) + '\n';
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
          console.error(isConfirm ? '\n  ✓ Confirmed. You can close this window.\n' : '\n  ✓ Password received. You can close this window.\n');
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
      console.error(`\n  ✗ Could not connect to blindfold server.`);
      console.error(`    Is the MCP server running?\n`);
      reject(err);
    });
  }).catch(() => {
    process.exit(1);
  });
}
