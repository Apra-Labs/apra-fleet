/**
 * Resolve WHERE a member's LLM CLI binary lives, once per member, and store
 * the absolute path on the member record (apra-fleet-fqkr.1.1).
 *
 * Why: every CLI invocation used to run the bare command name (`claude ...`)
 * under the member's NON-interactive PATH. An install under a user prefix --
 * the npm global prefix, an nvm per-version bin dir, ~/.npm-global/bin -- is
 * only on the interactive PATH (the user's rc file adds it), so dispatch
 * failed with a raw shell "command not found" even though the CLI is
 * installed and works in the user's own terminal.
 *
 * Resolution is generic over providers: the binary name comes from
 * provider.cliCommand(''), so claude, agy, opencode, codex and copilot all
 * resolve the same way; the 'none' provider has no CLI and resolves to
 * nothing (callers keep their existing no-LLM handling).
 *
 * Probe commands are built for the MEMBER's own OS/shell (isPosixShell /
 * getAgentOS / getAgentShell), never the orchestrator's os.platform(), and
 * never rely on shell-variable expansion of $HOME / %USERPROFILE%: the home
 * directory is resolved in JS first (getMemberHomeDir) and embedded as a
 * quoted literal. PowerShell probes go through wrapPowerShellEncoded.
 *
 * Probe order -- POSIX (bash, zsh, a gitbash Windows member):
 *   1. default-path -- `command -v <bin>` in the member's own non-login shell
 *                      (the PATH a bare-name invocation would use; works on
 *                      members without bash, e.g. busybox/Alpine images)
 *   2. login-shell  -- `bash -lc 'command -v <bin>'` (the user's login PATH)
 *   3. npm-prefix   -- `<npm prefix -g>/bin/<bin>`
 *   4. nvm          -- `<home>/.nvm/versions/node/<v>/bin/<bin>` (highest version)
 *   5. local-bin    -- `<home>/.local/bin/<bin>`
 *   6. npm-global   -- `<home>/.npm-global/bin/<bin>`
 * PowerShell (Windows member without gitbash):
 *   1. get-command  -- `Get-Command <bin> -CommandType Application`
 *   2. npm-prefix   -- `<npm prefix -g>\<bin>.cmd|.exe`, else `<home>\AppData\Roaming\npm\<bin>.cmd|.exe`
 *   3. local-bin    -- `<home>\.local\bin\<bin>.exe|.cmd`
 *
 * The resolved path is persisted as `agent.llmCli` (keyed by provider, so a
 * provider switch never reuses another provider's binary). A stored path is
 * reused WITHOUT re-probing; it is existence-checked once per process per
 * member (one cheap test, not a full resolution), and a stored path that no
 * longer exists triggers a full re-resolution. invalidateLlmCliPath() drops
 * the stored path (e.g. after the CLI was reinstalled or a dispatch hit exit
 * 127) so the next use re-resolves.
 *
 * A probe whose exec THROWS (connection drop, timeout) is a transport
 * failure, not "not present": resolution stops and reports reason
 * 'probe_failed', and a stored path is never cleared on that basis. Only a
 * clean result (an exit code, any code) counts as absent.
 */
import type { Agent, LlmCliLocationKind, ResolvedLlmCli } from '../types.js';
import type { ProviderAdapter, TargetOS } from '../providers/provider.js';
import type { MemberShell } from '../os/os-commands.js';
import { getStrategy } from './strategy.js';
import { getMemberHomeDir } from './member-home.js';
import { updateAgent } from './registry.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../utils/agent-helpers.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { escapeShellArg, escapePowerShellArgInner } from '../utils/shell-escape.js';
import { logWarn } from '../utils/log-helpers.js';

export type { LlmCliLocationKind, ResolvedLlmCli };

/** One location the resolver looked at, for the not-found report. */
export interface ProbedLocation {
  kind: LlmCliLocationKind;
  /** Human-readable location, e.g. `/home/u/.local/bin/claude` or `login shell (bash -lc 'command -v claude')`. */
  location: string;
}

export interface LlmCliNotFound {
  provider: string;
  binary: string;
  probed: ProbedLocation[];
  /** One-line remediation. */
  fix: string;
}

/** A probe exec that could not complete (threw / timed out) -- the member's state is unknown. */
export interface LlmCliProbeFailed {
  provider: string;
  binary: string;
  /** The probe step whose exec failed. */
  step: LlmCliLocationKind | 'verify';
  error: string;
  /** Locations probed before (and including) the failed step. */
  probed: ProbedLocation[];
}

