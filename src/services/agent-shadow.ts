/**
 * Project-level role-agent shadow check.
 *
 * agent-provisioner.ts keeps the member's USER-level agents dir
 * (~/.claude/agents, ...) hash-current with fleet's managed role set. The
 * provider CLI, however, gives the PROJECT-level dir (<workFolder>/.claude/agents)
 * precedence: a stale doer.md left in a member's checkout silently replaces the
 * role prompt fleet delivered, while the user-level dir still looks current.
 *
 * Before dispatch (and on register_member/update_member) this module lists the
 * project-level agents dir on the member, finds files that collide with a
 * managed role (same frontmatter `name:` -- the CLI's agent identity; the
 * basename is only a fallback when a file has no `name:`), and:
 *   - untracked (not in the git index, or the work folder is not a git repo):
 *     QUARANTINES them into <workFolder>/.claude/agents-shadowed-by-fleet/<stamp>/
 *     (outside the dir the CLI loads agents from; never deleted) with a
 *     `*` .gitignore so the moved files cannot be swept into a commit;
 *   - tracked: leaves them untouched and reports them loudly on every dispatch.
 *
 * The listing is recursive: the CLI discovers agent files in subdirectories of
 * the agents dir too, so a nested file with a colliding `name:` also shadows.
 *
 * Probe + quarantine are at most two member commands, built per OS/shell
 * (POSIX sh, or PowerShell delivered via -EncodedCommand). Nothing here ever
 * throws or blocks a dispatch: failures come back as a warning string.
 */
import os from 'node:os';
import path from 'node:path';
import type { Agent, LlmProvider } from '../types.js';
import { getStrategy } from './strategy.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../utils/agent-helpers.js';
import { logWarn } from '../utils/log-helpers.js';
import { escapeShellArg, escapePowerShellArg } from '../utils/shell-escape.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { getProvider } from '../providers/index.js';
import { loadCanonicalAgentSet, remoteAgentsDir } from './agent-provisioner.js';
import { getMemberHomeDir } from './member-home.js';

export const QUARANTINE_DIR_NAME = 'agents-shadowed-by-fleet';
const PROBE_TIMEOUT_MS = 20_000;
// Tab/LF as chars, not PowerShell backtick escapes (portability pre-commit hook).
const PS_TAB_LF = '$TAB = [string][char]9; $LF = [string][char]10';

export type GitState = 'repo' | 'norepo' | 'unknown';

export interface ProjectAgentEntry {
  /** Path relative to the project agents dir, '/'-separated. */
  relPath: string;
  tracked: boolean;
  /** Frontmatter `name:` value, '' when absent. */
  name: string;
}

export interface ProbeOutput {
  gitState: GitState;
  entries: ProjectAgentEntry[];
  /** Agents-dir path components that are symlinks/junctions (listing skipped). */
  links: string[];
}

export interface ManagedRoles {
  /** Lowercased basenames, e.g. "doer.md". */
  basenames: Set<string>;
  /** Lowercased frontmatter names, e.g. "doer". */
  names: Set<string>;
}

export interface ShadowClassification {
  /** Untracked shadows that may be quarantined. */
  untracked: ProjectAgentEntry[];
  /** Tracked shadows, or shadows whose git state could not be determined. Never touched. */
  tracked: ProjectAgentEntry[];
}

export interface ShadowCheckResult {
  status: 'clean' | 'shadowed' | 'skipped' | 'probe_failed';
  projectAgentsDir?: string;
  tracked: string[];
  quarantined: string[];
  /** Untracked shadows that could not be moved (move failed, or quarantine not safe). */
  notMoved: string[];
  quarantineDir?: string;
  skippedReason?: string;
  /** Warning for the current dispatch/registration (quarantine notice + tracked report + failures). */
  warning?: string;
  /** Portion of the warning that stays true until the operator acts (tracked/unmoved shadows). */
  persistentWarning?: string;
  /** True when a quarantine move failed: do not cache, retry on the next dispatch. */
  retry?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Frontmatter `name:` of a markdown agent file, '' when absent. */
export function frontmatterName(content: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm) return '';
  const m = /^name:[ \t]*(.*)$/m.exec(fm[1]);
  return m ? cleanName(m[1]) : '';
}

