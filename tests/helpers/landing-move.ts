import { createHash } from 'node:crypto';

/**
 * The PowerShell script inside a `powershell -EncodedCommand <b64>` command
 * (wrapPowerShellEncoded), with the wrapper's own guard prefix stripped, or
 * the command unchanged when it is not encoded.
 */
export function unwrapPowerShellEncoded(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (\S+)$/);
  if (!m) return cmd;
  const script = Buffer.from(m[1], 'base64').toString('utf16le');
  const prefix = "$ErrorActionPreference = 'Stop'; try { ";
  return script.startsWith(prefix) ? script.slice(prefix.length) : script;
}

/**
 * Recognise the content-free command that lands a staged ~/.claude.json on
 * the member: the POSIX landing (`mv "<from>" "<to>"`, optionally preceded by
 * a `cp "<from>" "<landing>"` next to the destination and a fingerprint
 * check), or the PowerShell windowsReplaceFileCommand
 * (`$s = "<from>"; $d = "<to>"; ...`), raw or wrapped in -EncodedCommand.
 * Returns the staged source and the destination exactly as they appear inside
 * the quotes, or null.
 */
export function parseLandingMove(cmd: string): { from: string; to: string } | null {
  const c = unwrapPowerShellEncoded(cmd);
  const ps = c.match(/^\$s = "([^"]*)"; \$d = "([^"]*)"; /);
  if (ps) return { from: ps[1], to: ps[2] };
  const mv = c.match(/(?:^|; )mv "([^"]*)" "([^"]*)"/);
  if (!mv) return null;
  const cp = c.match(/^cp "([^"]*)" "([^"]*)" \|\|/);
  if (cp && cp[2] !== mv[1]) return null;
  return { from: cp ? cp[1] : mv[1], to: mv[2] };
}

/** The fingerprint a landing command requires the destination to still have, or undefined. */
export function landingExpectedFingerprint(cmd: string): string | undefined {
  const c = unwrapPowerShellEncoded(cmd);
  const m = c.match(/; fi\)" != '([^']*)' \]/) ?? c.match(/if \(\$fp -ne '([^']*)'\)/);
  return m ? m[1] : undefined;
}

/** True for the PowerShell landing (never Move-Item -Force, see windowsReplaceFileCommand). */
export function isWindowsLandingMove(cmd: string): boolean {
  const c = unwrapPowerShellEncoded(cmd);
  return /^\$s = "[^"]*"; \$d = "[^"]*"; /.test(c) && c.includes('[System.IO.File]::Replace(');
}

/** The (escaped) path a fingerprint probe (probeMemberFileFingerprint) asks about, or null. */
export function parseFingerprintProbe(cmd: string): string | null {
  const c = unwrapPowerShellEncoded(cmd);
  const m = c.match(/^if \[ -e "([^"]*)" \]; then cksum < /)
    ?? c.match(/^if \(\[System\.IO\.File\]::Exists\("([^"]*)"\)\) \{ \(Get-FileHash /);
  return m ? m[1] : null;
}

/** A fake member's fingerprint of a file's content (null = missing). */
export function fakeFingerprint(content: string | null | undefined): string {
  return content === null || content === undefined ? 'FLEET_ABSENT' : createHash('sha256').update(content).digest('hex');
}
