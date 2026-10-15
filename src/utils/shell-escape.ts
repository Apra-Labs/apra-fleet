/**
 * Centralized shell escaping functions to prevent command injection (CWE-78).
 * Used by platform.ts, execute-prompt.ts, and provision-auth.ts.
 */

/**
 * The interior transform escapeShellArg wraps in single quotes, factored out
 * so a value that must sit INSIDE an already-open single-quoted string (e.g.
 * vcs-credential-exec.ts's inline token placeholder) can reuse the exact same
 * escaping without also picking up the wrapping quotes. escapeShellArg is
 * defined in terms of this function rather than repeating the replace, so the
 * two can never drift apart (apra-fleet-3swo.7.16).
 */
export function escapeShellArgInner(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Escape a string for safe use inside single-quoted Unix shell arguments.
 * Handles embedded single quotes by ending the quote, adding an escaped quote, and reopening.
 * e.g. "it's" -> 'it'\''s'
 */
export function escapeShellArg(s: string): string {
  return "'" + escapeShellArgInner(s) + "'";
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
 * Escape a literal value for embedding inside "..." in a member-bound command.
 * POSIX: backslash, ", $ and backtick are live inside double quotes. `!` is
 * deliberately NOT escaped (unlike escapeDoubleQuoted): history expansion is
 * off in the non-interactive shells commands run in, so `\!` would stay a
 * literal backslash + `!` and corrupt the path. PowerShell: backtick, ", $ (and
 * the curly double quotes U+201C..U+201E, which PowerShell treats as quotes)
 * are live and are escaped with a backtick; backslash is literal there.
 * A literal newline needs no escaping: it is inert inside "..." in both shells.
 */
export function escapeForDoubleQuotes(s: string, powershell: boolean): string {
  return powershell
    ? s.replace(/[`"$\u201C-\u201E]/g, '`$&')
    : s.replace(/[\\"$`]/g, '\\$&');
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
 * The interior transform escapePowerShellArg wraps in single quotes, factored
 * out for the same reason as escapeShellArgInner above: a value that must sit
 * INSIDE an already-open PowerShell single-quoted string reuses this directly
 * instead of re-implementing the doubling rule (apra-fleet-3swo.7.16).
 *
 * PowerShell treats U+2018..U+201B (curly/low-9/reversed single quotes) as
 * single-quote characters too, so any of them would end the literal. Each
 * quote character is doubled as itself, which PowerShell reads back as that
 * one literal character. Strings without these characters are unchanged.
 */
export function escapePowerShellArgInner(s: string): string {
  return s.replace(/['\u2018-\u201B]/g, '$&$&');
}

/**
 * Escape a string for safe use as a PowerShell single-quoted string literal.
 * Single-quoted strings in PowerShell are fully literal -- no variable expansion.
 * Internal single quotes (ASCII ' and U+2018..U+201B) are escaped by doubling them.
 * Returns the value wrapped in single quotes.
 */
export function escapePowerShellArg(s: string): string {
  return "'" + escapePowerShellArgInner(s) + "'";
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
 * Escape a literal string for use inside a sed POSIX basic regular expression
 * delimited by `/`. Backslash is escaped first so an input backslash can never
 * combine with a following character into an escape sequence. Characters that
 * are only special in ERE (+ ? | ( ) { }) are left alone: GNU sed gives `\+`
 * etc. a special meaning in BRE, so escaping them would change the match.
 */
export function escapeSedBasicRegex(s: string): string {
  return s.replace(/[\\/.*[\]^$]/g, '\\$&');
}

/**
 * Escape a string for use inside an AppleScript double-quoted string literal.
 * Backslash is the AppleScript escape character, so it is doubled first;
 * then embedded double quotes are backslash-escaped.
 */
export function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Quote one argument for a Windows command line as parsed by the MSVC CRT /
 * CommandLineToArgvW (what node.exe and most native programs use). Backslashes
 * are literal unless they precede a double quote, so runs of backslashes before
 * a quote (or the closing quote) are doubled. This is NOT cmd.exe quoting --
 * the result must never be handed to cmd.exe, which also expands % and treats
 * & | ^ < > as operators.
 */
export function quoteWindowsArgv(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
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
