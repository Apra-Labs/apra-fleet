// Member-side config file I/O shared by compose_permissions and the provider
// adapters' per-folder member MCP wiring (syncMemberMcpEntry).
//
// Every command built here carries fully resolved paths -- never $HOME, ~/,
// $env:..., or backticks for the member's shell to expand -- because that
// shell may be PowerShell, not POSIX. The caller resolves the member's home
// in JavaScript (getMemberHomeDir) before handing paths in, and every path is
// quoted per shell (quotePosixPath / quotePwshPath) so a $, backtick or quote
// that is part of a real path name is passed through verbatim, never
// interpolated.
//
// The read/write command shapes are deliberately identical to the ones
// compose_permissions' deliverConfigFile has always issued (cat / heredoc
// FLEET_PERMS_EOF on POSIX, Get-Content / WriteAllText on PowerShell), so a
// single member-filesystem test double serves both.

import type { Agent, SSHExecResult } from '../types.js';
import type { MemberShell } from '../os/os-commands.js';
import type { MemberMcpSyncContext } from '../providers/provider.js';
import { isPosixShell } from '../utils/agent-helpers.js';
import { escapePowerShellArgInner } from '../utils/shell-escape.js';
import { BUILTIN_DEFAULT_PORT, DEFAULT_PORT } from '../paths.js';
import { MEMBER_ALLOWED_TOOLS, MEMBER_DENIED_TOOLS } from './member-tool-allowlist.js';

export type MemberExecFn = (command: string, timeoutMs?: number) => Promise<SSHExecResult>;

/** Name of the per-folder member MCP entry every provider writes. */
export const MEMBER_MCP_SERVER_NAME = 'apra-fleet';
/** Name of the retired url+bearer member entry; pruned wherever compose finds it. */
export const LEGACY_MEMBER_MCP_SERVER_NAME = 'apra-fleet-member';

const FS_OP_TIMEOUT_MS = 15000;

/**
 * The URL a member session uses to reach the fleet MCP server on its OWN
 * machine. `?member=<uuid>` identifies the session as that member, which is
 * what reduces the served tool list to the member allowlist. A local member
 * shares this process's server, so it follows this process's port (honoring
 * an APRA_FLEET_PORT sandbox); a remote member talks to its OWN install, on
 * the port that install records in its member-install marker
 * (agent.memberMcpPort, resolved on the member by the fleetMcp probe), or the
 * built-in default when it recorded none (the probe reports that in fleetMcp
 * detail). Two member installs on one host (one per Unix user) therefore each
 * get their own server, never the other user's.
 */
export function memberMcpUrl(agent: Pick<Agent, 'id' | 'agentType' | 'memberMcpPort'>): string {
  const port = agent.agentType === 'local' ? DEFAULT_PORT : (agent.memberMcpPort ?? BUILTIN_DEFAULT_PORT);
  return `http://localhost:${port}/mcp?member=${encodeURIComponent(agent.id)}`;
}

/** Claude permission deny rules: every registered fleet tool outside the member
 *  allowlist, on the member's apra-fleet server. Derived, never hand-listed. */
export function claudeMemberDenyRules(): string[] {
  return MEMBER_DENIED_TOOLS.map(tool => `mcp__${MEMBER_MCP_SERVER_NAME}__${tool}`);
}

/** Allow rules, in Claude's mcp__<server>__<tool> form, for every fleet tool in
 *  the member allowlist (kb_*, code_* and the self-reporting tools) -- never a
 *  maintainer-only or never-served tool. compose_permissions adds them to every
 *  composed profile so an acceptEdits session (a model without auto support)
 *  is not refused a member tool for lack of an allow rule. Derived, never
 *  hand-listed; agy maps the same tokens to mcp(<server>/<tool>). */
export function memberMcpAllowRules(): string[] {
  return MEMBER_ALLOWED_TOOLS.map(tool => `mcp__${MEMBER_MCP_SERVER_NAME}__${tool}`);
}

