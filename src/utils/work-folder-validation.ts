/**
 * SF-17: work_folder must be a fully-qualified path for REMOTE members.
 *
 * A remote member's work folder is used verbatim in commands executed on the
 * MEMBER's machine (execute-command.ts only tilde-resolves for local members --
 * deliberately, because `~` on the hub is not `~` on the member). A relative or
 * `~`-prefixed value therefore resolves against whatever directory the remote
 * shell happens to land in, silently producing a different folder than the
 * caller meant -- or, for `~`, a literal directory named "~" under the SSH
 * login dir.
 *
 * Rather than take ownership of resolving that at runtime (which needs the
 * member's home dir, a remote round trip, and is wrong the moment the login
 * user changes), reject it at register_member / update_member time with an
 * actionable message. An LLM-driven caller reads the error and re-issues the
 * call with an absolute path, so the bad state is never created at all.
 *
 * Local members are deliberately NOT covered: `resolveTilde` already expands
 * `~` correctly for them against this process's own home directory.
 */

/**
 * True when `p` is fully qualified under EITHER the POSIX or the Windows
 * convention.
 *
 * Both conventions are accepted because the member's OS is not reliably known
 * at validation time: register_member detects the OS only AFTER connectivity is
 * established, which happens well after input validation, and a cloud member
 * that is currently stopped never gets probed at all. Accepting both is still
 * sufficient for the goal here -- `~/repo`, `repo`, and `./repo` are rejected
 * by both conventions, and those are exactly the inputs that break.
 */
export function isFullyQualifiedPath(p: string): boolean {
  const trimmed = p.trim();
  if (trimmed.length === 0) return false;
  // `~`, `~/x`, `~user/x` -- never fully qualified.
  if (trimmed.startsWith('~')) return false;
  // POSIX absolute.
  if (trimmed.startsWith('/')) return true;
  // Windows drive-absolute: C:\x or C:/x (a bare "C:x" is drive-RELATIVE).
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  // UNC share: \\server\share
  if (/^\\\\[^\\/]/.test(trimmed)) return true;
  return false;
}

/**
 * The rejection message for a non-fully-qualified remote work_folder.
 * `suffix` carries the caller's own "nothing was changed" convention
 * (register_member vs update_member word this differently).
 */
export function workFolderNotAbsoluteError(workFolder: string, suffix: string): string {
  return `❌ work_folder must be a fully-qualified path for remote members (got "${workFolder}"). `
    + `Provide an absolute path, e.g. "/home/bella/repo" (Linux/macOS) or "C:\\Users\\bella\\repo" (Windows). `
    + suffix;
}
