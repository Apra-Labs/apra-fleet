/**
 * Member apra-fleet install service (apra-fleet-b4g.56.1).
 *
 * register_member / update_member use this to make sure a REMOTE member runs
 * its own apra-fleet, at least as new as the orchestrator, installed in HTTP
 * member mode (`install --llm <provider> --member --workflows none --transport
 * http`). The flow is:
 *
 *   1. probe the member's own install for its version (`--version` on
 *      <member home>/.apra-fleet/bin/apra-fleet[.exe]);
 *   2. if it is missing or older than this orchestrator build, pick an install
 *      source:
 *        - member OS+arch == orchestrator OS+arch AND the orchestrator runs as
 *          a single-executable binary -> copy the orchestrator's own executable;
 *        - otherwise -> the tagged GitHub release asset for the orchestrator's
 *          version, when one exists for the member's platform;
 *        - otherwise -> a typed `unavailable(<reason>)` result. Absence is an
 *          OBSERVATION, never a throw: the caller's registration still succeeds;
 *   3. stage the installer under <member home>/.apra-fleet/staging and run it
 *      in member mode, then re-probe to confirm the installed version.
 *
 * The version probe is ported from closed PR 543 (branch
 * fix/fleet-status-cwd-independent), including its PowerShell $LASTEXITCODE
 * fix; that branch resolved a stdio launch descriptor, this one installs.
 *
 * Every member-bound command is built HERE in JavaScript for the member's
 * OS/shell (isPosixShell, wrapPowerShellEncoded). No command contains a shell
 * expansion token ($VAR, ~/, backticks): every path is resolved first from the
 * member's probed home directory (member-home.ts) and passed as a quoted
 * literal.
 *
 * Every transport (exec, file transfer, home probe, release download,
 * orchestrator platform/executable/version) is injected through
 * MemberFleetInstallDeps so tests drive the whole flow with a fake transport.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, LlmProvider, SSHExecResult } from '../types.js';
import type { TargetOS } from '../providers/provider.js';
import { getStrategy } from './strategy.js';
import { getMemberHomeDir } from './member-home.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../utils/agent-helpers.js';
import { escapePowerShellArgInner, escapeShellArgInner } from '../utils/shell-escape.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { serverVersion } from '../version.js';
import { parseVersion, isNewer } from './update-check.js';

type MemberShell = ReturnType<typeof getAgentShell>;

/** Emitted by the probe when the install path is not present/executable. */
export const NO_INSTALL_SENTINEL = '__APRA_FLEET_NO_INSTALL__';
/** Emitted by the probe when the path exists but running it failed. */
export const EXEC_FAILED_SENTINEL = '__APRA_FLEET_EXEC_FAILED__';

const PROBE_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** GitHub repo the tagged release assets are published to (.github/workflows/ci.yml). */
export const RELEASE_REPO = 'Apra-Labs/apra-fleet';

/** `apra-fleet --version` prints `apra-fleet <version>` on its FIRST line
 *  (src/index.ts), e.g. `apra-fleet v0.4.4` or `apra-fleet v0.4.4_abc123` for
 *  a dev build. Scanned line-by-line so a shell banner on either side is
 *  skipped. */
const VERSION_LINE_RE = /^apra-fleet\s+(v?\d+\.\d+\.\d+\S*)\s*$/;

/** Normalized CPU architecture names (Node's process.arch spelling). */
export type MemberArch = 'x64' | 'arm64' | string;

export interface MemberPlatform {
  os: TargetOS;
  arch: MemberArch;
}

/** Why a member could not be given an apra-fleet install. */
export type FleetInstallUnavailableReason =
  /** The member's home directory could not be resolved, so no path can be built. */
  | 'home-unresolved'
  /** The member could not be probed (transport error, non-zero shell exit). */
  | 'probe-failed'
  /** The member's CPU architecture could not be determined. */
  | 'arch-unknown'
  /** Different OS/arch than the orchestrator and no release asset exists for it. */
  | 'unsupported-platform'
  /** Same platform, but this orchestrator is not a single-executable binary to
   *  copy, and no release asset could be fetched either. */
  | 'no-install-source'
  /** Downloading the release asset failed. */
  | 'download-failed'
  /** Copying the installer onto the member failed. */
  | 'transfer-failed'
  /** The installer ran but exited non-zero. */
  | 'install-failed'
  /** After installing, the member still does not report a version >= the
   *  orchestrator's. */
  | 'install-unverified';