/** agy permission deny rules: same complement, in agy's mcp(<server>/<tool>) form. */
export function agyMemberDenyRules(): string[] {
  return MEMBER_DENIED_TOOLS.map(tool => `mcp(${MEMBER_MCP_SERVER_NAME}/${tool})`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Removes the legacy/superseded fleet MCP entries from a parsed config object,
 * in place, and reports whether anything changed:
 *  - mcpServers['apra-fleet-member'] and mcp['apra-fleet-member'] (the retired
 *    url+bearer registration);
 *  - mcpServers['apra-fleet'] when it is the old blanket `{disabled: true}`
 *    switch compose used to write.
 * Any other entry (deepwiki, user-added servers) is never touched. A map this
 * prune empties is removed so no `mcpServers: {}` residue is left behind.
 */
export function pruneLegacyMcpEntries(obj: Record<string, unknown>): boolean {
  let changed = false;
  for (const mapKey of ['mcpServers', 'mcp']) {
    const map = obj[mapKey];
    if (!isPlainObject(map)) continue;
    let touched = false;
    if (LEGACY_MEMBER_MCP_SERVER_NAME in map) {
      delete map[LEGACY_MEMBER_MCP_SERVER_NAME];
      touched = true;
    }
    const fleet = map[MEMBER_MCP_SERVER_NAME];
    if (isPlainObject(fleet) && fleet.disabled === true) {
      delete map[MEMBER_MCP_SERVER_NAME];
      touched = true;
    }
    if (touched) {
      changed = true;
      if (Object.keys(map).length === 0) delete obj[mapKey];
    }
  }
  return changed;
}

/** Joins `relPath` (forward-slash separated) onto an absolute member-side base
 *  directory, OS- and shell-appropriately. PowerShell members get backslashes;
 *  a Git-for-Windows (gitbash) member gets the C:/... form bash understands. */
export function joinMemberPath(base: string, relPath: string, isWindows: boolean, shell?: MemberShell): string {
  if (isWindows) {
    const b = base.replace(/[\\/]+$/, '').replace(/\//g, '\\');
    const winPath = `${b}\\${relPath.replace(/\//g, '\\')}`;
    if (isPosixShell(isWindows, shell)) return winPath.replace(/\\/g, '/');
    return winPath;
  }
  return `${base.replace(/\/+$/, '')}/${relPath}`;
}

/**
 * Quotes a resolved member-side path for a POSIX shell (bash/sh/zsh, including
 * Git-for-Windows bash). Wrapped in double quotes with every character that
 * stays special inside them -- $ (expansion), backtick (command substitution),
 * " (ends the string), and backslash (the escape character) -- backslash-escaped,
 * so the member's shell receives the path verbatim. Single quotes are literal
 * inside double quotes and need nothing. A path with no metacharacter yields
 * exactly `"<path>"`, the shape these commands have always carried.
 */
export function quotePosixPath(p: string): string {
  return `"${p.replace(/[\\"$`]/g, '\\$&')}"`;
}

/**
 * Quotes a resolved member-side path for PowerShell (5.1 and 7). Wrapped in
 * double quotes with every character that stays special inside them -- $
 * (expansion), backtick (the escape character), and the double-quote forms
 * PowerShell recognises (ASCII " and U+201C..U+201E) -- backtick-escaped.
 * Single quotes are literal inside double quotes and need nothing. A path with
 * no metacharacter yields exactly `"<path>"`.
 */
