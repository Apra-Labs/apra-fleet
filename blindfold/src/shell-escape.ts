export function escapeShellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function escapeDoubleQuoted(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

export function escapeWindowsArg(s: string): string {
  return s
    .replace(/"/g, '""')
    .replace(/([&|^<>])/g, '^$1');
}

export function escapePowerShellArg(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function escapeBatchMetachars(s: string): string {
  return s.replace(/([&|><^%])/g, '^$1');
}

export function escapeGrepPattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeSessionId(s: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`Invalid session ID: contains disallowed characters`);
  }
  return s;
}
