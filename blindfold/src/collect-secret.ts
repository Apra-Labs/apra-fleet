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
  let timeoutReject: ((err: Error) => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
    setTimeout(() => {
      process.stderr.write('\n  ⏱ Timed out. Closing.\n');
      reject(new Error('Secret collection timed out'));
    }, getOobTimeoutMs());
  });

  const inputPromise = (async (): Promise<string> => {
    let secretValue: string;
    while (true) {
      try {
        secretValue = await secureInput({ prompt: `${prompt}: ` });
      } catch {
        throw new Error('Cancelled.');
      }

      if (!secretValue) {
        throw new Error('Empty value. Aborting.');
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

    return secretValue!;
  })();

  try {
    return await Promise.race([inputPromise, timeoutPromise]);
  } finally {
    timeoutReject = null;
  }
}
