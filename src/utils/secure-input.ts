import password from '@inquirer/password';
import readline from 'node:readline';

export interface SecureInputOptions {
  prompt: string;
  allowEmpty?: boolean;
}

export async function secureInput(opts: SecureInputOptions): Promise<string> {
  const { prompt, allowEmpty = false } = opts;

  // Non-TTY fallback: read one line from stdin
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk: string) => {
        data += chunk;
        const nl = data.indexOf('\n');
        if (nl !== -1) {
          resolve(data.slice(0, nl));
        }
      });
      process.stdin.on('end', () => resolve(data.trim()));
    });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let value: string;
    try {
      value = await password({
        message: prompt,
        mask: '*',
        validate: (v: string) => {
          if (v.length === 0 && !allowEmpty) {
            return 'Empty password not allowed. Please try again.';
          }
          return true;
        },
      });
    } catch {
      // Ctrl+C → ExitPromptError; surface as Cancelled to match prior API.
      throw new Error('Cancelled');
    }

    if (value.length === 0 && allowEmpty) {
      const confirmed = await confirmEmpty();
      if (!confirmed) continue;
    }

    return value;
  }
}

async function confirmEmpty(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    rl.question('Are you sure? [y/N]: ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
