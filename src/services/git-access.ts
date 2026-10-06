/**
 * Classify the output of OsCommands.gitRepoAccessProbe (apra-fleet-wgpx).
 *
 * The probe prints git's stderr only when `git rev-parse --git-dir` failed.
 *  - empty output            -> git is fine with the folder (a repo it can read)
 *  - "not a git repository"  -> no repo here yet: the supported "register before
 *                               clone" case, NOT an error
 *  - folder missing / git not installed -> not a git problem we can act on; ok
 *  - "dubious ownership" or any other git `fatal:` -> git REFUSES the folder
 *    from this context: dispatch's git operations would fail later, mid-sprint.
 */
export type GitProbeVerdict =
  | { ok: true }
  | { ok: false; reason: string; dubiousOwnership: boolean };

const BENIGN = [
  /not a git repository/i,
  /cannot change to/i,
  /no such file or directory/i,
  /cannot find the path/i,
  /is not recognized as/i,
  /command not found/i,
  /not found/i,
];

export function classifyGitProbeOutput(output: string | undefined | null): GitProbeVerdict {
  const text = String(output ?? '').trim();
  if (!text) return { ok: true };
  if (/dubious ownership/i.test(text)) {
    return { ok: false, reason: firstLine(text), dubiousOwnership: true };
  }
  if (BENIGN.some(re => re.test(text))) return { ok: true };
  if (/fatal:|error:/i.test(text)) {
    return { ok: false, reason: firstLine(text), dubiousOwnership: false };
  }
  return { ok: true };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? text;
}

/** Operator-facing explanation naming both remedies. */
export function gitRefusalGuidance(folder: string, verdict: Extract<GitProbeVerdict, { ok: false }>): string {
  return [
    `git refuses to operate on the work folder "${folder}" from this member's context: ${verdict.reason}`,
    verdict.dubiousOwnership
      ? 'This is git\'s "dubious ownership" protection: the folder is owned by a different user than the one the member runs as.'
      : 'Git reported an error inside this folder.',
    'Fix one of:',
    `  - take ownership of the folder: Windows "icacls \\"${folder}\\" /setowner <user> /T", POSIX "chown -R <user> \\"${folder}\\""`,
    `  - trust it explicitly: git config --global --add safe.directory "${folder}"`,
  ].join('\n');
}
