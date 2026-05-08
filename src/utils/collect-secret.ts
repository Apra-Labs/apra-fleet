import { secureInput } from './secure-input.js';
import { OOB_TIMEOUT_MS } from './oob-timeout.js';

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
  }, OOB_TIMEOUT_MS);

  let secretValue: string;
  while (true) {
    try {
      secretValue = await secureInput({ prompt: `${prompt}: ` });
    } catch {
      clearTimeout(timeout);
      console.error('Cancelled.');
      process.exit(1);
      return ''; // unreachable
    }

    if (!secretValue) {
      clearTimeout(timeout);
      console.error('✗ Empty value. Aborting.');
      process.exit(1);
      return ''; // unreachable
    }

    const DIM = '\x1b[2m', RESET = '\x1b[0m';
    process.stderr.write(`${DIM}  [Enter] proceed  [v] view  [Esc] re-enter${RESET}\n`);
    const key1 = (await readKey())[0];

    // Cursor is at N+2 (blank line after hint's \n). Password line is N, hint is N+1.
    if (key1 === 0x76 || key1 === 0x56) {
      // v/V: reveal in place — clear blank N+2, hint N+1, password N, reprint as plaintext
      process.stderr.write('\r\x1b[K');           // clear blank N+2
      process.stderr.write('\x1b[1A\r\x1b[K');   // up to N+1, clear hint
      process.stderr.write('\x1b[1A\r\x1b[K');   // up to N, clear password line
      process.stderr.write(`√ ${prompt}:  ${secretValue}\n`);
      process.stderr.write(`${DIM}  [Enter] confirm  [Esc] re-enter${RESET}\n`);

      // Cursor now at N+2 again (blank after confirm hint's \n)
      const key2 = (await readKey())[0];

      if (key2 === 0x1b) {
        // Esc: clear blank N+2, confirm hint N+1, value line N — re-enter in place
        process.stderr.write('\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        continue;
      } else {
        // Enter: clear blank N+2, confirm hint N+1, value line N — reprint with stars
        process.stderr.write('\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        process.stderr.write('\x1b[1A\r\x1b[K');
        process.stderr.write(`√ ${prompt}:  ${'*'.repeat(secretValue.length)}\n`);
        break;
      }
    } else if (key1 === 0x1b) {
      // Esc: clear blank N+2, hint N+1, password N — re-enter in place
      process.stderr.write('\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      continue;
    } else {
      // Enter or anything else: clear blank N+2, hint N+1 — password line stays
      process.stderr.write('\r\x1b[K');
      process.stderr.write('\x1b[1A\r\x1b[K');
      break;
    }
  }

  clearTimeout(timeout);
  return secretValue!;
}
