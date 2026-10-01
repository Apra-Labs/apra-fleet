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
import { knownRepoRemoteUrl } from '../member-remote-url.js';
import { getKbProviders, type KbProviders } from './kb-providers.js';

/** Explicit KB anchor for in-process callers. Not exposed on any tool schema. */
export interface KbAnchor {
  /** Repo root the KB is about (anchors relative source_files). */
  folder: string;
  /** Origin remote URL, when the folder lives on another host. */
  remoteUrl?: string;
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

function noWorkFolder(folder: string, memberLabel?: string): KbSelfError {
  return new KbSelfError(
    'E-SELF-NO-WORKFOLDER',
    folder,
    `The ${whose(memberLabel)} ${folder ? `'${folder}' does not exist or is not a directory.` : 'is not set.'}`,
    memberLabel
      ? 'Create the folder or re-register the member with an existing work folder (register_member / update_member).'
      : 'Start the fleet server from an existing repository folder.',
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

/** Validate a local folder as a KB anchor: exists, is a git repo, has an origin remote. */
export function validateSelfFolder(folder: string, memberLabel?: string): KbAnchor {
  let isDir = false;
  try { isDir = !!folder && fs.statSync(folder).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw noWorkFolder(folder, memberLabel);
  if (gitOut(folder, ['rev-parse', '--git-dir']) === null) {
    throw new KbSelfError(
      'E-SELF-NOT-A-REPO',
      folder,
      `The ${whose(memberLabel)} '${folder}' is not a git repository.`,
      `Run 'git init' (or clone the project) in '${folder}' and add an origin remote.`,
    );
  }
  const remote = gitOut(folder, ['remote', 'get-url', 'origin']);
  if (!remote) {
    throw new KbSelfError(
      'E-SELF-NO-REMOTE',
      folder,
      `The ${whose(memberLabel)} '${folder}' has no origin remote, so it has no KB identity.`,
      `Run 'git remote add origin <url>' in '${folder}'.`,
    );
  }
  return { folder };
}

/**
 * Resolve the calling session's own KB anchor (see header). Throws KbSelfError
 * when the resolved folder cannot carry a KB identity.
 */
export function resolveSelfAnchor(): KbAnchor {
  const memberId = getSessionMemberId();
  if (memberId === undefined) {
    return validateSelfFolder(process.cwd());
  }
  const agent = getAgent(memberId);
  const label = agent?.friendlyName ?? memberId;
  const folder = agent?.workFolder ?? '';
  if (!agent || !folder) throw noWorkFolder(folder, label);
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
    return { folder, remoteUrl };
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

/** Appended to every kb_* tool description so callers know there is no scope argument. */
export const KB_SELF_NOTE =
  ' Scope: always the calling session\'s own KB -- a member session uses its registered work folder, any other session the fleet server\'s working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).';