function cleanName(raw: string): string {
  return raw.replace(/\r/g, '').trim().replace(/^["']|["']$/g, '').trim();
}

/** Managed role set: the top-level .md files of the canonical agent set. */
export function managedRolesFrom(canonical: Array<{ relPath: string; content: string }>): ManagedRoles {
  const basenames = new Set<string>();
  const names = new Set<string>();
  for (const f of canonical) {
    if (f.relPath.includes('/') || !f.relPath.toLowerCase().endsWith('.md')) continue;
    basenames.add(f.relPath.toLowerCase());
    names.add((frontmatterName(f.content) || f.relPath.replace(/\.md$/i, '')).toLowerCase());
  }
  return { basenames, names };
}

/** Project-relative agents dir for a provider, or null when the provider has no managed set. */
export function projectAgentsDirRelative(provider: LlmProvider): string | null {
  if (remoteAgentsDir(provider) === null) return null;
  const project = getProvider(provider).agentDirectories('__probe__').project.replace(/\\/g, '/');
  return path.posix.dirname(project);
}

/** Join member-side path segments with the member's native separator. */
export function memberJoin(windowsNative: boolean, ...parts: string[]): string {
  const sep = windowsNative ? '\\' : '/';
  const cleaned = parts
    .map((p, i) => {
      let s = p.replace(/[\\/]+/g, sep);
      if (i > 0) s = s.replace(/^[\\/]+/, '');
      if (i < parts.length - 1) s = s.replace(/[\\/]+$/, '');
      return s;
    })
    .filter(s => s.length > 0);
  return cleaned.join(sep);
}

/** Build the one-round-trip listing command for the member's OS/shell. */
//
// Git state: 'repo' only when git ran and confirmed a work tree; 'norepo' only
// when git ran and said "not a git repository", or when no git ran/answered
// and no ancestor of the work folder has a .git entry. Anything else
// (git missing inside a repo, dubious-ownership refusal, ...) is 'unknown',
// which classifyShadows treats as tracked (report only, never move).
//
// `linkPaths`: the work-folder-relative prefixes of the agents dir (e.g.
// .claude, .claude/agents). If any is a symlink/junction the listing is
// skipped (FLEETSHADOW_LINK) -- it may point at the managed user-level dir.
export function buildShadowProbeCommand(posix: boolean, agentsDir: string, workFolder: string, linkPaths: string[] = [agentsDir]): string {
  if (posix) {
    return [
      `d=${escapeShellArg(agentsDir)}; w=${escapeShellArg(workFolder)}`,
      'g=unknown',
      'if command -v git >/dev/null 2>&1; then',
      '  o=$(LC_ALL=C git -C "$w" rev-parse --is-inside-work-tree 2>&1); rc=$?',
      '  if [ "$rc" -eq 0 ] && [ "$o" = true ]; then g=repo',
      "  elif printf '%s' \"$o\" | grep -qi 'not a git repository'; then g=norepo; fi",
      'fi',
      'if [ "$g" = unknown ]; then',
      '  p="$w"; found=0',
      '  while :; do if [ -e "$p/.git" ]; then found=1; break; fi; q=$(dirname -- "$p"); [ "$q" = "$p" ] && break; p="$q"; done',
      '  [ "$found" = 0 ] && g=norepo',
      'fi',
      "printf 'FLEETSHADOW_GIT\\t%s\\n' \"$g\"",
      'lnk=0',
      ...linkPaths.map(lp => `if [ -L ${escapeShellArg(lp)} ]; then lnk=1; printf 'FLEETSHADOW_LINK\\t%s\\n' ${escapeShellArg(lp)}; fi`),
      'if [ "$lnk" = 0 ] && [ -d "$d" ]; then',
      // -P: never follow symlinks (a linked subdir could lead into the managed user-level dir).
      "  find -P \"$d\" -type f -name '*.md' 2>/dev/null | while IFS= read -r f; do",
      // `name:` only inside the leading --- frontmatter block.
      "    n=$(awk 'NR>40{exit} NR==1{if ($0 !~ /^---[ \\t\\r]*$/) exit; next} /^---[ \\t\\r]*$/{exit} /^name:/{sub(/^name:[ \\t]*/,\"\"); print; exit}' \"$f\" 2>/dev/null)",
      '    t=U',
      '    if [ "$g" = repo ] && git -C "$w" ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then t=T; fi',
      "    printf 'FLEETSHADOW\\t%s\\t%s\\t%s\\n' \"$t\" \"${f#\"$d\"/}\" \"$n\"",
      '  done',
      'fi',
      "printf 'FLEETSHADOW_DONE\\n'",
    ].join('\n');
  }
  const ps = [
    "$ErrorActionPreference = 'Continue'",
    PS_TAB_LF,
    `$d = ${escapePowerShellArg(agentsDir)}; $w = ${escapePowerShellArg(workFolder)}`,
    "$g = 'unknown'",
    'if (Get-Command git -ErrorAction SilentlyContinue) {',
    "  $env:LC_ALL = 'C'",
    '  $o = (& git -C $w rev-parse --is-inside-work-tree 2>&1 | Out-String)',
    "  if ($LASTEXITCODE -eq 0 -and $o.Trim() -eq 'true') { $g = 'repo' } elseif ($o -match 'not a git repository') { $g = 'norepo' }",
    '}',
    "if ($g -eq 'unknown') {",
    '  $p = $w; $found = $false',
    "  while ($p) { if (Test-Path -LiteralPath (Join-Path $p '.git')) { $found = $true; break }; $parent = Split-Path -Parent $p; if (-not $parent -or $parent -eq $p) { break }; $p = $parent }",
    "  if (-not $found) { $g = 'norepo' }",
    '}',
    "[Console]::Out.Write('FLEETSHADOW_GIT' + $TAB + $g + $LF)",
    '$lnk = $false',
    ...linkPaths.map(lp => `$i = Get-Item -LiteralPath ${escapePowerShellArg(lp)} -Force -ErrorAction SilentlyContinue; if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $lnk = $true; [Console]::Out.Write('FLEETSHADOW_LINK' + $TAB + ${escapePowerShellArg(lp)} + $LF) }`),
    'if (-not $lnk -and (Test-Path -LiteralPath $d -PathType Container)) {',
    "  $root = (Get-Item -LiteralPath $d).FullName.TrimEnd('\\', '/')",
    // Manual walk: Get-ChildItem -Recurse descends into nested junctions/symlinked
    // dirs, which could lead into the managed user-level dir. Skip reparse-point dirs.
    '  $mds = New-Object System.Collections.ArrayList; $stack = New-Object System.Collections.Stack; $stack.Push($d)',
    '  while ($stack.Count -gt 0) {',
    '    $cur = $stack.Pop()',
    "    foreach ($c in @(Get-ChildItem -LiteralPath $cur -ErrorAction SilentlyContinue)) {",
    "      if ($c.PSIsContainer) { if (-not ($c.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $stack.Push($c.FullName) } }",
    "      elseif ($c.Name -like '*.md') { [void]$mds.Add($c) }",
    '    }',
    '  }',
    '  $mds | ForEach-Object {',
    '    $f = $_.FullName',
    "    $rel = $f.Substring($root.Length).TrimStart('\\', '/') -replace '\\\\', '/'",
    "    $n = ''",
    // `name:` only inside the leading --- frontmatter block.
    "    $ls = @(Get-Content -LiteralPath $f -TotalCount 40 -ErrorAction SilentlyContinue)",
    "    if ($ls.Count -gt 0 -and $ls[0] -match '^---\\s*$') { for ($k = 1; $k -lt $ls.Count; $k++) { if ($ls[$k] -match '^---\\s*$') { break }; if ($ls[$k] -match '^name:\\s*(.*)$') { $n = $Matches[1]; break } } }",
    "    $t = 'U'",
    "    if ($g -eq 'repo') { & git -C $w ls-files --error-unmatch -- $f *> $null; if ($LASTEXITCODE -eq 0) { $t = 'T' } }",
    "    [Console]::Out.Write('FLEETSHADOW' + $TAB + $t + $TAB + $rel + $TAB + $n + $LF)",
    '  }',
    '}',
    '$global:LASTEXITCODE = 0',
    "[Console]::Out.Write('FLEETSHADOW_DONE' + $LF)",
  ].join('\n');
  return wrapPowerShellEncoded(ps);
}

/** Parse the probe's stdout. Returns null when the output is not a complete probe transcript. */
export function parseShadowProbeOutput(stdout: string): ProbeOutput | null {
  let gitState: GitState | null = null;
  let done = false;
  const entries: ProjectAgentEntry[] = [];
  const links: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === 'FLEETSHADOW_DONE') { done = true; continue; }
    const parts = line.split('\t');
    if (parts[0] === 'FLEETSHADOW_LINK' && parts.length >= 2) { links.push(parts[1]); continue; }
    if (parts[0] === 'FLEETSHADOW_GIT' && parts.length >= 2) {
      const g = parts[1].trim();
      gitState = g === 'repo' || g === 'norepo' ? g : 'unknown';
      continue;
    }
    if (parts[0] === 'FLEETSHADOW' && parts.length >= 3) {
      const relPath = parts[2].replace(/\\/g, '/').replace(/^\.\//, '');
      if (!isSafeRelPath(relPath)) continue;
      entries.push({ relPath, tracked: parts[1] === 'T', name: cleanName(parts.slice(3).join('\t')) });
    }
  }
  if (!done || gitState === null) return null;
  return { gitState, entries, links };
}

function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split('/').some(seg => seg === '..' || seg === '');
}

