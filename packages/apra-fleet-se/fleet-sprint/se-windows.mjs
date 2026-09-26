// se-windows.mjs -- PowerShell member-bound command primitives for a Windows
// member with no Git-for-Windows bash shell recorded.
//
// Deliberately NOT a subclass of SePosixCommands: what this member's shell
// receives is PowerShell text, so essentially nothing on the POSIX surface is
// reusable. (The Git-for-Windows implementation is the opposite case -- it
// receives bash text and therefore does extend the POSIX base.)
//
// Like its sibling, this file imports nothing from apra-fleet core and needs
// no build step. The PowerShell envelope below is a deliberate MIRROR of
// core's src/os/windows.ts wrapPowerShellEncoded(), not a reuse of it: this
// package cannot import core.

/**
 * PowerShell command primitives for a Windows member.
 */
export class SeWindowsCommands {
  /** Stable identifier for logging/tests. */
  get shell() {
    return 'powershell';
  }

  /**
   * The deployed git-credential helper is a .bat on a PowerShell Windows
   * member (core's windows gitCredentialHelperWrite writes
   * "$env:USERPROFILE\.fleet-git-credential-<label>.bat").
   */
  get credentialHelperSuffix() {
    return '.bat';
  }

  /**
   * Wrap a PowerShell script into the envelope this package dispatches to a
   * Windows member.
   *
   * Every part of this shape is load-bearing:
   *  - `$ErrorActionPreference = 'Stop'` + try/catch makes a NON-TERMINATING
   *    PowerShell failure surface as a non-zero exit instead of a false
   *    success;
   *  - `-EncodedCommand` (base64 UTF-16LE) removes every quoting question
   *    about which shell the transport hands the string to -- it is valid to
   *    launch from PowerShell or from cmd.exe;
   *  - the `$LASTEXITCODE` check before the trailing `exit 0` preserves a
   *    NATIVE command's exit code (e.g. the credential-helper .bat invoked
   *    below) that the trailing `exit 0` would otherwise mask -- without it a
   *    broken helper reports success with no `password=` line.
   *
   * Byte-identical to the string runner.js builds today.
   * @param {string} script
   * @returns {string}
   */
  wrapForMember(script) {
    const guarded = `$ErrorActionPreference = 'Stop'; try { ${script}; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`;
    return `powershell -EncodedCommand ${Buffer.from(guarded, 'utf16le').toString('base64')}`;
  }

  /**
   * A path under the MEMBER's home directory, expanded ON THE MEMBER.
   * `$env:USERPROFILE` rather than a JavaScript-resolved home path is
   * deliberate and is the one shell expansion this layer permits: core's
   * Windows credential write used exactly this token, so an independently
   * probed home could point somewhere the file was never written.
   * @param {string} relative
   * @returns {string}
   */
  homePath(relative) {
    const rel = String(relative).replace(/^[\\/]+/, '').replace(/\//g, '\\');
    return `$env:USERPROFILE\\${rel}`;
  }

  /**
   * Invoke an executable with PowerShell's call operator, so PowerShell
   * EXECUTES it instead of echoing the quoted path back as a string (which
   * exits 0 and looks like success).
   *
   * Pass `path` UNQUOTED: this adds the double quotes itself (the POSIX
   * implementation deliberately adds none -- see its quoting contract).
   * @param {string} path unquoted
   * @param {string} [args]
   * @returns {string}
   */
  invoke(path, args = '') {
    const suffix = String(args || '').trim();
    return suffix ? `& "${path}" ${suffix}` : `& "${path}"`;
  }

  /**
   * @param {string} label
   * @returns {string}
   */
  credentialHelperPath(label) {
    return this.homePath(`.fleet-git-credential-${label}${this.credentialHelperSuffix}`);
  }

  /**
   * Unlike the POSIX branch (kept unvalidated for byte-identical
   * back-compat), the label here is interpolated into a PowerShell
   * double-quoted string and a filename, so shell metacharacters are refused
   * outright.
   * @param {string} label
   * @returns {{ command: string, descriptor: string }}
   */
  readCredentialHelper(label) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(label))) {
      throw new Error(`Refusing to build a Windows credential-read command for unsafe VCS credential label '${label}' (allowed: letters, digits, '.', '_', '-').`);
    }
    const descriptor = this.credentialHelperPath(label);
    return { command: this.wrapForMember(this.invoke(descriptor)), descriptor };
  }

  /**
   * Escape a SQL string so it survives as ONE double-quoted argument in
   * PowerShell. A backtick is PowerShell's escape character: a literal
   * backtick is a doubled backtick, a literal quote is `` `" ``, and a
   * literal `$` is `` `$ `` (otherwise PowerShell expands it as a variable).
   * Byte-identical to dolt-settle.mjs's escapeSqlForShell('win32', sql).
   * @param {string} sql
   * @returns {string}
   */
  escapeSqlArg(sql) {
    const bq = String.fromCharCode(96);
    return String(sql)
      .split(bq).join(bq + bq)
      .replace(/\$/g, `${bq}$`)
      .replace(/"/g, `${bq}"`);
  }

  /**
   * This member's OWN shell already IS PowerShell, so a script destined for
   * it needs no envelope at all -- returning it unchanged is what keeps
   * every non-gitbash Windows member's dispatched script byte-identical to
   * today (apra-fleet-7dir.21). Contrast with SeWindowsGitbashCommands'
   * override, which DOES need to wrap the same script for a bash shell to
   * invoke it.
   * @param {string} script
   * @returns {string}
   */
  wrapPowerShellScript(script) {
    return String(script);
  }
}

export default SeWindowsCommands;
