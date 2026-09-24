import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { getStrategy } from '../services/strategy.js';
import {
  buildGitStatusProbes,
  isInsideWorkTree,
  parsePorcelainV2,
  parseWorktreeList,
  originSlugFromUrl,
  PLAYBOOK_FILES,
  type GitProbe,
  type GitProbeName,
  type GitDirtyEntry,
  type GitWorktree,
} from '../services/git-status-probe.js';
import type { Agent, SSHExecResult } from '../types.js';

/**
 * member_git_status (design refs F2, DQ-27).
 *
 * Runs the F2 git probe sequence on a member through the existing execute
 * path and returns the parsed checkout state: branch/upstream/ahead/behind,
 * dirty paths, linked work trees, the origin remote and its normalised slug,
 * which of the target playbook files are present, and the last commit that
 * touched the knowledge-bank export.
 *
 * The command strings themselves come from src/services/git-status-probe.ts
 * -- ONE ordered list shared by this tool and its tests, so neither the
 * sequence nor its per-OS/shell spelling can drift between them.
 *
 * DQ-27: a folder that is not a git work tree is a normal answer, not an
 * error. The first probe decides, and the remaining five are skipped, so
 * `checkout` is null and `ok` stays true. The server never requires a member
 * to have a checkout.
 */
export const memberGitStatusSchema = z.object({
  ...memberIdentifier,
  folder: z.string().optional().describe(
    'Absolute path on the member to inspect. Defaults to the member\'s registered work folder. '
    + 'A folder that is not a git work tree is reported as checkout: null, not as an error.'
  ),
});

export type MemberGitStatusInput = z.infer<typeof memberGitStatusSchema>;

/** Machine-readable outcome discriminator, mirroring member_owner's MemberOwnerOutcome. */
export type MemberGitStatusOutcome =
  | 'checkout'
  | 'no_checkout'
  | 'member_not_found'
  | 'no_folder'
  | 'failed';

/** Parsed state of one git checkout on a member. */
export interface MemberGitCheckout {
  /** The folder that was probed, exactly as it was sent to the member. */
  path: string;
  /** Branch short name, or null when detached or unborn. */
  branch: string | null;
  /** True when HEAD is detached. */
  detached: boolean;
  /** HEAD commit sha, or null on an unborn branch. */
  head: string | null;
  /** Upstream ref (e.g. origin/main), or null when there is none. */
  upstream: string | null;
  /** Commits ahead of upstream; null when there is no upstream. */
  ahead: number | null;
  /** Commits behind upstream; null when there is no upstream. */
  behind: number | null;
  /** True when any tracked change, unmerged path or untracked file exists. */
  dirty: boolean;
  /** Every changed/unmerged/untracked path (ignored files excluded). */
  dirtyFiles: GitDirtyEntry[];
  /** Work trees reported by `git worktree list --porcelain`. */
  worktrees: GitWorktree[];
  /** The origin remote URL, or null when the repository has no origin. */
  originUrl: string | null;
  /** originUrl normalised to host/path, or null when there is no origin. */
  originSlug: string | null;
  /** Which of the target playbook files exist in the checkout root. */
  playbooks: string[];
  /** Last commit that touched .fleet/kb-canonical.json, or null when there is none. */
  bibleCommit: string | null;
}

/**
 * The machine-readable field set of this tool's structuredContent. Exported
 * because packages/apra-fleet-client's client-server-typedef-parity test
 * parses THIS interface as the ground truth for its MemberGitStatusResult
 * JSDoc typedef -- the two have no compile-time link, so the parity test is
 * what keeps the hand-maintained client typedef honest.
 */
export interface MemberGitStatusFields {
  /** Machine-readable outcome discriminator. Branch on this, never on `text`. */
  outcome: MemberGitStatusOutcome;
  /** True when the probe ran and produced an answer -- including "no checkout here". */
  ok: boolean;
  /** Registry id of the resolved member, or null when no member resolved. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null when no member resolved. */
  memberName: string | null;
  /** The folder that was probed, or null when none could be resolved. */
  folder: string | null;
  /** Parsed checkout state, or null when the folder is not a git work tree (DQ-27). */
  checkout: MemberGitCheckout | null;
  /** Failure detail when outcome is member_not_found/no_folder/failed, else null. */
  error: string | null;
}

export interface MemberGitStatusStructured extends MemberGitStatusFields {
  [key: string]: unknown;
}

export interface MemberGitStatusResult {
  text: string;
  structuredContent: MemberGitStatusStructured;
}

/** Per-probe timeout. A git probe on a healthy checkout answers in well under a second. */
const PROBE_TIMEOUT_MS = 30_000;

