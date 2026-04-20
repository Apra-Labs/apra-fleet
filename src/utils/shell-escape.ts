/**
 * Centralized shell escaping functions to prevent command injection (CWE-78).
 * Used by platform.ts, execute-prompt.ts, and provision-auth.ts.
 */

/**
 * Escape a string for safe use inside single-quoted Unix shell arguments.
 * Handles embedded single quotes by ending the quote, adding an escaped quote, and reopening.
 * e.g. "it's" → 'it'\''s'
 */
export function escapeShellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape a string for safe use inside double-quoted Unix shell arguments.
 * Escapes: $ ` " \ ! (characters with special meaning inside double quotes).
 */
export function escapeDoubleQuoted(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

/**
 * Escape a string for safe use inside double-quoted Windows cmd.exe arguments.
 * Escapes: " & | ^ < > (cmd.exe metacharacters).
 */
export function escapeWindowsArg(s: string): string {
  return s
    .replace(/"/g, '""')
    .replace(/([&|^<>])/g, '^$1');
}

/**
 * Escape a string for safe use as a PowerShell single-quoted string literal.
 * Single-quoted strings in PowerShell are fully literal — no variable expansion.
 * Internal single quotes are escaped by doubling them: ' → ''
 * Returns the value wrapped in single quotes.
 */
export function escapePowerShellArg(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Escape batch (cmd.exe) metacharacters for safe use in .bat file content.
 * Escapes: & | > < ^ % by prefixing each with ^.
 */
export function escapeBatchMetachars(s: string): string {
  return s.replace(/([&|><^%])/g, '^$1');
}

/**
 * Escape regex metacharacters for use in `grep -E` patterns.
 */
export function escapeGrepPattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate and sanitize a session ID to prevent injection.
 * Session IDs must be alphanumeric with dashes and underscores only.
 * Throws if the ID contains invalid characters.
 */
export function sanitizeSessionId(s: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`Invalid session ID: contains disallowed characters`);
  }
  return s;
}