/**
 * A file shadows a managed role when its frontmatter `name:` equals a managed
 * role name: the CLI identifies subagents by that name, not by filename, so
 * reviewer.md with `name: code-reviewer` shadows nothing. Only a file with no
 * `name:` falls back to its basename. Case-insensitive.
 * An 'unknown' git state (e.g. git failed inside a real repo) is treated as
 * tracked -- never move a file we cannot prove is untracked.
 */
export function classifyShadows(probe: ProbeOutput, roles: ManagedRoles): ShadowClassification {
  const untracked: ProjectAgentEntry[] = [];
  const tracked: ProjectAgentEntry[] = [];
  for (const e of probe.entries) {
    const base = e.relPath.split('/').pop()!.toLowerCase();
    const collides = e.name ? roles.names.has(e.name.toLowerCase()) : roles.basenames.has(base);
    if (!collides) continue;
    if (e.tracked || probe.gitState === 'unknown') tracked.push(e);
    else untracked.push(e);
  }
  return { untracked, tracked };
}

/** Build the quarantine command: moves each file under quarantineDir, preserving its relative path. */
export function buildQuarantineCommand(
  posix: boolean,
  windowsNative: boolean,
  agentsDir: string,
  quarantineRoot: string,
  quarantineDir: string,
  relPaths: string[],
): string {
  const j = (...p: string[]) => memberJoin(windowsNative, ...p);
  if (posix) {
    const q = escapeShellArg;
    const lines = [
      `mkdir -p ${q(quarantineDir)} && printf '*\\n' > ${q(j(quarantineRoot, '.gitignore'))}`,
      ...relPaths.map(rel => {
        const dstDir = path.posix.dirname(rel) === '.' ? quarantineDir : j(quarantineDir, path.posix.dirname(rel));
        const src = q(j(agentsDir, rel));
        const dst = q(j(quarantineDir, rel));
        // Reported per file; MOVED only when the source is gone and the copy landed.
        return `if mkdir -p ${q(dstDir)} && mv -f -- ${src} ${dst} && [ ! -e ${src} ] && [ -e ${dst} ]; then printf 'FLEETMOVED\\t%s\\n' ${q(rel)}; else printf 'FLEETMOVEFAIL\\t%s\\n' ${q(rel)}; fi`;
      }),
      "printf 'FLEETQUARANTINE_DONE\\n'",
    ];
    return lines.join('\n');
  }
  const q = escapePowerShellArg;
  const lines = [
    // Cmdlet errors are non-terminating by default; force them terminating so
    // the per-file catch sees them and a failed move is never reported MOVED.
    "$ErrorActionPreference = 'Stop'",
    PS_TAB_LF,
    `try { New-Item -ItemType Directory -Force -Path ${q(quarantineDir)} -ErrorAction Stop | Out-Null; Set-Content -LiteralPath ${q(j(quarantineRoot, '.gitignore'))} -Value '*' -ErrorAction Stop } catch { }`,
    ...relPaths.map(rel => {
      const dstDir = path.posix.dirname(rel) === '.' ? quarantineDir : j(quarantineDir, path.posix.dirname(rel));
      const src = q(j(agentsDir, rel));
      const dst = q(j(quarantineDir, rel));
      return `try { New-Item -ItemType Directory -Force -Path ${q(dstDir)} -ErrorAction Stop | Out-Null; Move-Item -LiteralPath ${src} -Destination ${dst} -Force -ErrorAction Stop; if ((Test-Path -LiteralPath ${src}) -or -not (Test-Path -LiteralPath ${dst})) { throw 'move not verified' }; [Console]::Out.Write('FLEETMOVED' + $TAB + ${q(rel)} + $LF) } catch { [Console]::Out.Write('FLEETMOVEFAIL' + $TAB + ${q(rel)} + $LF) }`;
    }),
    "[Console]::Out.Write('FLEETQUARANTINE_DONE' + $LF)",
  ];
  return wrapPowerShellEncoded(lines.join('\n'));
}