/** What the probe observed about the member's current install. */
export type MemberFleetProbe =
  | { kind: 'installed'; version: string; binPath: string }
  | { kind: 'missing'; binPath: string }
  | { kind: 'broken'; binPath: string; detail: string }
  | { kind: 'probe-failed'; detail: string };

export type InstallSource =
  | { kind: 'orchestrator-executable'; localPath: string }
  | { kind: 'release-asset'; assetName: string; url: string };

export type MemberFleetInstallResult =
  | {
      state: 'available';
      /** Version the member reports after this call. */
      version: string;
      /** True when this call ran an install; false when the existing install
       *  was already up to date. */
      installed: boolean;
      source?: InstallSource['kind'];
      binPath: string;
    }
  | {
      state: 'unavailable';
      reason: FleetInstallUnavailableReason;
      detail?: string;
      /** Version observed before any install attempt, if one was present. */
      version?: string;
    };

/** Injected transports. Production defaults come from defaultMemberFleetInstallDeps(). */
export interface MemberFleetInstallDeps {
  exec(agent: Agent, command: string, timeoutMs: number): Promise<SSHExecResult>;
  /** Copy local files into an ABSOLUTE member directory (file basename kept). */
  transfer(agent: Agent, localPaths: string[], destinationDir: string): Promise<{ success: string[]; failed: { path: string; error: string }[] }>;
  resolveHome(agent: Agent): Promise<string | null>;
  orchestratorPlatform(): MemberPlatform;
  /** Path of the orchestrator's own single-executable binary, or null when it
   *  does not run as one (npm/dev mode: there is nothing self-contained to copy). */
  orchestratorExecutable(): string | null;
  orchestratorVersion(): string;
  /** Download `url` to a local temp file named `assetName`; returns its path. Throws on failure. */
  downloadReleaseAsset(url: string, assetName: string): Promise<string>;
  /** Remove a local temp file created by downloadReleaseAsset. Best effort. */
  removeLocal(localPath: string): void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Executable name apra-fleet installs itself as on the member's OS. */
export function binaryNameFor(targetOs: TargetOS): string {
  return targetOs === 'windows' ? 'apra-fleet.exe' : 'apra-fleet';
}

/** Join path segments with the member's separator. A POSIX shell on Windows
 *  (gitbash) has a POSIX-style home (/c/Users/x) and takes '/'. */
export function memberJoin(targetOs: TargetOS, shell: MemberShell, ...parts: string[]): string {
  const sep = isPosixShell(targetOs, shell) ? '/' : '\\';
  const trimmed = parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')));
  return trimmed.filter(p => p.length > 0).join(sep);
}

/** Pick the POSIX or PowerShell form of a member-bound command. PowerShell is
 *  always delivered via -EncodedCommand so no intermediate shell re-tokenizes it. */
export function memberCommandFor(
  targetOs: TargetOS,
  shell: MemberShell,
  forms: { posix: string; powershell: string },
): string {
  return isPosixShell(targetOs, shell) ? forms.posix : wrapPowerShellEncoded(forms.powershell);
}

function posixQuote(s: string): string {
  return `'${escapeShellArgInner(s)}'`;
}

function psQuote(s: string): string {
  return `'${escapePowerShellArgInner(s)}'`;
}

/**
 * The member-side version probe, built from an already-resolved absolute path.
 *
 * Both branches exit 0 and TAG their outcome in stdout, so a non-zero exit
 * means "the shell/transport itself failed" and nothing else.
 *
 * POWERSHELL BRANCH -- DO NOT "SIMPLIFY" THE $LASTEXITCODE TEST OR THE TRAILING
 * `exit 0` (ported from PR 543). PowerShell raises NO terminating error when a
 * NATIVE executable exits non-zero, so a bare try/catch never reaches its catch
 * for a present-but-broken install: the probe would return partial stdout (which
 * may even look like a version) and wrapPowerShellEncoded would propagate the
 * leftover $LASTEXITCODE as the exit code. The explicit $LASTEXITCODE branch
 * reports such an install as EXEC_FAILED instead of reading its output as a
 * version; the catch still covers a path that cannot be launched at all.
 */
export function buildFleetVersionProbe(binPath: string, targetOs: TargetOS, shell: MemberShell): string {
  const p = posixQuote(binPath);
  const ps = psQuote(binPath);
  return memberCommandFor(targetOs, shell, {
    posix:
      `if [ -x ${p} ]; then ${p} --version 2>/dev/null || ` +
      `printf '%s\\n' '${EXEC_FAILED_SENTINEL}'; else printf '%s\\n' '${NO_INSTALL_SENTINEL}'; fi`,
    powershell:
      `if (Test-Path -LiteralPath ${ps}) { try { $out = & ${ps} --version; ` +
      `if ($LASTEXITCODE -ne 0) { [Console]::Out.Write('${EXEC_FAILED_SENTINEL}') } ` +
      `else { [Console]::Out.Write(($out | Out-String)) } } catch ` +
      `{ [Console]::Out.Write('${EXEC_FAILED_SENTINEL}') } } else ` +
      `{ [Console]::Out.Write('${NO_INSTALL_SENTINEL}') }; exit 0`,
  });
}

/** The member's CPU architecture, as one raw token on stdout. */
export function buildArchProbe(targetOs: TargetOS, shell: MemberShell): string {
  return memberCommandFor(targetOs, shell, {
    posix: 'uname -m',
    powershell: '[Console]::Out.Write($env:PROCESSOR_ARCHITECTURE)',
  });
}

/** Normalize uname -m / PROCESSOR_ARCHITECTURE output to Node's process.arch names. */
export function normalizeArch(raw: string): MemberArch | null {
  const token = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop()?.toLowerCase();
  if (!token) return null;
  if (token === 'x86_64' || token === 'amd64' || token === 'x64') return 'x64';
  if (token === 'aarch64' || token === 'arm64' || token === 'armv8') return 'arm64';
  return token;
}

/** First `apra-fleet <version>` line in the probe output, or null. */
export function parseFleetVersion(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const m = VERSION_LINE_RE.exec(raw.trim());
    if (m && parseVersion(m[1])) return m[1];
  }
  return null;
}

