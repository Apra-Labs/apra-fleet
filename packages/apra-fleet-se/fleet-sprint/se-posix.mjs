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
 * escaped into the string. Shared by every dialect's git-exclude/remove-file/
 * ensure-file/ensure-line primitive.
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
 * Validate a git-exclude entry before it is interpolated into a member-bound
 * command string: the same rules as assertSafeRelativePath plus the glob '*'
 * (e.g. 'docs/sprint-analysis-*.md'). '*' is inert in every dialect's use of
 * the entry -- always single-quoted, matched as a fixed string (grep -qxF /
 * PowerShell -notcontains) and appended literally -- so it is allowed here
 * only, never in the file-path primitives.
 * @param {string} entry
 * @param {string} what caller-facing name for the error message
 * @returns {string} the validated entry
 */
export function assertSafeExcludePattern(entry, what = 'git-exclude entry') {
  const e = String(entry ?? '');
  if (!/^[A-Za-z0-9._/*-]+$/.test(e) || e.startsWith('/') || e.startsWith('-') || e.split('/').includes('..')) {
    throw new Error(`Refusing to build a member command for unsafe ${what} '${entry}' (allowed: work-folder-relative, letters, digits, '.', '_', '-', '/', '*'; no '..' segment, no leading '/' or '-').`);
  }
  return e;
}

/** Markers printed by every dialect's fileExistsProbe(). */
export const FILE_PROBE_PRESENT = 'present';
export const FILE_PROBE_ABSENT = 'absent';

/**
 * A single file line safe to embed single-quoted in POSIX and PowerShell:
 * no single quote, backslash, $, backtick or newline.
 * @param {string} line
 * @returns {string}
 */
export function assertSafeFileLine(line) {
  const l = String(line ?? '');
  if (!/^[A-Za-z0-9 ._~:/@+="-]+$/.test(l)) {
    throw new Error(`Refusing to build a member command for unsafe file line '${line}' (allowed: letters, digits, space and . _ ~ : / @ + = " -).`);
  }
  return l;
}

/**
 * True when a member home directory can be embedded in a labelled git probe:
 * no '$', backtick, double quote or control character (single quotes are
 * escaped by the builders).
 * @param {string} home
 * @returns {boolean}
 */
export function isEmbeddableHome(home) {
  const bq = String.fromCharCode(96);
  // eslint-disable-next-line no-control-regex
  return home.length > 0 && !/[\x00-\x1f\x7f"$]/.test(home) && !home.includes(bq);
}

/** POSIX single-quote one word: ' becomes '\''. */
export function posixSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
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
   * A git command carrying a `<ref>:<path>` argument. Identity here: only the
   * MSYS runtime (gitbash) rewrites such arguments, so POSIX stays byte-identical.
   * @param {string} gitCommand
   * @returns {string}
   */
  gitRefPathCommand(gitCommand) {
    return String(gitCommand);
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
   * @param {string} [memberId] - set only for a member-scoped helper
   * @returns {string}
   */
  credentialHelperPath(label, memberId) {
    // A member-scoped helper (member_detail vcsCredentials[].memberScoped) is
    // the member's own file `.fleet-git-credential-<label>.<member id>`; without
    // a member id this is the shared per-OS-user file older releases wrote.
    if (memberId !== undefined && memberId !== null && memberId !== '') {
      if (!/^[A-Za-z0-9_-]+$/.test(String(memberId))) {
        throw new Error(`Refusing to build a credential helper path for unsafe member id '${memberId}' (allowed: letters, digits, '_', '-').`);
      }
      return this.homePath(`.fleet-git-credential-${label}.${memberId}${this.credentialHelperSuffix}`);
    }
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
  readCredentialHelper(label, memberId) {
    const descriptor = this.credentialHelperPath(label, memberId);
    return { command: this.wrapForMember(this.invoke(descriptor)), descriptor };
  }

  /**
   * Run the same credential helper but let ONLY its `username=` line leave
   * the member: the filter runs member-side, so the `password=` (token) line
   * never reaches the orchestrator's output. Used by the VCS preflight to
   * check which git username the fleet helper actually carries. The label is
   * validated (unlike readCredentialHelper's back-compat POSIX form): this is
   * a new surface with no byte-identical history to keep. grep exits 1 when
   * there is no username= line; the caller treats that as "no username".
   * @param {string} label
   * @returns {{ command: string, descriptor: string }}
   */
  readCredentialHelperUsername(label, memberId) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(label))) {
      throw new Error(`Refusing to build a credential username-read command for unsafe VCS credential label '${label}' (allowed: letters, digits, '.', '_', '-').`);
    }
    const descriptor = this.credentialHelperPath(label, memberId);
    return { command: this.wrapForMember(`${this.invoke(descriptor)} | grep '^username='`), descriptor };
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
   * Callers: member-call.mjs runRemote (args-file cleanup);
   * beads-identity-check.mjs member beads set-up (new untracked beads paths
   * are excluded so the target work tree stays clean).
   * @param {string} entry work-folder-relative path/pattern, validated
   * @returns {string}
   */
  ensureGitExcluded(entry) {
    const e = assertSafeExcludePattern(entry, 'git-exclude entry');
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
   * Report whether a work-folder-relative file exists: prints exactly
   * FILE_PROBE_PRESENT or FILE_PROBE_ABSENT and exits 0 either way, so a
   * non-zero exit always means the probe itself failed. Read-only.
   * Caller: member-provisioning.mjs permission-config preflight.
   * @param {string} relPath validated
   * @returns {string}
   */
  fileExistsProbe(relPath) {
    const p = assertSafeRelativePath(relPath, 'file path');
    return this.wrapForMember(`if [ -e '${p}' ]; then echo ${FILE_PROBE_PRESENT}; else echo ${FILE_PROBE_ABSENT}; fi`);
  }

  /**
   * Non-interactive read-only probe of the credential ALREADY in place for
   * the member's `origin` remote: `git ls-remote origin HEAD` with
   * GIT_TERMINAL_PROMPT=0 (git never asks on a terminal) and
   * GCM_INTERACTIVE=never (Git Credential Manager never opens a dialog). No
   * credential.helper override -- the point is to test whatever helper the
   * member already uses. Exit 0 = the remote answered with that credential.
   * Env is set as a per-command prefix, so nothing leaks into later commands.
   * Caller: vcs-auth.mjs createVcsAuthPreflightCallback (probe-first branch).
   * @returns {string}
   */
  gitLsRemoteProbe() {
    return this.wrapForMember('GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git ls-remote origin HEAD');
  }

  /**
   * Print the member's home directory in the form git on that member uses
   * for a credential helper path (no trailing newline on POSIX). Run once,
   * before gitLsRemoteLabelledProbe, so the probe itself carries an absolute
   * path resolved in JavaScript and no shell expansion at all. Overridden
   * for gitbash (git.exe needs the Windows form) and PowerShell.
   * @returns {string}
   */
  memberHomeProbe() {
    return this.wrapForMember(`printf '%s' "$HOME"`);
  }

  /**
   * Validate and normalise the home directory memberHomeProbe printed, for
   * a git helper path. Throws on anything that is not an absolute path or
   * that carries a character this layer refuses to embed ($, backtick,
   * double quote, control characters).
   * @param {string} home
   * @returns {string} absolute home, no trailing slash
   */
  gitHelperHome(home) {
    const h = String(home ?? '').replace(/[\r\n]+$/, '');
    if (!h.startsWith('/') || !isEmbeddableHome(h)) {
      throw new Error(`Refusing to build a labelled git probe for unusable member home '${h}' (expected an absolute POSIX path with no '$', backtick, double quote or control character).`);
    }
    return h.length > 1 ? h.replace(/\/+$/, '') : h;
  }

  /**
   * File name of the fleet-labelled git credential helper for `label`:
   * member-scoped (`.fleet-git-credential-<label>.<memberId>`) when a member
   * id is given, else the shared legacy file. Same resolution as
   * credentialHelperPath, without the home prefix.
   * @param {string} label validated
   * @param {string} [memberId] validated
   * @returns {string}
   */
  credentialHelperFileName(label, memberId) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(label))) {
      throw new Error(`Refusing to build a credential helper file name for unsafe VCS credential label '${label}' (allowed: letters, digits, '.', '_', '-').`);
    }
    if (memberId !== undefined && memberId !== null && memberId !== '') {
      if (!/^[A-Za-z0-9_-]+$/.test(String(memberId))) {
        throw new Error(`Refusing to build a credential helper path for unsafe member id '${memberId}' (allowed: letters, digits, '_', '-').`);
      }
      return `.fleet-git-credential-${label}.${memberId}${this.credentialHelperSuffix}`;
    }
    return `.fleet-git-credential-${label}${this.credentialHelperSuffix}`;
  }

  /**
   * Non-interactive `git ls-remote origin HEAD` judged through ONLY the
   * fleet-labelled credential helper: `-c credential.helper=` resets the
   * helper list git collected from every config scope (a system credential
   * manager, a global store, the dispatch's own GIT_CONFIG_PARAMETERS), then
   * the labelled helper file is the one helper left. Prompting is off
   * (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never, empty askpass), so a dead
   * helper fails instead of waiting on a terminal or a dialog.
   *
   * `home` is the member home memberHomeProbe printed, resolved in
   * JavaScript: the command relies on no shell expansion at all. The helper
   * value is `!'<path>'` (git runs a `!` value through its shell, so the
   * quoted path may hold spaces), and the whole -c argument is single-quoted
   * again for the member shell.
   * Caller: vcs-auth.mjs createVcsAuthPreflightCallback (git channel).
   * @param {string} label
   * @param {string} [memberId] - set only for a member-scoped helper
   * @param {string} home
   * @returns {{ command: string, descriptor: string }}
   */
  gitLsRemoteLabelledProbe(label, memberId, home) {
    const descriptor = `${this.gitHelperHome(home)}/${this.credentialHelperFileName(label, memberId)}`;
    const helperArg = posixSingleQuote(`credential.helper=!${posixSingleQuote(descriptor)}`);
    return {
      command: this.wrapForMember(`GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS= SSH_ASKPASS= git -c credential.helper= -c core.askPass= -c ${helperArg} ls-remote origin HEAD`),
      descriptor,
    };
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
   * Idempotently make `line` a whole line of a work-folder-relative file,
   * creating the file (and its parent directory) when absent; nothing else in
   * the file is touched. Same append shape as ensureGitExcluded.
   * Caller: beads-identity-check.mjs member beads set-up (sync.remote in the
   * untracked .beads/config.local.yaml layer).
   * @param {string} relPath validated
   * @param {string} line validated: letters, digits, space and . _ ~ : / @ + = " -
   * @returns {string}
   */
  ensureLine(relPath, line) {
    const p = assertSafeRelativePath(relPath, 'file path');
    const l = assertSafeFileLine(line);
    const slash = p.lastIndexOf('/');
    const dir = slash > 0 ? p.slice(0, slash) : '';
    const script = `${dir ? `mkdir -p -- '${dir}' && ` : ''}{ [ -e '${p}' ] || : > '${p}'; } && `
      + `{ grep -qxF -- '${l}' '${p}' || { `
      + `if [ -s '${p}' ] && [ -n "$(tail -c 1 '${p}')" ]; then printf '\\n' >> '${p}'; fi; `
      + `printf '%s\\n' '${l}' >> '${p}'; }; }`;
    return this.wrapForMember(script);
  }

  /**
   * List the entry names of a work-folder-relative directory, one per line,
   * hidden entries included ('.' and '..' excluded). Read-only.
   * Caller: beads-flatten-recovery.mjs (finds a recovery backup of .beads).
   * @param {string} relPath validated
   * @returns {string}
   */
  listDirectory(relPath) {
    const p = assertSafeRelativePath(relPath, 'directory path');
    return this.wrapForMember(`ls -1A -- '${p}'`);
  }

  /**
   * Rename a work-folder-relative file or directory. Fails (non-zero exit,
   * nothing changed) when the source is missing or the destination already
   * exists, so it can never merge into or replace an existing path.
   * Caller: beads-flatten-recovery.mjs (moves .beads aside and back).
   * @param {string} fromRel validated
   * @param {string} toRel validated
   * @returns {string}
   */
  renamePath(fromRel, toRel) {
    const from = assertSafeRelativePath(fromRel, 'rename source');
    const to = assertSafeRelativePath(toRel, 'rename destination');
    return this.wrapForMember(`[ -e '${from}' ] && [ ! -e '${to}' ] && mv -- '${from}' '${to}'`);
  }

  /**
   * Copy a work-folder-relative file when it exists; exit 0 and no change
   * when it does not.
   * Caller: beads-flatten-recovery.mjs (carries the beads config files into
   * the re-bootstrapped .beads).
   * @param {string} fromRel validated
   * @param {string} toRel validated
   * @returns {string}
   */
  copyFileIfPresent(fromRel, toRel) {
    const from = assertSafeRelativePath(fromRel, 'copy source');
    const to = assertSafeRelativePath(toRel, 'copy destination');
    return this.wrapForMember(`if [ -e '${from}' ]; then cp -p -- '${from}' '${to}'; fi`);
  }

  /**
   * Print a work-folder-relative file's content. Read-only; fails when the
   * file is missing.
   * Caller: beads-flatten-recovery.mjs (reads a `bd export` file).
   * @param {string} relPath validated
   * @returns {string}
   */
  readFile(relPath) {
    const p = assertSafeRelativePath(relPath, 'file path');
    return this.wrapForMember(`cat -- '${p}'`);
  }

  /**
   * Delete a work-folder-relative directory tree, never erroring when it is
   * absent.
   * Caller: beads-flatten-recovery.mjs (drops a discarded fresh clone, only
   * ever by its own generated name).
   * @param {string} relPath validated
   * @returns {string}
   */
  removeDirectory(relPath) {
    const p = assertSafeRelativePath(relPath, 'directory path');
    if (p === '.' || p.split('/').every((s) => s === '.' || s === '')) {
      throw new Error(`Refusing to build a member command that removes the work folder itself ('${relPath}').`);
    }
    return this.wrapForMember(`rm -rf -- '${p}'`);
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