export function parseQuarantineOutput(stdout: string): { moved: string[]; failed: string[] } {
  const moved: string[] = [];
  const failed: string[] = [];
  for (const raw of stdout.split('\n')) {
    const [tag, rel] = raw.replace(/\r$/, '').split('\t');
    if (tag === 'FLEETMOVED' && rel) moved.push(rel);
    else if (tag === 'FLEETMOVEFAIL' && rel) failed.push(rel);
  }
  return { moved, failed };
}

function describeFiles(entries: ProjectAgentEntry[] | string[]): string {
  return entries
    .map(e => (typeof e === 'string' ? e : e.name ? `${e.relPath} (name: ${e.name})` : e.relPath))
    .join(', ');
}

function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Member-facing check
// ---------------------------------------------------------------------------

function resolveWorkFolder(agent: Agent): string {
  const wf = agent.workFolder;
  if (agent.agentType === 'local' && (wf === '~' || wf.startsWith('~/'))) return wf.replace('~', os.homedir());
  return wf;
}

function isAbsoluteMemberPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]/.test(p);
}

/**
 * Probe the member's project-level agents dir and quarantine/report shadows.
 * Uncached. Never throws: a failed member command yields status 'probe_failed'
 * with a warning; an unexpected internal error is rethrown only to the cached
 * wrapper, which logs it (callers of this function get a warning instead).
 */