/** True when the member's version is older than the orchestrator's (semver
 *  core only; a dev build's _hash suffix is ignored). */
export function isOlderThan(memberVersion: string, orchestratorVersion: string): boolean {
  return isNewer(orchestratorVersion, memberVersion);
}

/** Release asset names published by .github/workflows/ci.yml, by platform. */
const RELEASE_ASSETS: Record<string, string> = {
  'linux/x64': 'apra-fleet-installer-linux-x64',
  'macos/arm64': 'apra-fleet-installer-darwin-arm64',
  'windows/x64': 'apra-fleet-installer-win-x64.exe',
};

export function releaseAssetNameFor(platform: MemberPlatform): string | null {
  return RELEASE_ASSETS[`${platform.os}/${platform.arch}`] ?? null;
}

/** `v0.4.4_abc123` -> `v0.4.4`: the release tag a build's version maps to. */
export function releaseTagFor(version: string): string {
  return `v${version.replace(/^v/, '').split('_')[0]}`;
}

export function releaseAssetUrl(version: string, assetName: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/${releaseTagFor(version)}/${assetName}`;
}

/**
 * Choose where the member's install comes from (pure; exported for tests).
 *   same OS+arch and a copyable orchestrator executable -> that executable;
 *   otherwise a release asset for the member's platform;
 *   otherwise unavailable(<reason>).
 */
export function chooseInstallSource(
  member: MemberPlatform,
  orchestrator: MemberPlatform,
  orchestratorExecutable: string | null,
  orchestratorVersion: string,
): InstallSource | { kind: 'unavailable'; reason: FleetInstallUnavailableReason; detail: string } {
  const samePlatform = member.os === orchestrator.os && member.arch === orchestrator.arch;
  if (samePlatform && orchestratorExecutable) {
    return { kind: 'orchestrator-executable', localPath: orchestratorExecutable };
  }
  const assetName = releaseAssetNameFor(member);
  if (assetName) {
    return { kind: 'release-asset', assetName, url: releaseAssetUrl(orchestratorVersion, assetName) };
  }
  if (samePlatform) {
    return {
      kind: 'unavailable',
      reason: 'no-install-source',
      detail:
        `member platform ${member.os}/${member.arch} matches this orchestrator, but the orchestrator does not ` +
        `run as a single-executable binary to copy and no release asset is published for that platform`,
    };
  }
  return {
    kind: 'unavailable',
    reason: 'unsupported-platform',
    detail:
      `member platform ${member.os}/${member.arch} differs from this orchestrator ` +
      `(${orchestrator.os}/${orchestrator.arch}) and no apra-fleet release asset exists for it`,
  };
}

/** The member-mode install command line arguments (exported for tests). */
export function memberInstallArgs(provider: LlmProvider): string[] {
  // --force stops a running member server before the binary is replaced, so an
  // upgrade of a live member does not abort on the running-process guard.
  return ['install', '--llm', provider, '--member', '--workflows', 'none', '--transport', 'http', '--force'];
}

/** Command that makes the staged installer executable and runs it in member mode. */
export function buildInstallCommand(
  installerPath: string,
  provider: LlmProvider,
  targetOs: TargetOS,
  shell: MemberShell,
): string {
  const args = memberInstallArgs(provider);
  return memberCommandFor(targetOs, shell, {
    posix: `chmod +x ${posixQuote(installerPath)} && ${posixQuote(installerPath)} ${args.map(posixQuote).join(' ')}`,
    powershell: `& ${psQuote(installerPath)} ${args.map(psQuote).join(' ')}`,
  });
}

// ---------------------------------------------------------------------------
// Production transports
// ---------------------------------------------------------------------------

function hostPlatform(): MemberPlatform {
  const osName: TargetOS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return { os: osName, arch: process.arch };
}

async function defaultDownload(url: string, assetName: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': `apra-fleet/${serverVersion}` } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-member-install-'));
  const out = path.join(dir, assetName);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

export function defaultMemberFleetInstallDeps(): MemberFleetInstallDeps {
  return {
    exec: (agent, command, timeoutMs) => getStrategy(agent).execCommand(command, timeoutMs),
    transfer: (agent, localPaths, destinationDir) => getStrategy(agent).transferFiles(localPaths, destinationDir),
    resolveHome: agent => getMemberHomeDir(agent),
    orchestratorPlatform: hostPlatform,
    orchestratorExecutable: seaExecutable,
    orchestratorVersion: () => serverVersion,
    downloadReleaseAsset: defaultDownload,
    removeLocal: p => {
      try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

let seaExecutableCache: string | null | undefined;
function seaExecutable(): string | null {
  if (seaExecutableCache !== undefined) return seaExecutableCache;
  try {
    // node:sea exists only inside a single-executable build; under ESM/dev the
    // require is unavailable and we correctly report "nothing to copy".
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = typeof require === 'function' ? require('node:sea') : null;
    seaExecutableCache = sea && sea.isSea() ? process.execPath : null;
  } catch {
    seaExecutableCache = null;
  }
  return seaExecutableCache;
}

// ---------------------------------------------------------------------------
// Probe + install
// ---------------------------------------------------------------------------

/** Basename on either separator: the local installer path follows the
 *  ORCHESTRATOR's convention, which need not match this host's path module. */
function anyBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Where the member's own apra-fleet lives: <home>/.apra-fleet/bin/<exe>. */
export function memberBinPath(home: string, targetOs: TargetOS, shell: MemberShell): string {
  return memberJoin(targetOs, shell, home, '.apra-fleet', 'bin', binaryNameFor(targetOs));
}

/** Where installers are staged before running: <home>/.apra-fleet/staging. */
export function memberStagingDir(home: string, targetOs: TargetOS, shell: MemberShell): string {
  return memberJoin(targetOs, shell, home, '.apra-fleet', 'staging');
}

/** Probe a member's apra-fleet at `binPath`. Never throws. */
export async function probeMemberFleetVersion(
  agent: Agent,
  binPath: string,
  deps: MemberFleetInstallDeps,
): Promise<MemberFleetProbe> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  let result: SSHExecResult;
  try {
    result = await deps.exec(agent, buildFleetVersionProbe(binPath, targetOs, shell), PROBE_TIMEOUT_MS);
  } catch (err: unknown) {
    return { kind: 'probe-failed', detail: `probe threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.stdout.includes(NO_INSTALL_SENTINEL)) return { kind: 'missing', binPath };
  if (result.stdout.includes(EXEC_FAILED_SENTINEL)) {
    return { kind: 'broken', binPath, detail: 'the executable exited non-zero or could not be launched' };
  }
  if (result.code !== 0) {
    return { kind: 'probe-failed', detail: `probe exited ${result.code}: ${result.stderr.trim().slice(0, 300)}` };
  }
  const version = parseFleetVersion(result.stdout);
  if (!version) {
    return { kind: 'broken', binPath, detail: `unparseable --version output: ${result.stdout.trim().slice(0, 200)}` };
  }
  return { kind: 'installed', version, binPath };
}

