/**
 * Recognise the content-free command that lands a staged ~/.claude.json on
 * the member: POSIX `mv "<from>" "<to>"`, or the PowerShell
 * windowsReplaceFileCommand (`$s = "<from>"; $d = "<to>"; ...`). Returns the
 * two paths exactly as they appear inside the quotes, or null.
 */
export function parseLandingMove(cmd: string): { from: string; to: string } | null {
  const m = cmd.match(/^mv "([^"]*)" "([^"]*)"$/) ?? cmd.match(/^\$s = "([^"]*)"; \$d = "([^"]*)"; /);
  return m ? { from: m[1], to: m[2] } : null;
}

/** True for the PowerShell landing (never Move-Item -Force, see windowsReplaceFileCommand). */
export function isWindowsLandingMove(cmd: string): boolean {
  return /^\$s = "[^"]*"; \$d = "[^"]*"; /.test(cmd) && cmd.includes('[System.IO.File]::Replace(');
}
