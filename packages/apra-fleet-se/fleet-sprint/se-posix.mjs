// se-posix.mjs -- POSIX (linux/darwin) member-bound command primitives for
// fleet-sprint and the supervisor.
//
// This is fleet-sprint's OWN shell layer, deliberately NOT shared with
// apra-fleet core's src/os/*.ts: core ships as a compiled binary while these
// files ship as open, user-copyable source, and fleet-sprint is meant to stay
// apra-fleet-agnostic. The `se-` filename prefix keeps them from being
// confused with the core-side modules. Nothing here imports apra-fleet core,
// and nothing here needs a build step -- plain ESM that Node runs as-is.
//
// SCOPE OF THE PRIMITIVE SET: every method below exists because a real
// member-bound call site in this package builds that string today. See
// se-os-commands.mjs's header for the call-site inventory. Primitives are
// added when a call site needs one, never speculatively.
//
// HOUSE RULE THIS LAYER ENFORCES: a member-bound command string must not rely
// on the ORCHESTRATOR's shell or filesystem -- paths are resolved in
// JavaScript, and the only shell-level expansion that survives is the member's
// own home-directory token ($HOME here, $env:USERPROFILE on the PowerShell
// side). That single exception is deliberate and load-bearing: the credential
// helper file was WRITTEN by apra-fleet core using exactly that token, so the
// read must resolve the home directory the same way the write did rather than
// through an independently probed path.

/**
 * POSIX command primitives. Also the base class the Git-for-Windows bash
 * implementation extends -- a gitbash member receives bash strings, so the
 * whole surface below is correct for it apart from genuinely Windows-native
 * details.
 */
export class SePosixCommands {
  /** Stable identifier for logging/tests. */
  get shell() {
    return 'posix';
  }

  /**
   * Suffix of the deployed git-credential-helper file. Empty on POSIX: core's
   * linux implementation writes an extensionless executable script. Overridden
   * where the helper is a Windows .bat.
   */
  get credentialHelperSuffix() {
    return '';
  }

  /**
   * Envelope for a command dispatched to the member. POSIX needs none -- the
   * string is already in the member's own dialect -- so this is deliberately
   * the identity function, which is what keeps every historical POSIX command
   * string byte-identical.
   * @param {string} script
   * @returns {string}
   */
  wrapForMember(script) {
    return String(script);
  }

  /**
   * A path under the MEMBER's home directory. `$HOME` (not `~`) matches what
   * core's linux gitCredentialHelperWrite() wrote.
   * @param {string} relative
   * @returns {string}
   */
  homePath(relative) {
    const rel = String(relative).replace(/^[\\/]+/, '');
    return `$HOME/${rel}`;
  }

  /**
   * Invoke an executable at `path` with `args`.
   *
   * QUOTING CONTRACT (differs per implementation on purpose -- pass `path`
   * UNQUOTED): POSIX emits the path token verbatim, adding no quoting, because
   * the historical credential-read command is a bare unquoted `$HOME/...`
   * string that must stay byte-identical. The PowerShell implementation adds
   * both the call operator and double quotes, without which PowerShell merely
   * echoes the path back as a string and the failure looks like success.
   * @param {string} path unquoted; POSIX callers needing quotes add them
   * @param {string} [args]
   * @returns {string}
   */
  invoke(path, args = '') {
    const suffix = String(args || '').trim();
    return suffix ? `${path} ${suffix}` : String(path);
  }

  /**
   * Member-side path of the git-credential-helper file apra-fleet core's
   * provision_vcs_auth deployed. fleet-sprint only ever READS this file; the
   * write side belongs to core.
   * @param {string} label
   * @returns {string}
   */
  credentialHelperPath(label) {
    return this.homePath(`.fleet-git-credential-${label}${this.credentialHelperSuffix}`);
  }

  /**
   * The command that RUNS the credential helper (so its "password=<token>"
   * line reaches stdout) plus a human-readable descriptor for error messages
   * -- on the PowerShell side the command itself is an opaque base64 blob, so
   * the descriptor has to carry the readable path.
   *
   * NOTE: the POSIX label is intentionally NOT validated. The historical
   * string is a bare, unquoted `$HOME/...` path and must stay byte-identical
   * for every non-Windows member; adding validation here would change
   * behaviour for callers that have worked for a long time. The PowerShell
   * implementation, which is newer, does validate.
   * @param {string} label
   * @returns {{ command: string, descriptor: string }}
   */
  readCredentialHelper(label) {
    const descriptor = this.credentialHelperPath(label);
    return { command: this.wrapForMember(this.invoke(descriptor)), descriptor };
  }

  /**
   * Escape a SQL string so it survives as ONE double-quoted argument in the
   * member's shell. Backticks and `$` are the dangerous characters: bash
   * treats a backtick inside double quotes as command substitution, so both
   * backslash and backtick are backslash-escaped, along with `$` and `"`.
   * Byte-identical to dolt-settle.mjs's escapeSqlForShell('linux', sql).
   * @param {string} sql
   * @returns {string}
   */
  escapeSqlArg(sql) {
    const bq = String.fromCharCode(96);
    return String(sql)
      .replace(/\\/g, '\\\\')
      .split(bq).join('\\' + bq)
      .replace(/\$/g, '\\$')
      .replace(/"/g, '\\"');
  }
}

export default SePosixCommands;