async function probeMemberArch(agent: Agent, deps: MemberFleetInstallDeps): Promise<MemberArch | null> {
  const targetOs = getAgentOS(agent) as TargetOS;
  try {
    const r = await deps.exec(agent, buildArchProbe(targetOs, getAgentShell(agent)), PROBE_TIMEOUT_MS);
    if (r.code !== 0) return null;
    return normalizeArch(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Ensure a REMOTE member runs an apra-fleet at least as new as this
 * orchestrator, installed in HTTP member mode. Never throws: every failure is a
 * typed `unavailable(<reason>)` result so the caller's registration proceeds.
 */
export async function ensureMemberFleetInstall(
  agent: Agent,
  deps: MemberFleetInstallDeps = defaultMemberFleetInstallDeps(),
): Promise<MemberFleetInstallResult> {
  try {
    return await ensureOnce(agent, deps);
  } catch (err: unknown) {
    return { state: 'unavailable', reason: 'probe-failed', detail: `install flow threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function ensureOnce(agent: Agent, deps: MemberFleetInstallDeps): Promise<MemberFleetInstallResult> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const provider: LlmProvider = agent.llmProvider ?? 'claude';
  const orchestratorVersion = deps.orchestratorVersion();

  const home = await deps.resolveHome(agent);
  if (!home) {
    return { state: 'unavailable', reason: 'home-unresolved', detail: 'the member home directory could not be probed' };
  }
  const binPath = memberBinPath(home, targetOs, shell);

  const before = await probeMemberFleetVersion(agent, binPath, deps);
  if (before.kind === 'probe-failed') {
    return { state: 'unavailable', reason: 'probe-failed', detail: before.detail };
  }
  if (before.kind === 'installed' && !isOlderThan(before.version, orchestratorVersion)) {
    return { state: 'available', version: before.version, installed: false, binPath };
  }
  const priorVersion = before.kind === 'installed' ? before.version : undefined;

  const arch = await probeMemberArch(agent, deps);
  if (!arch) {
    return { state: 'unavailable', reason: 'arch-unknown', detail: 'the member CPU architecture could not be probed', version: priorVersion };
  }
  const source = chooseInstallSource(
    { os: targetOs, arch },
    deps.orchestratorPlatform(),
    deps.orchestratorExecutable(),
    orchestratorVersion,
  );
  if (source.kind === 'unavailable') {
    return { state: 'unavailable', reason: source.reason, detail: source.detail, version: priorVersion };
  }

  let localPath: string;
  let downloaded = false;
  if (source.kind === 'orchestrator-executable') {
    localPath = source.localPath;
  } else {
    try {
      localPath = await deps.downloadReleaseAsset(source.url, source.assetName);
      downloaded = true;
    } catch (err: unknown) {
      return {
        state: 'unavailable',
        reason: 'download-failed',
        detail: `${source.url}: ${err instanceof Error ? err.message : String(err)}`,
        version: priorVersion,
      };
    }
  }

  try {
    const stagingDir = memberStagingDir(home, targetOs, shell);
    const sent = await deps.transfer(agent, [localPath], stagingDir);
    if (sent.failed.length > 0 || sent.success.length === 0) {
      const why = sent.failed.map(f => `${f.path}: ${f.error}`).join('; ') || 'nothing was transferred';
      return { state: 'unavailable', reason: 'transfer-failed', detail: why, version: priorVersion };
    }
    const installerPath = memberJoin(targetOs, shell, stagingDir, anyBasename(localPath));
    const run = await deps.exec(agent, buildInstallCommand(installerPath, provider, targetOs, shell), INSTALL_TIMEOUT_MS);
    if (run.code !== 0) {
      const tail = (run.stderr.trim() || run.stdout.trim()).slice(-400);
      return { state: 'unavailable', reason: 'install-failed', detail: `installer exited ${run.code}: ${tail}`, version: priorVersion };
    }
  } finally {
    if (downloaded) deps.removeLocal(localPath);
  }

  const after = await probeMemberFleetVersion(agent, binPath, deps);
  if (after.kind !== 'installed' || isOlderThan(after.version, orchestratorVersion)) {
    const seen = after.kind === 'installed' ? `reports ${after.version}` : after.kind === 'probe-failed' ? after.detail : after.kind;
    return {
      state: 'unavailable',
      reason: 'install-unverified',
      detail: `after install the member ${seen}; expected >= ${orchestratorVersion}`,
      version: priorVersion,
    };
  }
  return { state: 'available', version: after.version, installed: true, source: source.kind, binPath };
}
