import { secureInput } from './secure-input.js';
import { getOobTimeoutMs } from './oob-timeout.js';

const readKey = (): Promise<Buffer> =>
  new Promise<Buffer>((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (buf: Buffer) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(buf);
    });
  });

export async function collectSecret(prompt: string): Promise<string> {
  const timeout = setTimeout(() => {
    process.stderr.write('\n  ⏱ Timed out. Closing.\n');
    process.exit(1);
  }, getOobTimeoutMs());

  let secretValue: string;
  while (true) {
    try {
      secretValue = await secureInput({ prompt: `${prompt}: ` });
    } catch {
      clearTimeout(timeout);
      console.error('Cancelled.');
      process.exit(1);
      return '';
    }

    if (!secretValue) {
      clearTimeout(timeout);
      console.error('✗ Empty value. Aborting.');
      process.exit(1);
      return '';
    }

    const DIM = '\x1b[2m', RESET = '\x1b[0m';
    process.stderr.write(`${DIM}  [Enter] proceed  [v] view  [Esc] re-enter${RESET}\n`);
    const key1 = (await readKey())[0];

    if (key1 === 0x76 || key1 === 0x56) {
      process.stderr.write('\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      process.stderr.write(`√ ${prompt}:  ${secretValue}\n`);
      process.stderr.write(`${DIM}  [Enter] confirm  [Esc] re-enter${RESET}\n`);

      const key2 = (await readKey())[0];

      if (key2 === 0x1b) {
        process.stderr.write('\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        continue;
      } else {
        process.stderr.write('\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        process.stderr.write(`√ ${prompt}:  ${'*'.repeat(secretValue.length)}\n`);
        break;
      }
    } else if (key1 === 0x1b) {
      process.stderr.write('\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      continue;
    } else {
      process.stderr.write('\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      break;
    }
  }

  clearTimeout(timeout);
  return secretValue!;
}