export async function checkProjectAgentShadows(agent: Agent, now: Date = new Date()): Promise<ShadowCheckResult> {
  const base: ShadowCheckResult = { status: 'skipped', tracked: [], quarantined: [], notMoved: [] };
  const provider = agent.llmProvider ?? 'claude';
  const relDir = projectAgentsDirRelative(provider);
  if (!relDir) return { ...base, skippedReason: `${provider} does not use role-agent files` };

  const workFolder = resolveWorkFolder(agent);
  if (!workFolder || !isAbsoluteMemberPath(workFolder)) {
    return { ...base, skippedReason: 'work folder is not an absolute path' };
  }

  const targetOs = getAgentOS(agent);
  const posix = isPosixShell(targetOs, getAgentShell(agent));
  const windowsNative = targetOs === 'windows' && !posix;
  const wf = windowsNative ? workFolder.replace(/\//g, '\\') : workFolder.replace(/\\/g, '/');
  const agentsDir = memberJoin(windowsNative, wf, relDir);
  const where = `${wf.replace(/\\/g, '/')}/${relDir}`;

  const roles = managedRolesFrom(loadCanonicalAgentSet(provider));

  // Guard: when the work folder IS the member's home dir, the project-level dir
  // is the user-level dir fleet itself provisions -- nothing there is a shadow.
  const homeRel = remoteAgentsDir(provider);
  const home = await getMemberHomeDir(agent);
  if (home && homeRel && samePath(memberJoin(windowsNative, home, homeRel), agentsDir, targetOs !== 'linux')) {
    return { ...base, skippedReason: 'project agents dir is the user-level agents dir' };
  }

  const strategy = getStrategy(agent);

  let probe: ProbeOutput | null = null;
  let failDetail = '';
  try {
    // Every prefix of the agents dir under the work folder (.claude, .claude/agents).
    const segs = relDir.split('/');
    const linkPaths = segs.map((_, i) => memberJoin(windowsNative, wf, segs.slice(0, i + 1).join('/')));
    const r = await strategy.execCommand(buildShadowProbeCommand(posix, agentsDir, wf, linkPaths), PROBE_TIMEOUT_MS);
    if (r.code !== 0) failDetail = `exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`;
    else {
      probe = parseShadowProbeOutput(r.stdout);
      if (!probe) failDetail = 'unparseable probe output';
    }
  } catch (err: any) {
    failDetail = err?.message ?? String(err);
  }
  if (!probe) {
    const warning = `Could not check ${where} on "${agent.friendlyName}" for project-level agent files that would shadow fleet's managed role prompts (${failDetail}). Dispatch continues; if stale role files exist there they override the delivered prompts.`;
    return { ...base, status: 'probe_failed', projectAgentsDir: where, warning };
  }

  if (probe.links.length > 0) {
    // A linked agents dir may resolve to the managed user-level dir; moving
    // anything through it could strip the delivered role set. Skip, and say so.
    const warning = `Skipped the project-level agent shadow check on "${agent.friendlyName}": ${probe.links.join(', ')} is a symlink/junction, so fleet did not inspect or move anything in ${where}. If it points at stale role files they override the delivered prompts.`;
    return { ...base, projectAgentsDir: where, skippedReason: 'agents dir is a symlink/junction', warning };
  }

  const cls = classifyShadows(probe, roles);
  const result: ShadowCheckResult = { ...base, status: 'clean', projectAgentsDir: where, tracked: cls.tracked.map(e => e.relPath) };
  const persistent: string[] = [];
  const oneShot: string[] = [];

  // Unknown home: the "shadows" may be fleet's own user-level files (work
  // folder == home). Never cache such a result; retry once the home resolves.
  if (home === null && (cls.untracked.length > 0 || cls.tracked.length > 0)) result.retry = true;
  if (cls.untracked.length > 0 && home === null) {
    // Without the member's home we cannot rule out that this dir IS the
    // user-level managed dir -- report only, never move.
    result.notMoved = cls.untracked.map(e => e.relPath);
    persistent.push(`Untracked project-level agent file(s) on "${agent.friendlyName}" shadow fleet's managed role prompts but were not quarantined (member home dir could not be verified): ${describeFiles(cls.untracked)} in ${where}. The member's CLI loads these instead of the delivered role prompts -- remove them.`);
  } else if (cls.untracked.length > 0) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const qRootRel = path.posix.join(path.posix.dirname(relDir), QUARANTINE_DIR_NAME);
    const quarantineRoot = memberJoin(windowsNative, wf, qRootRel);
    const quarantineDir = memberJoin(windowsNative, quarantineRoot, stamp);
    const qWhere = `${wf.replace(/\\/g, '/')}/${qRootRel}/${stamp}`;
    const rels = cls.untracked.map(e => e.relPath);
    let moved: string[] = [];
    let failed: string[] = rels;
    let moveErr = '';
    try {
      const r = await strategy.execCommand(
        buildQuarantineCommand(posix, windowsNative, agentsDir, quarantineRoot, quarantineDir, rels),
        PROBE_TIMEOUT_MS,
      );
      const parsed = parseQuarantineOutput(r.stdout);
      moved = parsed.moved.filter(m => rels.includes(m));
      failed = rels.filter(rel => !moved.includes(rel));
      if (failed.length > 0 && r.code !== 0) moveErr = ` (exit ${r.code})`;
    } catch (err: any) {
      moveErr = ` (${err?.message ?? String(err)})`;
    }
    result.quarantined = moved;
    result.notMoved = failed;
    if (failed.length > 0) result.retry = true;
    if (moved.length > 0) {
      result.quarantineDir = qWhere;
      oneShot.push(`Quarantined ${moved.length} untracked project-level agent file(s) on "${agent.friendlyName}" that shadowed fleet's managed role prompts: moved ${describeFiles(moved)} from ${where} to ${qWhere}.`);
    }
    if (failed.length > 0) {
      persistent.push(`Could not quarantine untracked project-level agent file(s) on "${agent.friendlyName}" that shadow fleet's managed role prompts${moveErr}: ${describeFiles(failed)} in ${where}. The member's CLI loads these instead of the delivered role prompts -- remove them.`);
    }
  }

  if (cls.tracked.length > 0) {
    const why = probe.gitState === 'unknown' ? 'could not be verified as untracked (git state unknown)' : 'are tracked in git';
    persistent.push(`Project-level agent file(s) on "${agent.friendlyName}" shadow fleet's managed role prompts and ${why}, so fleet left them in place: ${describeFiles(cls.tracked)} in ${where}. The member's CLI loads these INSTEAD of the role prompts fleet delivers, because their frontmatter name: matches a managed role (renaming the file does not help) -- remove them from the repo or change their name: to one fleet does not manage.`);
  }

  if (cls.untracked.length > 0 || cls.tracked.length > 0) result.status = 'shadowed';
  const all = [...oneShot, ...persistent];
  if (all.length > 0) result.warning = all.join(' ');
  if (persistent.length > 0) result.persistentWarning = persistent.join(' ');
  return result;
}

