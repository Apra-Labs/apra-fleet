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
 * Validate a work-folder-relative path before it is interpolated into a
 * member-bound command string. Same strict charset member-call.mjs uses for
 * its args path (^[A-Za-z0-9._/-]+$), plus: no '..' segment (no escaping the
 * work folder), no leading '/' (relative only) and no leading '-' (never
 * mistakable for an option). Anything else THROWS -- it is never quoted or
 * escaped into the string. Shared by every dialect's git-exclude/remove-file
 * primitive.
 * @param {string} relPath
 * @param {string} what caller-facing name for the error message
 * @returns {string} the validated path
 */
export function assertSafeRelativePath(relPath, what = 'path') {
  const p = String(relPath ?? '');
  if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.startsWith('/') || p.startsWith('-') || p.split('/').includes('..')) {
    throw new Error(`Refusing to build a member command for unsafe ${what} '${relPath}' (allowed: work-folder-relative, letters, digits, '.', '_', '-', '/'; no '..' segment, no leading '/' or '-').`);
  }
  return p;
}

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
   * UNQUOTED; this method adds its own quoting): POSIX double-quotes the path
   * token so a member whose HOME contains whitespace (or other word-splitting
   * characters) still resolves correctly -- `$HOME` still expands inside
   * double quotes, it just no longer gets split on the result (apra-fleet-
   * j918.12; the bare, unquoted form was a real production defect, pinned by
   * apra-fleet-j918.6.3's round-trip harness before this fix). The PowerShell
   * implementation adds both the call operator and double quotes, without
   * which PowerShell merely echoes the path back as a string and the failure
   * looks like success.
   * @param {string} path unquoted; this method adds double quotes
   * @param {string} [args]
   * @returns {string}
   */
  invoke(path, args = '') {
    const suffix = String(args || '').trim();
    const quoted = `"${path}"`;
    return suffix ? `${quoted} ${suffix}` : quoted;
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
   * NOTE: the POSIX label is intentionally NOT validated, unlike the
   * PowerShell implementation (which is newer and does validate). The path
   * itself is now double-quoted by `invoke()` (apra-fleet-j918.12) so a
   * member whose HOME contains whitespace still resolves; that quoting
   * change does not extend to validating the label.
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

  /**
   * Idempotently add `entry` (e.g. '.apra-call/') as a line of the git
   * exclude file of the repo containing the member's work folder
   * (execute_command runs in the work folder). The exclude file is resolved
   * by git itself (`git rev-parse --git-path info/exclude`), never assumed to
   * be <workFolder>/.git/info/exclude: the work folder may be a repo
   * subdirectory or a linked worktree whose .git is a file. The info/ dir is
   * created when missing, a missing trailing newline is repaired before the
   * append, and the line is appended only when not already present. Outside
   * a git repo (or with no git on PATH) it is a silent no-op that exits 0.
   *
   * The only `$` expansions are of a shell-LOCAL variable this same string
   * assigns (`excl`) -- nothing reads the member's environment ($HOME,
   * $VAR/path, ~/, backticks).
   * Caller: member-call.mjs runRemote (args-file cleanup).
   * @param {string} entry work-folder-relative path/pattern, validated
   * @returns {string}
   */
  ensureGitExcluded(entry) {
    const e = assertSafeRelativePath(entry, 'git-exclude entry');
    const script = `if excl=$(git rev-parse --git-path info/exclude 2>/dev/null) && [ -n "$excl" ]; then `
      + `mkdir -p "$(dirname "$excl")" && `
      + `{ grep -qxF -- '${e}' "$excl" 2>/dev/null || { `
      + `if [ -s "$excl" ] && [ -n "$(tail -c 1 "$excl")" ]; then printf '\\n' >> "$excl"; fi; `
      + `printf '%s\\n' '${e}' >> "$excl"; }; }; fi`;
    return this.wrapForMember(script);
  }

  /**
   * Delete a work-folder-relative file, never erroring when it is absent.
   * Caller: member-call.mjs runRemote (engine-side args-file delete).
   * @param {string} relPath validated
   * @returns {string}
   */
  removeFile(relPath) {
    const p = assertSafeRelativePath(relPath, 'file path');
    return this.wrapForMember(`rm -f -- '${p}'`);
  }

  /**
   * Create a work-folder-relative file (and its parent directory) when it is
   * absent; an existing file is never truncated or modified. Idempotent.
   * Caller: beads-identity-check.mjs member beads set-up (an empty
   * .beads/config.yaml so `bd config set` has a workspace to write to).
   * @param {string} relPath validated
   * @returns {string}
   */
  ensureFile(relPath) {
    const p = assertSafeRelativePath(relPath, 'file path');
    const slash = p.lastIndexOf('/');
    const dir = slash > 0 ? p.slice(0, slash) : '';
    const create = `{ [ -e '${p}' ] || : > '${p}'; }`;
    return this.wrapForMember(dir ? `mkdir -p -- '${dir}' && ${create}` : create);
  }

  /**
   * A POSIX member has no PowerShell -- there is nothing this method could
   * correctly return (returning the script unchanged would hand a bash
   * interpreter raw PowerShell text and fail confusingly; inventing a bash
   * translation would violate the design decision pinned on this primitive,
   * which is to keep the live-verified PowerShell body and only change how
   * it is INVOKED). So the base implementation throws a clear, loud error
   * naming the caller, rather than silently returning something that runs
   * the wrong interpreter (apra-fleet-7dir.21). SeWindowsCommands and
   * SeWindowsGitbashCommands both override this with a real implementation.
   * @param {string} _script
   * @param {string} [callerName] name of the calling function/site, for the error message
   * @returns {never}
   */
  wrapPowerShellScript(_script, callerName = 'wrapPowerShellScript caller') {
    throw new Error(`${callerName}: cannot wrap a PowerShell script for a POSIX member -- this member has no PowerShell interpreter to invoke it with.`);
  }
}

export default SePosixCommands;