export function quotePwshPath(p: string): string {
  return `"${p.replace(/[`$"\u201C-\u201E]/g, '`$&')}"`;
}

/** quotePosixPath or quotePwshPath (with Windows backslashes) per shell. */
function quotePath(absPath: string, posix: boolean): string {
  return posix ? quotePosixPath(absPath) : quotePwshPath(absPath.replace(/\//g, '\\'));
}

function dirOf(absPath: string, posix: boolean): string {
  return posix
    ? absPath.split('/').slice(0, -1).join('/')
    : absPath.replace(/\//g, '\\').split('\\').slice(0, -1).join('\\');
}

/**
 * Command string that moves `staged` to `target`, making any missing parent
 * directory along the way. Target directory permissions follow the member's
 * default; only the staged file itself carries owner-only permissions
 * (creating its directory). POSIX also forces 0600 on the result; the staged
 * file is owner-only already. Carries resolved, quoted paths only.
 */
export function moveStagedFileCommand(staged: string, target: string, posix: boolean): string {
  if (posix) {
    const dir = target.split('/').slice(0, -1).join('/');
    return `mkdir -p ${quotePosixPath(dir)} && mv -f ${quotePosixPath(staged)} ${quotePosixPath(target)} && chmod 600 ${quotePosixPath(target)}`;
  }
  const t = target.replace(/\//g, '\\');
  const dir = t.split('\\').slice(0, -1).join('\\');
  return `New-Item -ItemType Directory -Force -Path ${quotePwshPath(dir)} | Out-Null; Move-Item -Force -LiteralPath ${quotePwshPath(staged.replace(/\//g, '\\'))} -Destination ${quotePwshPath(t)}`;
}

/**
 * A member-side config file the apra-fleet MCP sync cannot safely touch
 * (unreadable, not strict JSON, git-tracked, ...). compose_permissions treats it
 * as a RECOVERABLE condition: nothing is written to that file, the member's
 * fleetMcp status is recorded unavailable with `reason`, and the rest of
 * compose carries on.
 */
export class MemberConfigError extends Error {
  constructor(
    public readonly code: string,
    /** Machine-readable fleetMcp unavailable reason recorded by compose. */
    public readonly reason: string,
    public readonly filePath: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemberConfigError';
  }
}

/** The file exists but could not be read (EACCES, sharing violation, ...). */
export class MemberConfigUnreadableError extends MemberConfigError {
  constructor(filePath: string, detail?: string) {
    super(
      'E-MEMBER-CONFIG-UNREADABLE',
      'member-config-unreadable',
      filePath,
      `E-MEMBER-CONFIG-UNREADABLE: ${filePath} exists but could not be read${detail ? ` (${detail})` : ''}; refusing to treat it as empty or rewrite it`,
    );
    this.name = 'MemberConfigUnreadableError';
  }
}

/** The file exists and was read, but is not a strict JSON object (e.g. JSONC). */
export class MemberConfigNotJsonError extends MemberConfigError {
  constructor(filePath: string, detail: string, reason = 'member-config-unparseable') {
    super('E-MEMBER-CONFIG-NOT-JSON', reason, filePath, `E-MEMBER-CONFIG-NOT-JSON: ${filePath} ${detail}; refusing to rewrite it`);
    this.name = 'MemberConfigNotJsonError';
  }
}

/**
 * The read command for a member-side file. The existence test is built here in
 * JavaScript per shell (never shell-variable expansion): a MISSING file yields
 * empty output and exit 0, an EXISTING file that cannot be read yields a
 * non-zero exit -- the exit code is never swallowed.
 */
export function readMemberFileCommand(absPath: string, posix: boolean): string {
  const q = quotePath(absPath, posix);
  if (posix) return `if test -e ${q}; then cat ${q}; fi`;
  return `if (Test-Path -LiteralPath ${q}) { Get-Content -Raw -LiteralPath ${q} -ErrorAction Stop }`;
}

/** Read a member-side text file. A missing file reads as ''; an existing file
 *  that cannot be read THROWS MemberConfigUnreadableError (never reads as ''). */
export async function readMemberFile(exec: MemberExecFn, absPath: string, posix: boolean): Promise<string> {
  const r = await exec(readMemberFileCommand(absPath, posix), FS_OP_TIMEOUT_MS);
  if (typeof r.code === 'number' && r.code !== 0) {
    throw new MemberConfigUnreadableError(absPath, `exit ${r.code}${stderrExcerpt(r)}`);
  }
  return r.stdout ?? '';
}

/** PowerShell regular-file probe whose exit code reflects the result (a bare
 *  Test-Path prints True/False and exits 0 either way). `-PathType Leaf`
 *  excludes directories. Single-quoted literal (no expansion at all). */
export function memberFileExistsPwshCommand(absPath: string): string {
  const p = escapePowerShellArgInner(absPath.replace(/\//g, '\\'));
  return `if (Test-Path -LiteralPath '${p}' -PathType Leaf) { exit 0 } else { exit 1 }`;
}

/** POSIX regular-file probe: `test -f` (a directory, or a missing path, exits 1). */
export function memberFileExistsPosixCommand(absPath: string): string {
  return `test -f ${quotePosixPath(absPath)}`;
}

/**
 * True when a regular file exists at the member-side `absPath`. A directory at
 * that path reads as false (POSIX `test -f`, PowerShell `-PathType Leaf`), as
 * does a missing path or any other non-zero exit. The command carries a
 * resolved, quoted path only (no expansion).
 */
export async function memberFileExists(
  exec: MemberExecFn,
  absPath: string,
  posix: boolean,
): Promise<boolean> {
  const cmd = posix ? memberFileExistsPosixCommand(absPath) : memberFileExistsPwshCommand(absPath);
  const r = await exec(cmd, FS_OP_TIMEOUT_MS);
  return r.code === 0;
}

/**
 * True when git tracks `relPath` in the member work folder
 * (`git ls-files --error-unmatch`). Not a repo / git missing / untracked all
 * read as false. The command carries a resolved path only (no expansion), with
 * the path form the member's shell expects.
 */
export async function isGitTracked(
  exec: MemberExecFn,
  workFolder: string,
  relPath: string,
  isWindows: boolean,
  posix: boolean,
): Promise<boolean> {
  const wf = isWindows && !posix ? workFolder.replace(/\//g, '\\') : workFolder.replace(/\\/g, '/');
  const q = posix ? quotePosixPath : quotePwshPath;
  const r = await exec(`git -C ${q(wf)} ls-files --error-unmatch -- ${q(relPath)}`, FS_OP_TIMEOUT_MS);
  return r.code === 0;
}

/**
 * The command that prints the git repository root of `workFolder` on the
 * member. Resolved path, quoted per shell (quotePosixPath / quotePwshPath), no
 * $VAR, ~ or backtick expansion for the member shell to perform.
 */
export function memberRepoRootCommand(workFolder: string, isWindows: boolean, posix: boolean): string {
  const wf = isWindows && !posix ? workFolder.replace(/\//g, '\\') : workFolder.replace(/\\/g, '/');
  const q = posix ? quotePosixPath : quotePwshPath;
  return `git -C ${q(wf)} rev-parse --show-toplevel`;
}

/** Forward-slash, no trailing slash: the form Claude's project keys take. */
export function normalizeProjectKey(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The key Claude Code files a work folder's LOCAL-scope MCP servers under in
 * its config file (projects[<key>].mcpServers): the git repository root of the
 * folder, or the exact folder outside a git repo (git missing, not a repo, an
 * unusable answer). The ONE resolver for both the writer (syncMemberMcpEntry)
 * and the fleetMcp probe, so they can never disagree on the key.
 */
export async function resolveClaudeProjectKey(
  exec: MemberExecFn,
  workFolder: string,
  isWindows: boolean,
  posix: boolean,
): Promise<string> {
  const fallback = normalizeProjectKey(workFolder);
  try {
    const r = await exec(memberRepoRootCommand(workFolder, isWindows, posix), FS_OP_TIMEOUT_MS);
    if (r.code !== 0) return fallback;
    const root = (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (!root) return fallback;
    const absolute = root.startsWith('/') || /^[A-Za-z]:[\\/]/.test(root);
    return absolute ? normalizeProjectKey(root) : fallback;
  } catch {
    return fallback;
  }
}

/** Reads and parses a member-side JSON file. Returns {} for a missing/empty
 *  file; THROWS a typed MemberConfigError for an unreadable file or a non-empty
 *  file that is not a JSON object, so a caller can never clobber a file it
 *  could not understand. */
export async function readMemberJson(exec: MemberExecFn, absPath: string, posix: boolean): Promise<Record<string, unknown>> {
  const raw = (await readMemberFile(exec, absPath, posix)).trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemberConfigNotJsonError(absPath, 'exists but is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new MemberConfigNotJsonError(absPath, 'is not a JSON object');
  return parsed;
}

function stderrExcerpt(r: SSHExecResult): string {
  const s = (r.stderr ?? '').replace(/\s+/g, ' ').trim();
  return s ? `: ${s.slice(0, 300)}` : '';
}

/**
 * Writes `content` to a member-side file (creating its parent directory), then
 * reads it back and confirms it landed. Throws on a nonzero exit or a
 * read-back mismatch -- a write that did not land is never reported as done.
 */
export async function writeMemberFile(exec: MemberExecFn, absPath: string, content: string, posix: boolean): Promise<void> {
  const dir = dirOf(absPath, posix);
  const qPath = quotePath(absPath, posix);
  const qDir = quotePath(dir, posix);
  const mkdirCmd = posix ? `mkdir -p ${qDir}` : `New-Item -ItemType Directory -Force ${qDir}`;
  const mk = await exec(mkdirCmd, FS_OP_TIMEOUT_MS);
  if (mk.code !== 0) throw new Error(`could not create "${dir}" (exit ${mk.code})${stderrExcerpt(mk)}`);

  const body = content.replace(/\n+$/, '');
  const writeCmd = posix
    ? `cat > ${qPath} << 'FLEET_PERMS_EOF'\n${body}\nFLEET_PERMS_EOF`
    : `[System.IO.File]::WriteAllText(${qPath}, '${escapePowerShellArgInner(body + '\n')}', (New-Object System.Text.UTF8Encoding($false)))`;
  const w = await exec(writeCmd, FS_OP_TIMEOUT_MS);
  if (w.code !== 0) throw new Error(`write of ${absPath} failed (exit ${w.code})${stderrExcerpt(w)}`);

  if (!body.trim()) return; // an intentionally empty file has nothing to read back
  const back = (await readMemberFile(exec, absPath, posix)).trim();
  if (!back || !back.replace(/\r\n/g, '\n').includes(body.trim())) {
    throw new Error(`read-back of ${absPath} did not match what was written`);
  }
}

/** Writes a JSON object to a member-side file (pretty-printed), verified. */
export async function writeMemberJson(exec: MemberExecFn, absPath: string, obj: Record<string, unknown>, posix: boolean): Promise<void> {
  await writeMemberFile(exec, absPath, JSON.stringify(obj, null, 2), posix);
}

/**
 * Writes a config file that carries a member access secret WITHOUT the
 * content ever appearing in a command string: staged in an owner-only file
 * through the secret-file channel, then moved into place by a content-free
 * command (the file stays owner-only, 0600 on POSIX). No channel -> throws loudly;
 * there is no inline fallback.
 */
export async function writeSecretBearingConfig(ctx: MemberMcpSyncContext, file: string, content: string, posix: boolean): Promise<void> {
  if (!ctx.secretChannel) {
    throw new Error(`E-MEMBER-CONFIG-NO-FILE-CHANNEL: cannot write ${file} on the member without putting the member access secret on a command line; no secret-file channel is available for this member. Enable the SFTP subsystem on the member's sshd, or use a member type with a file channel.`);
  }
  const staged = await ctx.secretChannel.write(content);
  const r = await ctx.execCommand(moveStagedFileCommand(staged, file, posix), FS_OP_TIMEOUT_MS);
  if (r.code !== 0) {
    try { await ctx.secretChannel.remove(staged); } catch { /* best effort */ }
    throw new Error(`moving the staged config into ${file} failed (exit ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
}

/** Deletes a member-side file (no error when it is already gone). */
export async function deleteMemberFile(exec: MemberExecFn, absPath: string, posix: boolean): Promise<void> {
  const cmd = posix
    ? `rm -f ${quotePosixPath(absPath)}`
    : `Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath ${quotePath(absPath, false)}`;
  const r = await exec(cmd, FS_OP_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`delete of ${absPath} failed (exit ${r.code})${stderrExcerpt(r)}`);
}

/**
 * Resolves the member work folder's git exclude file (`.git/info/exclude`, or
 * the common git dir's for a worktree). Returns null when the work folder is
 * not a git repository -- there is nothing to keep clean then.
 */
export async function resolveGitExcludePath(
  exec: MemberExecFn,
  workFolder: string,
  isWindows: boolean,
  shell?: MemberShell,
): Promise<string | null> {
  const posix = isPosixShell(isWindows, shell);
  const wf = isWindows && !posix ? workFolder.replace(/\//g, '\\') : workFolder.replace(/\\/g, '/');
  const r = await exec(`git -C ${posix ? quotePosixPath(wf) : quotePwshPath(wf)} rev-parse --git-path info/exclude`, FS_OP_TIMEOUT_MS);
  const out = (r.stdout ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (r.code !== 0 || !out) return null;
  const isAbs = out.startsWith('/') || /^[A-Za-z]:[\\/]/.test(out);
  if (isAbs) return isWindows && !posix ? out.replace(/\//g, '\\') : out;
  return joinMemberPath(workFolder, out.replace(/\\/g, '/'), isWindows, shell);
}

/** Exclude-file line for a work-folder-relative path: anchored to the repo root. */
export function excludeLineFor(relPath: string): string {
  return `/${relPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/**
 * Adds each work-folder-relative path to the work folder's git exclude file so
 * files fleet writes into a member clone never show the clone as dirty. Never
 * touches a tracked file (.gitignore) -- info/exclude is local-only.
 */
export async function ensureGitExcluded(
  exec: MemberExecFn,
  workFolder: string,
  relPaths: string[],
  isWindows: boolean,
  shell?: MemberShell,
): Promise<void> {
  if (relPaths.length === 0) return;
  const excludePath = await resolveGitExcludePath(exec, workFolder, isWindows, shell);
  if (!excludePath) return;
  const posix = isPosixShell(isWindows, shell);
  const current = (await readMemberFile(exec, excludePath, posix)).replace(/\r\n/g, '\n');
  const lines = current.split('\n').map(l => l.trim());
  const missing = [...new Set(relPaths.map(excludeLineFor))].filter(l => !lines.includes(l));
  if (missing.length === 0) return;
  const base = current.replace(/\n+$/, '');
  const next = (base ? `${base}\n` : '') + missing.join('\n');
  await writeMemberFile(exec, excludePath, next, posix);
}

/** Removes the exclude lines ensureGitExcluded added for `relPaths`. */
export async function removeGitExcluded(
  exec: MemberExecFn,
  workFolder: string,
  relPaths: string[],
  isWindows: boolean,
  shell?: MemberShell,
): Promise<void> {
  if (relPaths.length === 0) return;
  const excludePath = await resolveGitExcludePath(exec, workFolder, isWindows, shell);
  if (!excludePath) return;
  const posix = isPosixShell(isWindows, shell);
  const current = (await readMemberFile(exec, excludePath, posix)).replace(/\r\n/g, '\n');
  if (!current.trim()) return;
  const drop = new Set(relPaths.map(excludeLineFor));
  const kept = current.replace(/\n+$/, '').split('\n').filter(l => !drop.has(l.trim()));
  const next = kept.join('\n');
  if (next === current.replace(/\n+$/, '')) return;
  await writeMemberFile(exec, excludePath, next, posix);
}

/**
 * Prunes the legacy fleet MCP entries (pruneLegacyMcpEntries) from an EXISTING
 * member-side JSON config file. A missing/empty file is left alone (never
 * created); the file is rewritten only when something was actually removed.
 * Returns whether it changed the file.
 */
export async function pruneLegacyMcpInMemberFile(exec: MemberExecFn, absPath: string, posix: boolean): Promise<boolean> {
  const config = await readMemberJson(exec, absPath, posix);
  if (Object.keys(config).length === 0) return false;
  if (!pruneLegacyMcpEntries(config)) return false;
  await writeMemberJson(exec, absPath, config, posix);
  return true;
}