function statusResult(
  text: string,
  fields: Omit<MemberGitStatusFields, 'ok'> & { ok?: boolean },
): MemberGitStatusResult {
  const failedOutcomes: MemberGitStatusOutcome[] = ['member_not_found', 'no_folder', 'failed'];
  const ok = fields.ok ?? !failedOutcomes.includes(fields.outcome);
  return { text, structuredContent: { ...fields, ok } };
}

/** Trimmed stdout of a probe that succeeded, or null when it did not. */
function okStdout(result: SSHExecResult | undefined): string | null {
  if (!result || result.code !== 0) return null;
  const out = result.stdout.trim();
  return out === '' ? null : out;
}

/**
 * Assemble the checkout shape from the raw probe results, keyed by probe
 * name. Exported so the tool's tests can pin the mapping from recorded
 * probe output to the design-doc shape without stubbing a strategy.
 */
export function buildCheckout(folder: string, outputs: Map<GitProbeName, SSHExecResult>): MemberGitCheckout {
  const status = parsePorcelainV2(outputs.get('status')?.stdout ?? '');
  const worktrees = parseWorktreeList(okStdout(outputs.get('worktrees')) ?? '');
  const originUrl = okStdout(outputs.get('originUrl'));
  const playbookOut = okStdout(outputs.get('playbooks')) ?? '';
  const reported = new Set(playbookOut.split('\n').map((line) => line.trim()).filter(Boolean));
  return {
    path: folder,
    branch: status.branch,
    detached: status.detached,
    head: status.head,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    dirty: status.dirty,
    dirtyFiles: status.dirtyFiles,
    worktrees,
    originUrl,
    originSlug: originSlugFromUrl(originUrl),
    // Filtered against the known contract rather than echoed, so unexpected
    // member-side output can never masquerade as a playbook name.
    playbooks: PLAYBOOK_FILES.filter((file) => reported.has(file)),
    bibleCommit: okStdout(outputs.get('bibleCommit')),
  };
}

function summarise(member: Agent, checkout: MemberGitCheckout): string {
  const where = checkout.branch ?? (checkout.detached ? 'detached HEAD' : 'no branch');
  const tracking = checkout.upstream
    ? ` (tracking ${checkout.upstream}, +${checkout.ahead ?? 0}/-${checkout.behind ?? 0})`
    : ' (no upstream)';
  const dirt = checkout.dirty ? `${checkout.dirtyFiles.length} changed path(s)` : 'clean';
  const origin = checkout.originSlug ? `origin ${checkout.originSlug}` : 'no origin remote';
  return `[OK] ${member.friendlyName}: ${checkout.path} on ${where}${tracking} -- ${dirt}, ${origin}.`;
}

export async function memberGitStatus(input: MemberGitStatusInput): Promise<MemberGitStatusResult> {
  const memberOrError = resolveMember(input.member_id, input.member_name);
  if (typeof memberOrError === 'string') {
    return statusResult(memberOrError, {
      outcome: 'member_not_found',
      memberId: input.member_id ?? null,
      memberName: input.member_name ?? null,
      folder: input.folder ?? null,
      checkout: null,
      error: memberOrError,
    });
  }
  const member = memberOrError as Agent;
  const base = { memberId: member.id, memberName: member.friendlyName };

  const folder = input.folder ?? member.workFolder;
  if (!folder) {
    const error = `Member "${member.friendlyName}" has no work folder registered and no "folder" was supplied.`;
    return statusResult(`[-] ${error}`, { ...base, outcome: 'no_folder', folder: null, checkout: null, error });
  }

  const probes: GitProbe[] = buildGitStatusProbes(folder, getAgentOS(member), getAgentShell(member));
  const strategy = getStrategy(member);
  const outputs = new Map<GitProbeName, SSHExecResult>();

  try {
    for (const probe of probes) {
      const result = await strategy.execCommand(probe.command, PROBE_TIMEOUT_MS);
      outputs.set(probe.name, result);
      // DQ-27 short-circuit: no work tree here, so the remaining probes
      // would only produce git's "not a repository" noise.
      if (probe.name === 'insideWorkTree' && !isInsideWorkTree(result.stdout, result.code)) {
        return statusResult(
          `[OK] ${member.friendlyName}: ${folder} is not a git work tree (no checkout).`,
          { ...base, outcome: 'no_checkout', folder, checkout: null, error: null },
        );
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return statusResult(
      `[-] Git status probe failed on "${member.friendlyName}": ${error}`,
      { ...base, outcome: 'failed', folder, checkout: null, error },
    );
  }

  const checkout = buildCheckout(folder, outputs);
  return statusResult(summarise(member, checkout), {
    ...base, outcome: 'checkout', folder, checkout, error: null,
  });
}
