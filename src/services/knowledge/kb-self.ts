// kb (self) resolution: which repo a kb_* tool call is about.
//
// No kb_* tool takes a scope parameter. The KB a call reads/writes is derived
// from WHO is calling:
//
//   MEMBER session (?member=<uuid> or a member JWT) -- the member's registered
//     work folder (getSessionMemberId() from the tool-scope lane).
//   FULL session (no member identity) -- the MCP client's roots (roots/list,
//     cached per session by src/services/session-roots.ts): the first offered
//     root that is a git repository with an origin remote wins. The server's
//     own working folder is used only when the client offers no roots.
//
// An HTTP server cannot see a client's cwd, so a FULL session whose client
// offers no roots gets the server's folder.
//
// KB identity comes from the resolved folder's origin remote, so a folder that
// is missing, is not a git repository, or has no origin remote is refused with
// a typed error carrying one line of remediation -- never silently mapped to a
// directory-name or 'default' KB.
//
// In-process callers that already know exactly which repo they mean (the
// execute_prompt post-dispatch harvest, the `kb commit` CLI) pass an explicit
// KbAnchor as the handler's second argument. That argument is not part of any
// tool's input schema, so no MCP client can supply it.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getSelfMemoSlot, getSessionMemberId, getSessionRoots, type SessionRoots } from '../tool-scope.js';
import { getAgent } from '../registry.js';
import type { Agent } from '../../types.js';
import { knownRepoRemoteUrl } from '../member-remote-url.js';
import { getKbProviders, getGlobalKbProvider, getProjectSlug, type KbProviders } from './kb-providers.js';
import { getMemberBibleView } from './member-bible-view.js';
import { requireSqliteProject } from './require-sqlite-project.js';
import type { SqliteProvider } from './sqlite-provider.js';
import { gitExecutable } from '../../os/git-executable.js';

/** Explicit KB anchor for in-process callers. Not exposed on any tool schema. */
export interface KbAnchor {
  /** Repo root the KB is about (anchors relative source_files). */
  folder: string;
  /** Origin remote URL, when the folder lives on another host. */
  remoteUrl?: string;
  /** Registered member whose host the folder lives on (set with remoteUrl). */
  memberId?: string;
}

export type KbSelfErrorCode = 'E-SELF-NO-WORKFOLDER' | 'E-SELF-NOT-A-REPO' | 'E-SELF-NO-REMOTE';

export class KbSelfError extends Error {
  readonly code: KbSelfErrorCode;
  readonly folder: string;
  readonly remediation: string;
  constructor(code: KbSelfErrorCode, folder: string, problem: string, remediation: string) {
    super(`${code}: ${problem} Remediation: ${remediation}`);
    this.name = 'KbSelfError';
    this.code = code;
    this.folder = folder;
    this.remediation = remediation;
  }
}

function whose(memberLabel: string | undefined): string {
  return memberLabel ? `member '${memberLabel}' work folder` : 'server working folder';
}

// A FULL session (no member identity) resolves from the MCP client's roots
// when the client offers any (see resolveSelfSession), else from the fleet
// SERVER's working folder -- never the client's cwd, which an HTTP server
// cannot see. A caller hitting a self error on the server-folder path usually
// expected its own directory, so the error names that cause (including
// whether the client offered roots) and every fix explicitly.
function fullSessionCause(): string {
  return "This is a FULL session (no member identity) and the client offered no MCP roots, so its scope is the fleet server's own working folder, not the calling client's directory";
}
const FULL_SESSION_FIX =
  "Open the client in the repository (a client that offers MCP roots is scoped to its first root inside a git repository with an origin remote), restart the fleet server with its working folder set to that repository, or call from a member session (?member=<id>) of a member registered on it.";

function listForError(items: readonly string[]): string {
  const shown = items.slice(0, 5).map(i => `'${i}'`).join(', ');
  return items.length > 5 ? `${shown}, and ${items.length - 5} more` : shown;
}

function noWorkFolder(folder: string, memberLabel?: string): KbSelfError {
  return new KbSelfError(
    'E-SELF-NO-WORKFOLDER',
    folder,
    `The ${whose(memberLabel)} ${folder ? `'${folder}' does not exist or is not a directory.` : 'is not set.'}`,
    memberLabel
      ? 'Create the folder or re-register the member with an existing work folder (register_member / update_member).'
      : FULL_SESSION_FIX,
  );
}