// ---------------------------------------------------------------------------
// Per-uptime cache (per member + work folder)
// ---------------------------------------------------------------------------

/** key -> persistent warning to re-emit on every dispatch ('' when clean). */
// Known limitation: a 'clean' entry is not invalidated when the member's
// checkout changes mid-uptime (e.g. a branch switch that adds a tracked
// .claude/agents/doer.md). Tracked shadows are report-only anyway; the next
// register_member/update_member or server restart re-checks.
export const shadowCheckCache = new Map<string, string>();

function cacheKey(agent: Agent): string {
  return `${agent.id}\u0000${agent.workFolder}`;
}

/** Drop cached results for a member (all work folders). Called by register_member/update_member. */
export function invalidateProjectAgentShadowCache(agentId: string): void {
  const prefix = `${agentId}\u0000`;
  for (const k of [...shadowCheckCache.keys()]) if (k.startsWith(prefix)) shadowCheckCache.delete(k);
}

/**
 * Dispatch-time entry point. Runs the check once per member+workFolder per
 * server uptime; tracked/unmovable shadows are re-reported on every dispatch
 * from the cache (no extra round trip). A probe failure is not cached, so the
 * next dispatch retries. Returns the warning text for this dispatch, if any.
 * Never throws.
 */
export async function ensureNoProjectAgentShadows(agent: Agent): Promise<string | undefined> {
  const key = cacheKey(agent);
  const cached = shadowCheckCache.get(key);
  if (cached !== undefined) return cached || undefined;
  try {
    const r = await checkProjectAgentShadows(agent);
    if (r.warning) logWarn('agent_shadow', r.warning, agent);
    if (r.status !== 'probe_failed' && !r.retry) shadowCheckCache.set(key, r.persistentWarning ?? '');
    return r.warning;
  } catch (err: any) {
    // Internal error (not a member-side probe failure): log, never block.
    logWarn('agent_shadow', `project-level agent shadow check errored for "${agent.friendlyName}": ${err?.message ?? String(err)}`, agent);
    return undefined;
  }
}

/** register_member/update_member entry point: invalidate, run uncached, return a warning if any. Never throws. */
export async function recheckProjectAgentShadows(agent: Agent): Promise<string | undefined> {
  invalidateProjectAgentShadowCache(agent.id);
  return ensureNoProjectAgentShadows(agent);
}
