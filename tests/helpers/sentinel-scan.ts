/**
 * Sentinel scanner shared by the "this value never reaches a member command
 * string" tests (claude-config-sentinel, member-access-secret): finds a
 * sentinel raw, inside any base64 run (UTF-8 or UTF-16LE), or inside a
 * PowerShell -EncodedCommand payload.
 */

/** Every way the sentinel could be hidden in a command string. */
export function findSentinel(command: string, sentinel: string): string | null {
  const raw = command;
  if (raw.includes(sentinel)) return 'raw';
  const decodeCandidates = (b64: string): Array<[string, string]> => {
    let buf: Buffer;
    try { buf = Buffer.from(b64, 'base64'); } catch { return []; }
    return [['base64-utf8', buf.toString('utf8')], ['base64-utf16le', buf.toString('utf16le')]];
  };
  // Every base64-looking run, decoded both ways (a UTF-8-only decode would miss UTF-16LE).
  for (const run of command.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    for (const [how, text] of decodeCandidates(run)) if (text.includes(sentinel)) return how;
  }
  // Every -EncodedCommand payload, decoded as UTF-16LE (and, belt and braces, UTF-8).
  for (const m of command.matchAll(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/gi)) {
    for (const [how, text] of decodeCandidates(m[1])) if (text.includes(sentinel)) return `encoded-command(${how})`;
  }
  return null;
}
