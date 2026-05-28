/**
 * Strip ANSI escape sequences and non-printable control characters from a string.
 * Used to clean PTY-captured output from agy.exe which writes via Windows Console API.
 */
export function stripAnsi(raw: string): string {
  return raw
    // CSI sequences: ESC [ ... (colors, cursor movement, etc.)
    .replace(/\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
    // OSC sequences: ESC ] ... ST or BEL
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // DCS / PM / APC / SOS sequences: ESC [P X ^ _] ... ST
    .replace(/\x1B[P X^_][^\x1B]*\x1B\\/g, '')
    // Other two-char ESC sequences: ESC <char>
    .replace(/\x1B[^\[]/g, '')
    // Remaining lone ESC
    .replace(/\x1B/g, '')
    // Non-printable control chars (keep \n and \t)
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
}
