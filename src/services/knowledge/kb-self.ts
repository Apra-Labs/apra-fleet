// kb (self) resolution: which repo a kb_* tool call is about.
//
// No kb_* tool takes a scope parameter. The KB a call reads/writes is derived
// from WHO is calling:
//
//   MEMBER session (?member=<uuid> or a member JWT) -- the member's registered
//     work folder (getSessionMemberId() from the tool-scope lane).
//   FULL session (no member identity) -- the server's own working folder.
//
// An HTTP server cannot see a client's cwd, so there is no separate (self) for
// local non-member callers: they get the server's folder.
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
import { getSessionMemberId } from '../tool-scope.js';
import { getAgent } from '../registry.js';
import type { Agent } from '../../types.js';
import { knownRepoRemoteUrl } from '../member-remote-url.js';
import { getKbProviders, getGlobalKbProvider, getProjectSlug, type KbProviders } from './kb-providers.js';
import { getMemberBibleView } from './member-bible-view.js';

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

// A FULL session (no member identity) resolves to the fleet SERVER's working
// folder, never the client's: an HTTP server cannot see a client's cwd. A
// caller hitting a self error there usually expected its own directory, so the
// error names that cause and both fixes explicitly.
const FULL_SESSION_CAUSE =
  "This is a FULL session (no member identity), so its KB is the fleet server's own working folder, not the calling client's directory";
const FULL_SESSION_FIX =
  'Restart the fleet server with its working folder set to the repository whose KB you want, or call from a member session (?member=<id>) of a member registered on that repository.';

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

function gitOut(folder: string, args: string[]): string | null {
  // Same ceiling as resolveProjectSlug: the folder itself must be the repo, so a
  // temp folder that merely sits inside some other checkout is not mistaken
  // for that checkout.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(folder) };
  try {
    return execFileSync('git', args, {
      cwd: folder, env, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
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
        : `${FULL_SESSION_CAUSE}; '${folder}' is not a git repository.`,
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
        : `${FULL_SESSION_CAUSE}; '${folder}' has no origin remote, so it has no KB identity.`,
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
  /** The member's registered work folder, or the server working folder. */
  folder: string;
  /** The registered member (MEMBER session only). */
  agent?: Agent;
}

/**
 * Resolve WHICH folder the calling session means by (self): a MEMBER session's
 * registered work folder, a FULL session's server working folder. A MEMBER
 * session whose member is unregistered or has no work folder is refused with
 * E-SELF-NO-WORKFOLDER -- it never falls back to the server folder.
 */
export function resolveSelfSession(): SelfSession {
  const memberId = getSessionMemberId();
  if (memberId === undefined) return { folder: process.cwd() };
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
  if (!agent) return validateSelfFolder(folder);
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

/** Appended to every kb_* tool description so callers know there is no scope argument. */
export const KB_SELF_NOTE =
  ' Scope: always the calling session\'s own KB -- a member session uses its registered work folder, any other session the fleet server\'s working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).';