function gitOut(folder: string, args: string[], opts: { ceiling?: boolean } = {}): string | null {
  // Same ceiling as resolveProjectSlug: the folder itself must be the repo, so a
  // temp folder that merely sits inside some other checkout is not mistaken
  // for that checkout.
  const env = opts.ceiling === false ? process.env : { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(folder) };
  try {
    return execFileSync(gitExecutable(), args, {
      cwd: folder, env, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Validate a local folder as a (self) repo: it exists and is a git repository.
 * Shared by kb (self) and code (self) resolution -- code tools need no origin
 * remote (an index is keyed by folder, not by KB identity), kb tools add the
 * remote check on top (validateSelfFolder).
 */
export function validateSelfRepoFolder(folder: string, memberLabel?: string): void {
  let isDir = false;
  try { isDir = !!folder && fs.statSync(folder).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw noWorkFolder(folder, memberLabel);
  if (gitOut(folder, ['rev-parse', '--git-dir']) === null) {
    throw new KbSelfError(
      'E-SELF-NOT-A-REPO',
      folder,
      memberLabel
        ? `The ${whose(memberLabel)} '${folder}' is not a git repository.`
        : `${fullSessionCause()}; '${folder}' is not a git repository.`,
      memberLabel
        ? `Run 'git init' (or clone the project) in '${folder}' and add an origin remote.`
        : `${FULL_SESSION_FIX} Or make '${folder}' itself a git repository with an origin remote.`,
    );
  }
}

/** Validate a local folder as a KB anchor: exists, is a git repo, has an origin remote. */
export function validateSelfFolder(folder: string, memberLabel?: string): KbAnchor {
  validateSelfRepoFolder(folder, memberLabel);
  const remote = gitOut(folder, ['remote', 'get-url', 'origin']);
  if (!remote) {
    throw new KbSelfError(
      'E-SELF-NO-REMOTE',
      folder,
      memberLabel
        ? `The ${whose(memberLabel)} '${folder}' has no origin remote, so it has no KB identity.`
        : `${fullSessionCause()}; '${folder}' has no origin remote, so it has no KB identity.`,
      memberLabel
        ? `Run 'git remote add origin <url>' in '${folder}'.`
        : `${FULL_SESSION_FIX} Or run 'git remote add origin <url>' in '${folder}'.`,
    );
  }
  return { folder };
}

/** The calling session's (self) folder before any repo validation. */
export interface SelfSession {
  /** Member id of a MEMBER session; undefined for a FULL session. */
  memberId?: string;
  /** Member friendly name (or id) used in error text; undefined for FULL. */
  memberLabel?: string;
  /**
   * The member's registered work folder; for a FULL session the selected
   * client root, else the server working folder.
   */
  folder: string;
  /** The registered member (MEMBER session only). */
  agent?: Agent;
  /**
   * FULL session only: where `folder` came from -- 'root' (the top level of
   * the git repository an MCP client root sits in, already verified) or 'cwd'
   * (the server working folder, not yet validated).
   */
  source?: 'root' | 'cwd';
  /**
   * FULL session only, with source 'root': true when NO offered root is in a
   * git repository with an origin remote and `folder` is the first offered
   * git repository instead. code_* tools may use it (they need no origin);
   * kb_* tools refuse it (resolveSelfAnchor), so kb and code never resolve to
   * two different repositories.
   */
  rootWithoutOrigin?: boolean;
  /** FULL session only: the client roots this resolution saw. */
  roots?: SessionRoots;
}

function hasOriginRemote(folder: string): boolean {
  return !!gitOut(folder, ['remote', 'get-url', 'origin']);
}

/**
 * The top level of the git repository a client root sits in, or null when it
 * is in none. Unlike a member's registered work folder, a root is wherever the
 * client was opened, often a subfolder, so there is no ceiling here. A root
 * that already is the top level keeps its spelling (git answers with resolved
 * symlinks, short names expanded and forward slashes), so it names the same
 * index and KB folder as before.
 */
function rootRepoTopLevel(root: string): string | null {
  const top = gitOut(root, ['rev-parse', '--show-toplevel'], { ceiling: false });
  if (!top) return null;
  try {
    if (fs.realpathSync.native(root) === fs.realpathSync.native(top)) return root;
  } catch { /* fall through to git's answer */ }
  return path.resolve(top);
}

/**
 * FULL session (self) selection (owner decision: client roots first, server
 * working folder only when the client offers no roots). A root inside a git
 * repository stands for that repository's top level, so a client opened in a
 * subfolder scopes to the repository:
 *
 *   1. The first offered root in a git repository with an origin remote.
 *   2. Extension for code_* only: when roots are offered and none has an
 *      origin, the first offered root in a git repository
 *      (rootWithoutOrigin: kb_* refuses it).
 *   3. No roots offered (no roots capability or an empty list): the server
 *      working folder.
 *
 * Everything else is refused, never answered from the server folder: it may be
 * an unrelated repository, and the caller could not tell.
 *   - Asking the client failed: E-SELF-NO-WORKFOLDER naming the failure; the
 *     next call asks again.
 *   - No offered root is a folder on this host (a remote client's path, a
 *     deleted folder, a non-file URI): E-SELF-NO-WORKFOLDER.
 *   - Roots on this host but none in a git repository: E-SELF-NOT-A-REPO.
 */
function selectFullSessionFolder(): SelfSession {
  const roots = getSessionRoots();
  if (roots?.fetchError !== undefined) {
    throw new KbSelfError(
      'E-SELF-NO-WORKFOLDER',
      '',
      `This is a FULL session (no member identity) and asking the client for its MCP roots failed (${roots.fetchError}), so the session's scope is unknown; the call was not run and the server's working folder was not used in its place.`,
      'Retry the same call: each call asks the client again. If it keeps failing, restart the client or check that it answers roots/list.',
    );
  }
  if (!roots || roots.offered.length === 0) {
    return { folder: process.cwd(), source: 'cwd', ...(roots ? { roots } : {}) };
  }
  if (roots.folders.length === 0) {
    throw new KbSelfError(
      'E-SELF-NO-WORKFOLDER',
      roots.offered[0],
      `This is a FULL session (no member identity) and the client offered MCP roots, but none of them (${listForError(roots.offered)}) is a folder on this host, so the session has no KB or code scope; the server's working folder was not used in its place.`,
      'Open the client on this host in a git repository with an origin remote, or call from a member session (?member=<id>) of a member registered on that folder.',
    );
  }
  let firstRepo: string | undefined;
  for (const root of roots.folders) {
    const folder = rootRepoTopLevel(root);
    if (folder === null) continue;
    if (hasOriginRemote(folder)) return { folder, source: 'root', roots };
    if (firstRepo === undefined) firstRepo = folder;
  }
  if (firstRepo !== undefined) return { folder: firstRepo, source: 'root', rootWithoutOrigin: true, roots };
  throw new KbSelfError(
    'E-SELF-NOT-A-REPO',
    roots.folders[0],
    `This is a FULL session (no member identity) and the client offered MCP roots, but none of them (${listForError(roots.folders)}) is in a git repository, so the session has no KB or code scope.`,
    `Open the client in a git repository with an origin remote (or add one as a root), or run 'git init' and 'git remote add origin <url>' in '${roots.folders[0]}'.`,
  );
}

/**
 * Resolve WHICH folder the calling session means by (self): a MEMBER session's
 * registered work folder; a FULL session's selected client root, else the
 * server working folder (selectFullSessionFolder). A MEMBER session whose
 * member is unregistered or has no work folder is refused with
 * E-SELF-NO-WORKFOLDER -- it never falls back to the server folder, and never
 * reads client roots.
 *
 * Inside a tool call the FULL selection is memoized for the rest of that call,
 * so kb (self) and code (self) share one answer and cannot diverge.
 */
export function resolveSelfSession(): SelfSession {
  const memberId = getSessionMemberId();
  if (memberId === undefined) {
    const memo = getSelfMemoSlot();
    if (!memo) return selectFullSessionFolder();
    if (memo.error !== undefined) throw memo.error;
    if (memo.value !== undefined) return memo.value as SelfSession;
    try {
      memo.value = selectFullSessionFolder();
      return memo.value as SelfSession;
    } catch (e) {
      memo.error = e;
      throw e;
    }
  }
  const agent = getAgent(memberId);
  const label = agent?.friendlyName ?? memberId;
  const folder = agent?.workFolder ?? '';
  if (!agent || !folder) throw noWorkFolder(folder, label);
  return { memberId, memberLabel: label, folder, agent };
}

/**
 * Resolve the calling session's own KB anchor (see header). Throws KbSelfError
 * when the resolved folder cannot carry a KB identity.
 */
export function resolveSelfAnchor(): KbAnchor {
  const self = resolveSelfSession();
  const { agent, folder, memberLabel: label, memberId } = self;
  if (!agent) {
    if (self.rootWithoutOrigin) {
      throw new KbSelfError(
        'E-SELF-NO-REMOTE',
        folder,
        `This is a FULL session (no member identity) and none of the client's MCP roots (${listForError(self.roots?.folders ?? [folder])}) is in a git repository with an origin remote, so the session has no KB identity (code tools use the first offered git repository, '${folder}').`,
        `Run 'git remote add origin <url>' in '${folder}', or open the client in a repository that has an origin remote.`,
      );
    }
    return validateSelfFolder(folder);
  }
  if (agent.agentType !== 'local') {
    // The work folder lives on another host: git cannot be shelled out there,
    // so the KB identity is the member's single known origin remote.
    const remoteUrl = knownRepoRemoteUrl(agent);
    if (!remoteUrl) {
      throw new KbSelfError(
        'E-SELF-NO-REMOTE',
        folder,
        `Member '${label}' work folder '${folder}' is on another host and the member has no single known origin remote, so it has no KB identity.`,
        `Record the repo's origin URL on the member (update_member git_repos: ["<origin url>"]) or call kb tools from a session on the member's own host.`,
      );
    }
    return { folder, remoteUrl, memberId };
  }
  return validateSelfFolder(folder, label);
}

/** The anchor a kb_* handler uses: the explicit in-process anchor, else (self). */
export function resolveKbAnchor(anchor?: KbAnchor): KbAnchor {
  return anchor ?? resolveSelfAnchor();
}

/** KB providers for a kb_* handler call. */
export async function getSelfKbProviders(anchor?: KbAnchor): Promise<KbProviders> {
  const resolved = resolveKbAnchor(anchor);
  return getKbProviders(resolved.folder, resolved.remoteUrl);
}

/**
 * The own-scope tag of the calling MEMBER session, 'member:<uuid>', or
 * undefined for a FULL session or an in-process caller passing an explicit
 * KbAnchor (same predicate getSelfReadKb uses to pick the bible view).
 * MEMBER captures carry this tag, and MEMBER INFERRED/UNVERIFIED reads,
 * kb_promote and kb_invalidate act only on entries carrying it.
 */
export function memberOwnerTag(anchor?: KbAnchor): string | undefined {
  if (anchor !== undefined) return undefined;
  const memberId = getSessionMemberId();
  return memberId === undefined ? undefined : `member:${memberId}`;
}

/** KB providers for a read-only kb_* call, plus the anchor they were resolved from. */
export interface SelfReadKb {
  providers: KbProviders;
  anchor: KbAnchor;
  /** True when `providers.project` is the member's in-memory bible view. */
  memberView: boolean;
  /**
   * Set when a MEMBER session explicitly asked for INFERRED/UNVERIFIED: the
   * request is answered from the per-repo DB and every read must return only
   * entries carrying this tag (member:<uuid>), so a member never sees another
   * member's unconfirmed captures even when they share a machine.
   */
  ownerTag?: string;
}

/**
 * Providers for the read tools (kb_query, kb_session_prime, kb_list,
 * kb_context, kb_stats). A MEMBER session (no explicit anchor) reads its own
 * checkout bible through the in-memory view (member-bible-view.ts); the
 * per-repo DB is shared by every member of the repo, whichever branch each is
 * on. Everything else keeps the per-repo DB: FULL sessions, in-process callers
 * passing an explicit KbAnchor, a MEMBER request that explicitly names the
 * INFERRED or UNVERIFIED tier (a bible carries the CONFIRMED set, so those
 * tiers are not the view's to answer), and a MEMBER request that opts into
 * `ownScope` (see below). The global KB is unchanged either way. Both of
 * those last two MEMBER cases carry `ownerTag`: the caller sees only its own
 * captures.
 *
 * `ownScope` is the opt-in escape hatch from the bible view for a CONFIRMED
 * read: the bible view is built by importBibleEntries, which stamps every row
 * `tags: []` (bible-import.ts), so a bible-view read can never satisfy a
 * `tag: 'member:<uuid>'` filter -- there is no row in that view carrying any
 * member tag to match. A caller that needs to read back its OWN promoted
 * CONFIRMED rows (e.g. kb_demote's candidate list, which must only ever offer
 * ids kb_demote's ownerTag check can actually act on) sets `ownScope: true` to
 * route to the per-repo DB instead, same as an explicit INFERRED/UNVERIFIED
 * request. Default false/omitted: the routing above is unchanged, so no
 * existing caller's result shape moves.
 */
export async function getSelfReadKb(
  anchor?: KbAnchor,
  confidence?: readonly string[],
  ownScope?: boolean,
): Promise<SelfReadKb> {
  const resolved = resolveKbAnchor(anchor);
  const namesUnconfirmedTier = (confidence ?? []).some(c => c !== 'CONFIRMED');
  if (anchor === undefined && getSessionMemberId() !== undefined && !namesUnconfirmedTier && !ownScope) {
    const [project, global] = await Promise.all([getMemberBibleView(resolved), getGlobalKbProvider()]);
    return {
      providers: { project, global, projectSlug: getProjectSlug(resolved.folder, resolved.remoteUrl) },
      anchor: resolved,
      memberView: true,
    };
  }
  const ownerTag = memberOwnerTag(anchor);
  return {
    providers: await getKbProviders(resolved.folder, resolved.remoteUrl),
    anchor: resolved,
    memberView: false,
    ...(ownerTag !== undefined ? { ownerTag } : {}),
  };
}

export type KbTier = 'CONFIRMED' | 'INFERRED' | 'UNVERIFIED';

/**
 * The two halves of a MEMBER mixed-tier read (see getMemberSplitRead).
 *
 * `bible` answers the CONFIRMED tier from exactly the source a CONFIRMED-only
 * member read uses: the member's checkout bible view plus the global KB, with
 * NO owner tag. `own` answers EVERY requested tier (CONFIRMED included) from
 * the per-repo DB and the global KB, both restricted to `ownerTag`, so a member
 * never sees another member's DB-only captures at any tier, while its own
 * capture promoted to CONFIRMED in the per-repo DB stays visible before it
 * reaches the bible (the bible copy wins on a shared id).
 */
export interface MemberSplitRead {
  anchor: KbAnchor;
  projectSlug: string;
  bible: { project: SqliteProvider; global: SqliteProvider; tiers: KbTier[] };
  own: { project: SqliteProvider; global: SqliteProvider; tiers: KbTier[]; ownerTag: string };
}

/**
 * The shared split read for a MEMBER session whose explicit tier list names
 * CONFIRMED together with at least one other tier. Returns null for every other
 * request, which then keeps its existing path through getSelfReadKb: a FULL
 * session, an explicit-KbAnchor caller, a CONFIRMED-only (or omitted) tier list
 * (bible view), and a list naming only non-CONFIRMED tiers (own captures only).
 *
 * Callers query each half with its own tiers and owner tag, then merge with
 * mergeSplitById (bible copy wins) and apply their limit after the merge.
 *
 * Non-sqlite per-repo provider (a remote HTTP KB): the own half is refused
 * with requireSqliteProject's error naming `callerLabel`, exactly as the
 * same request was refused before the split existed. Answering with the bible
 * half alone would silently drop tiers the caller asked for, so the request
 * fails loudly instead.
 */
export async function getMemberSplitRead(
  anchor: KbAnchor | undefined,
  confidence: readonly string[] | undefined,
  callerLabel: string,
): Promise<MemberSplitRead | null> {
  if (anchor !== undefined || getSessionMemberId() === undefined) return null;
  const tiers = [...new Set(confidence ?? [])] as KbTier[];
  if (!tiers.includes('CONFIRMED') || tiers.every(t => t === 'CONFIRMED')) return null;
  const ownerTag = memberOwnerTag(anchor);
  if (ownerTag === undefined) return null;
  const resolved = resolveKbAnchor(anchor);
  const [view, global, repo] = await Promise.all([
    getMemberBibleView(resolved),
    getGlobalKbProvider(),
    getKbProviders(resolved.folder, resolved.remoteUrl),
  ]);
  return {
    anchor: resolved,
    projectSlug: repo.projectSlug,
    bible: { project: view, global, tiers: ['CONFIRMED'] },
    own: { project: requireSqliteProject(repo.project, callerLabel), global: repo.global, tiers, ownerTag },
  };
}

/**
 * Merge the two halves of a split read: every `bible` row, then each `own` row
 * whose id the bible half did not already return (the bible copy wins). An
 * optional `order` re-sorts the merged list; `limit` is applied last.
 */
export function mergeSplitById<T extends { id: string }>(
  bible: readonly T[],
  own: readonly T[],
  opts: { limit?: number; order?: (a: T, b: T) => number } = {},
): T[] {
  const seen = new Set(bible.map(e => e.id));
  let merged = [...bible, ...own.filter(e => !seen.has(e.id))];
  if (opts.order) merged = merged.sort(opts.order);
  return opts.limit !== undefined ? merged.slice(0, opts.limit) : merged;
}

/** Appended to every kb_* tool description so callers know there is no scope argument. */
export const KB_SELF_NOTE =
  ' Scope: always the calling session\'s own KB -- a member session uses its registered work folder; any other session uses the first MCP client root (roots/list) inside a git repository with an origin remote, as that repository\'s top level, or the fleet server\'s working folder when the client offers no roots; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).';
