import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The macOS branch of launchAuthTerminal hands an AppleScript to `osascript -`
// via stdin. Capture what is written so the test can decode it exactly as
// AppleScript and the Terminal login shell would.
const stdinWrites: string[] = [];

vi.mock('node:child_process', () => ({
  spawn: () => ({
    pid: 4242,
    on: () => {},
    unref: () => {},
    stdin: { write: (s: string) => { stdinWrites.push(s); }, end: () => {} },
  }),
  execSync: () => { throw new Error('not found'); },
  ChildProcess: class {},
}));

/** Decode the AppleScript string literal following `do script "`. Returns the
 *  decoded value and the raw text after the closing quote. */
function decodeDoScriptLiteral(script: string): { value: string; rest: string } {
  const start = script.indexOf('do script "');
  expect(start).toBeGreaterThanOrEqual(0);
  let i = start + 'do script "'.length;
  let value = '';
  while (i < script.length) {
    const ch = script[i];
    if (ch === '\\') { value += script[i + 1]; i += 2; continue; }
    if (ch === '"') return { value, rest: script.slice(i + 1) };
    value += ch;
    i++;
  }
  throw new Error('unterminated AppleScript string literal');
}

/** Minimal POSIX word splitter: single quotes, backslash escapes, `;` as an
 *  operator token. Enough to prove each argv element survives as one word. */
function posixWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error('unterminated single quote');
      cur += cmd.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '\\') {
      cur += cmd[i + 1];
      inWord = true;
      i++;
    } else if (ch === ' ' || ch === ';') {
      if (inWord) { words.push(cur); cur = ''; inWord = false; }
      if (ch === ';') words.push(';');
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

describe('launchAuthTerminal -- macOS Terminal command quoting', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    stdinWrites.length = 0;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.stubEnv('SSH_TTY', '');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.unstubAllEnvs();
  });

  it('keeps a hostile --prompt value as one shell word and inside the AppleScript literal', async () => {
    const { launchAuthTerminal } = await import('../src/services/auth-socket.js');
    // A register_member prompt embeds caller-supplied username/host values.
    const evilPrompt = 'Enter SSH password for u@h\\" $(touch /tmp/pwn) `id` ; rm -rf ~ ; it\'s: ';
    const result = launchAuthTerminal('member one', ['--prompt', evilPrompt], () => {});
    expect(result).toBe('launched');
    expect(stdinWrites.length).toBe(1);

    const { value, rest } = decodeDoScriptLiteral(stdinWrites[0]);
    // The literal must end exactly where the builder closed it.
    expect(rest).toMatch(/^\s*\n\s*delay 1/);

    const words = posixWords(value);
    // Only the trailing exit-code capture introduces a command separator.
    expect(words.filter((w) => w === ';').length).toBe(1);
    const promptIdx = words.indexOf('--prompt');
    expect(promptIdx).toBeGreaterThan(0);
    expect(words[promptIdx + 1]).toBe(evilPrompt);
    expect(words).toContain('member one');
    expect(words.slice(-4, -1)).toEqual(['echo', '$?', '>']);
  });
});
