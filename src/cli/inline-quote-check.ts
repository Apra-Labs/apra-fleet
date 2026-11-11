import { execFileSync } from 'node:child_process';
import { windowsSystemTool } from '../os/windows-executable.js';

/**
 * Windows PowerShell 5.1 (and a .cmd shim run from PowerShell 7) hands a program
 * an argument holding double quotes without escaping them, so the program's
 * argv differs from what was typed: `$x = "abc"` arrives as `$x = abc`, and
 * `Write-Output "a b"` is split in two. The argv alone cannot show the first
 * case, so on Windows the CLI reads its own raw command line and checks the
 * inline script's argument there.
 */

interface RawToken {
  value: string;
  /** The quotes in the raw text open the argument and close it, and nothing else. */
  standard: boolean;
}

/**
 * Split a Windows command line as the C runtime builds argv (2008+ rules), and
 * mark each argument whose raw quoting is not what a quoting caller (Node,
 * PowerShell 7) produces: a quote that opens or closes mid-argument, or a
 * doubled quote inside quotes. The first argument (the program) has no escapes.
 */
export function splitWindowsCommandLine(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  const n = raw.length;
  const isSpace = (c: string) => c === ' ' || c === '\t';
  // Program name: up to the closing quote, or up to whitespace.
  if (raw[0] === '"') {
    const end = raw.indexOf('"', 1);
    tokens.push({ value: raw.slice(1, end === -1 ? n : end), standard: true });
    i = end === -1 ? n : end + 1;
  } else {
    while (i < n && !isSpace(raw[i])) i++;
    tokens.push({ value: raw.slice(0, i), standard: true });
  }
  for (;;) {
    while (i < n && isSpace(raw[i])) i++;
    if (i >= n) return tokens;
    const start = i;
    let value = '';
    let inQuotes = false;
    let standard = true;
    for (; i < n; i++) {
      const c = raw[i];
      if (!inQuotes && isSpace(c)) break;
      if (c === '\\') {
        let k = i;
        while (k < n && raw[k] === '\\') k++;
        const count = k - i;
        if (raw[k] === '"') {
          value += '\\'.repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            value += '"';
            i = k;
            continue;
          }
          i = k - 1; // the quote is handled next as a toggle
          continue;
        }
        value += '\\'.repeat(count);
        i = k - 1;
        continue;
      }
      if (c === '"') {
        if (inQuotes && raw[i + 1] === '"') {
          value += '"';
          standard = false;
          i++;
          continue;
        }
        // A toggle is standard only as the argument's first character, or as
        // the last one before whitespace or the end of the line.
        const opensAtStart = !inQuotes && i === start;
        const closesAtEnd = inQuotes && (i + 1 >= n || isSpace(raw[i + 1]));
        if (!opensAtStart && !closesAtEnd) standard = false;
        inQuotes = !inQuotes;
        continue;
      }
      value += c;
    }
    tokens.push({ value, standard });
  }
}

/**
 * Whether the raw command line shows the inline script was changed on its way
 * in. 'unknown' when no `--inline <script>` pair in it matches the argv.
 */
export function inlineScriptChanged(raw: string, script: string): boolean | 'unknown' {
  const tokens = splitWindowsCommandLine(raw);
  for (let t = 1; t + 1 < tokens.length; t++) {
    if (tokens[t].value === '--inline' && tokens[t + 1].value === script) return !tokens[t + 1].standard;
  }
  return 'unknown';
}

/** This process's raw command line on Windows, or null when it cannot be read. */
export function readOwnCommandLine(): string | null {
  const powershell = windowsSystemTool('powershell');
  if (!powershell) return null;
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CommandLine`;
  try {
    const out = execFileSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}