export type LlmCliResolution =
  | { ok: true; path: string; source: LlmCliLocationKind; probed: ProbedLocation[] }
  | { ok: false; reason: 'not_found'; notFound: LlmCliNotFound }
  | { ok: false; reason: 'probe_failed'; probeFailed: LlmCliProbeFailed };

/** Exec seam: production uses the member strategy; tests pass a fake. The
 *  `kind` argument names the probe step so a fake can answer by step. */
export type CliProbeExec = (cmd: string, kind: LlmCliLocationKind | 'verify') => Promise<{ code: number; stdout: string; stderr?: string }>;

export interface ResolveLlmCliInput {
  /** Bare binary name, e.g. 'claude'. */
  binary: string;
  provider: string;
  os: TargetOS;
  shell?: MemberShell;
  /** Member home dir resolved in JS, or null when unknown (home-based candidates are then skipped). */
  homeDir: string | null;
  exec: CliProbeExec;
  /** Install command for the fix line (optional). */
  installHint?: string;
}

const PROBE_TIMEOUT_MS = 20_000;

/** The provider's bare CLI binary name, or null for a provider without a CLI ('none'). */
export function cliBinaryName(provider: ProviderAdapter): string | null {
  if (provider.name === 'none') return null;
  try {
    const bin = provider.cliCommand('').trim();
    return bin.length > 0 && !/\s/.test(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Last non-empty line of probe output (login-shell / PowerShell banners come BEFORE the command's own output). */
function lastLine(stdout: string): string {
  return stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? '';
}

function isAbsolutePosix(p: string): boolean {
  return p.startsWith('/');
}

function isAbsoluteWindows(p: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\)/.test(p);
}

function joinPosix(...parts: string[]): string {
  return parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/');
}

function joinWindows(...parts: string[]): string {
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join('\\');
}

/** Compare two `vX.Y.Z` strings numerically. */
function compareNodeVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** POSIX: first existing executable among `candidates`, printed with no trailing newline. No shell variables. */
export function posixFirstExecutableCommand(candidates: string[]): string {
  const branches = candidates.map((c, i) => `${i === 0 ? 'if' : 'elif'} [ -x ${escapeShellArg(c)} ] && [ ! -d ${escapeShellArg(c)} ]; then printf '%s' ${escapeShellArg(c)}; `);
  return `${branches.join('')}fi`;
}

/** PowerShell: first existing file among `candidates` (encoded, so it is safe from any outer shell). */
export function powershellFirstFileCommand(candidates: string[]): string {
  const list = candidates.map(c => `'${escapePowerShellArgInner(c)}'`).join(',');
  return wrapPowerShellEncoded(`foreach ($fleetCliCandidate in @(${list})) { if (Test-Path -LiteralPath $fleetCliCandidate -PathType Leaf) { [Console]::Out.Write($fleetCliCandidate); break } }`);
}

/** Existence check for one stored path, built for the member's shell. */
export function verifyCliPathCommand(path: string, os: TargetOS, shell?: MemberShell): string {
  return isPosixShell(os, shell) ? posixFirstExecutableCommand([path]) : powershellFirstFileCommand([path]);
}

/** Thrown by probeExec when the exec itself failed (not a clean "absent" result). */
class ProbeExecError extends Error {
  constructor(readonly step: LlmCliLocationKind | 'verify', readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ProbeExecError';
  }
}

/**
 * Run one probe. A completed exec with a non-zero exit is a clean "absent"
 * (''); an exec that throws (connection drop, timeout) is rethrown as
 * ProbeExecError so callers never mistake a transport failure for absence.
 */
async function probeExec(exec: CliProbeExec, cmd: string, kind: LlmCliLocationKind | 'verify'): Promise<string> {
  let r: { code: number; stdout: string };
  try {
    r = await exec(cmd, kind);
  } catch (err) {
    throw new ProbeExecError(kind, err);
  }
  return r.code === 0 ? (r.stdout ?? '') : '';
}

function fixLine(binary: string, posix: boolean, installHint?: string): string {
  const link = posix
    ? `symlink the CLI into ~/.local/bin (ln -s "$(command -v ${binary})" ~/.local/bin/${binary}, run in a terminal where ${binary} works)`
    : `copy or link ${binary}.exe/.cmd into %USERPROFILE%\\.local\\bin`;
  return `Fix: ${link}, or reinstall it${installHint ? ` (${installHint})` : ''} -- e.g. update_llm_cli with install_if_missing: true.`;
}

/**
 * Pure resolution over an exec seam. Never throws; returns the first
 * location found, a structured not-found listing every probed location, or
 * (when a probe exec itself failed) a probe_failed result.
 */
export async function resolveLlmCli(input: ResolveLlmCliInput): Promise<LlmCliResolution> {
  const probed: ProbedLocation[] = [];
  try {
    return await resolveProbes(input, probed);
  } catch (err) {
    const step = err instanceof ProbeExecError ? err.step : 'verify';
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'probe_failed', probeFailed: { provider: input.provider, binary: input.binary, step, error, probed } };
  }
}

async function resolveProbes(input: ResolveLlmCliInput, probed: ProbedLocation[]): Promise<LlmCliResolution> {
  const { binary, os, shell, homeDir, exec } = input;
  const posix = isPosixShell(os, shell);
  const found = (path: string, source: LlmCliLocationKind): LlmCliResolution => ({ ok: true, path, source, probed });
  const notFound = (): LlmCliResolution => ({ ok: false, reason: 'not_found', notFound: { provider: input.provider, binary, probed, fix: fixLine(binary, posix, input.installHint) } });

  if (posix) {
    // 1. default PATH: the member's own non-login shell -- exactly what a
    // bare-name invocation would run. `command -v` is POSIX (sh, dash,
    // busybox ash, bash, zsh), so this works on a member without bash.
    probed.push({ kind: 'default-path', location: `default PATH (command -v ${binary})` });
    const onPath = lastLine(await probeExec(exec, `command -v ${escapeShellArg(binary)} 2>/dev/null`, 'default-path'));
    if (isAbsolutePosix(onPath)) return found(onPath, 'default-path');

    // 2. login shell
    const loginCmd = `bash -lc ${escapeShellArg(`command -v ${binary}`)} 2>/dev/null`;
    probed.push({ kind: 'login-shell', location: `login shell (bash -lc 'command -v ${binary}')` });
    const login = lastLine(await probeExec(exec, loginCmd, 'login-shell'));
    if (isAbsolutePosix(login)) return found(login, 'login-shell');

    // 3. npm global prefix
    const prefix = lastLine(await probeExec(exec, `bash -lc ${escapeShellArg('npm prefix -g')} 2>/dev/null`, 'npm-prefix'));
    if (isAbsolutePosix(prefix)) {
      const cand = joinPosix(prefix, 'bin', binary);
      probed.push({ kind: 'npm-prefix', location: cand });
      const hit = lastLine(await probeExec(exec, posixFirstExecutableCommand([cand]), 'npm-prefix'));
      if (hit === cand) return found(cand, 'npm-prefix');
    } else {
      probed.push({ kind: 'npm-prefix', location: 'npm global prefix bin (npm prefix -g: npm not found)' });
    }

    if (!homeDir) {
      probed.push({ kind: 'nvm', location: '~/.nvm/versions/node/*/bin (skipped: member home directory unknown)' });
      probed.push({ kind: 'local-bin', location: '~/.local/bin (skipped: member home directory unknown)' });
      probed.push({ kind: 'npm-global', location: '~/.npm-global/bin (skipped: member home directory unknown)' });
      return notFound();
    }

    // 4. nvm per-version bin dirs (highest node version first)
    const nvmRoot = joinPosix(homeDir, '.nvm', 'versions', 'node');
    probed.push({ kind: 'nvm', location: `${nvmRoot}/*/bin/${binary}` });
    // A glob, not a shell variable: the home dir is already a JS-resolved literal.
    const nvmCmd = `ls -1d ${escapeShellArg(nvmRoot)}/*/bin/${escapeShellArg(binary)} 2>/dev/null; true`;
    const nvmHits = (await probeExec(exec, nvmCmd, 'nvm'))
      .split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith(nvmRoot + '/'));
    if (nvmHits.length > 0) {
      const versionOf = (p: string) => p.slice(nvmRoot.length + 1).split('/')[0];
      nvmHits.sort((a, b) => compareNodeVersions(versionOf(b), versionOf(a)));
      return found(nvmHits[0], 'nvm');
    }

    // 5./6. fixed user prefixes
    for (const [kind, dir] of [['local-bin', joinPosix(homeDir, '.local', 'bin')], ['npm-global', joinPosix(homeDir, '.npm-global', 'bin')]] as const) {
      const cand = joinPosix(dir, binary);
      probed.push({ kind, location: cand });
      const hit = lastLine(await probeExec(exec, posixFirstExecutableCommand([cand]), kind));
      if (hit === cand) return found(cand, kind);
    }
    return notFound();
  }

  // PowerShell
  const getCmd = wrapPowerShellEncoded(`$fleetCli = Get-Command '${escapePowerShellArgInner(binary)}' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($fleetCli) { [Console]::Out.Write($fleetCli.Source) }`);
  probed.push({ kind: 'get-command', location: `Get-Command ${binary}` });
  const got = lastLine(await probeExec(exec, getCmd, 'get-command'));
  if (isAbsoluteWindows(got)) return found(got, 'get-command');

  const shimNames = [`${binary}.cmd`, `${binary}.exe`];
  const prefix = lastLine(await probeExec(exec, wrapPowerShellEncoded('try { $fleetNpm = (& npm prefix -g 2>$null | Select-Object -Last 1) } catch { $fleetNpm = $null }; if ($fleetNpm) { [Console]::Out.Write($fleetNpm) }'), 'npm-prefix'));
  const npmDirs: string[] = [];
  if (isAbsoluteWindows(prefix)) npmDirs.push(prefix);
  if (homeDir) {
    const appDataNpm = joinWindows(homeDir, 'AppData', 'Roaming', 'npm');
    if (!npmDirs.some(d => d.toLowerCase() === appDataNpm.toLowerCase())) npmDirs.push(appDataNpm);
  }
  if (npmDirs.length > 0) {
    const cands = npmDirs.flatMap(d => shimNames.map(n => joinWindows(d, n)));
    probed.push({ kind: 'npm-prefix', location: cands.join(', ') });
    const hit = lastLine(await probeExec(exec, powershellFirstFileCommand(cands), 'npm-prefix'));
    if (cands.includes(hit)) return found(hit, 'npm-prefix');
  } else {
    probed.push({ kind: 'npm-prefix', location: 'npm global prefix (npm prefix -g: npm not found; home directory unknown)' });
  }

  if (homeDir) {
    const dir = joinWindows(homeDir, '.local', 'bin');
    const cands = [`${binary}.exe`, `${binary}.cmd`].map(n => joinWindows(dir, n));
    probed.push({ kind: 'local-bin', location: cands.join(', ') });
    const hit = lastLine(await probeExec(exec, powershellFirstFileCommand(cands), 'local-bin'));
    if (cands.includes(hit)) return found(hit, 'local-bin');
  } else {
    probed.push({ kind: 'local-bin', location: '%USERPROFILE%\\.local\\bin (skipped: member home directory unknown)' });
  }
  return notFound();
}

/** One-line-per-section human message for a not-found result. */
export function formatLlmCliNotFound(nf: LlmCliNotFound, memberName?: string): string {
  const who = memberName ? ` on member "${memberName}"` : '';
  const locs = nf.probed.map(p => `  - ${p.kind}: ${p.location}`).join('\n');
  return `${nf.provider} CLI "${nf.binary}" not found${who}. Probed locations:\n${locs}\n${nf.fix}`;
}

/** Human message for a probe whose exec failed (transport, not absence). */
export function formatLlmCliProbeFailed(pf: LlmCliProbeFailed, memberName?: string): string {
  const who = memberName ? ` on member "${memberName}"` : '';
  return `could not check where the ${pf.provider} CLI "${pf.binary}" is${who}: the ${pf.step} probe failed to run (${pf.error}). This is a connection/exec failure, not a missing CLI; the stored CLI path (if any) was kept. Check the member is reachable and retry.`;
}

/** Error carrying the structured not-found result, for callers that throw. */
export class LlmCliNotFoundError extends Error {
  readonly notFound: LlmCliNotFound;
  constructor(nf: LlmCliNotFound, memberName?: string) {
    super(formatLlmCliNotFound(nf, memberName));
    this.name = 'LlmCliNotFoundError';
    this.notFound = nf;
  }
}

/** memberId -> stored path already existence-checked by this process. */
const verifiedThisProcess = new Map<string, string>();
/** memberId -> in-flight ensure, so concurrent callers cause ONE resolution. */
const inFlight = new Map<string, Promise<EnsureLlmCliResult>>();

export type EnsureLlmCliResult =
  | { ok: true; path: string | undefined; source?: LlmCliLocationKind | 'stored'; reprobed: boolean }
  | { ok: false; reason: 'not_found'; notFound: LlmCliNotFound; message: string }
  /** A probe exec threw (connection drop, timeout): the CLI's presence is UNKNOWN, the stored path is kept. */
  | { ok: false; reason: 'probe_failed'; notFound?: undefined; probeFailed: LlmCliProbeFailed; message: string };

export interface EnsureLlmCliDeps {
  exec?: CliProbeExec;
  homeDir?: string | null;
  /** Persist seam; defaults to registry updateAgent. */
  persist?: (agentId: string, llmCli: ResolvedLlmCli | undefined) => void;
  now?: () => Date;
}

/** Drop a member's stored CLI path (and the per-process verification) so the next use re-resolves. */
export function invalidateLlmCliPath(agent: Agent, persist: EnsureLlmCliDeps['persist'] = defaultPersist): void {
  verifiedThisProcess.delete(agent.id);
  if (agent.llmCli) {
    agent.llmCli = undefined;
    try { persist(agent.id, undefined); } catch { /* registry write failure must not mask the caller's own error */ }
  }
}

/** Test-only: forget per-process verification state. */
export function _resetLlmCliResolverState(): void {
  verifiedThisProcess.clear();
  inFlight.clear();
}

function defaultPersist(agentId: string, llmCli: ResolvedLlmCli | undefined): void {
  updateAgent(agentId, { llmCli });
}

/**
 * The absolute CLI path to invoke for this member, resolving and persisting
 * it when none is stored, re-resolving when the stored path no longer
 * exists. `path: undefined` with ok:true means the provider has no CLI
 * ('none'). Never throws.
 */
export function ensureMemberLlmCli(agent: Agent, provider: ProviderAdapter, deps: EnsureLlmCliDeps = {}): Promise<EnsureLlmCliResult> {
  const existing = inFlight.get(agent.id);
  if (existing && !deps.exec) return existing;
  const p = doEnsure(agent, provider, deps).finally(() => inFlight.delete(agent.id));
  if (!deps.exec) inFlight.set(agent.id, p);
  return p;
}

async function doEnsure(agent: Agent, provider: ProviderAdapter, deps: EnsureLlmCliDeps): Promise<EnsureLlmCliResult> {
  const binary = cliBinaryName(provider);
  if (!binary) return { ok: true, path: undefined, reprobed: false };

  const os = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const persist = deps.persist ?? defaultPersist;
  const exec: CliProbeExec = deps.exec ?? ((cmd) => getStrategy(agent).execCommand(cmd, PROBE_TIMEOUT_MS));

  const stored = agent.llmCli;
  if (stored && stored.provider === provider.name && stored.path) {
    if (verifiedThisProcess.get(agent.id) === stored.path) {
      return { ok: true, path: stored.path, source: 'stored', reprobed: false };
    }
    let hit: string;
    try {
      hit = lastLine(await probeExec(exec, verifyCliPathCommand(stored.path, os, shell), 'verify'));
    } catch (err) {
      // Transport failure: the stored path's existence is unknown. Keep it
      // (never clear a good path because a connection dropped) and report.
      const probeFailed: LlmCliProbeFailed = {
        provider: provider.name, binary, step: 'verify',
        error: err instanceof Error ? err.message : String(err),
        probed: [{ kind: stored.source, location: `${stored.path} (stored)` }],
      };
      return { ok: false, reason: 'probe_failed', probeFailed, message: formatLlmCliProbeFailed(probeFailed, agent.friendlyName) };
    }
    if (hit === stored.path) {
      verifiedThisProcess.set(agent.id, stored.path);
      return { ok: true, path: stored.path, source: 'stored', reprobed: false };
    }
    logWarn('llm_cli_resolve', `stored ${provider.name} CLI path ${stored.path} for ${agent.friendlyName} no longer exists; re-resolving`);
  }

  let homeDir: string | null;
  if (deps.homeDir !== undefined) homeDir = deps.homeDir;
  else {
    try { homeDir = await getMemberHomeDir(agent); } catch { homeDir = null; }
  }

  let installHint: string | undefined;
  try { installHint = provider.installCommand(os, shell); } catch { installHint = undefined; }

  const res = await resolveLlmCli({ binary, provider: provider.name, os, shell, homeDir, exec, installHint });
  if (!res.ok && res.reason === 'probe_failed') {
    // Unknown, not absent: keep any stored path and do not mark it verified.
    return { ok: false, reason: 'probe_failed', probeFailed: res.probeFailed, message: formatLlmCliProbeFailed(res.probeFailed, agent.friendlyName) };
  }
  if (!res.ok) {
    verifiedThisProcess.delete(agent.id);
    if (stored) {
      agent.llmCli = undefined;
      try { persist(agent.id, undefined); } catch { /* best effort */ }
    }
    return { ok: false, reason: 'not_found', notFound: res.notFound, message: formatLlmCliNotFound(res.notFound, agent.friendlyName) };
  }

  const record: ResolvedLlmCli = {
    provider: provider.name,
    path: res.path,
    source: res.source,
    resolvedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  agent.llmCli = record;
  verifiedThisProcess.set(agent.id, res.path);
  try { persist(agent.id, record); } catch (err) {
    logWarn('llm_cli_resolve', `could not persist ${provider.name} CLI path for ${agent.friendlyName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, path: res.path, source: res.source, reprobed: true };
}
