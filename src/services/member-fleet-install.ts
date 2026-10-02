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
import type { Agent, FleetMcpStatus, LlmProvider, SSHExecResult } from '../types.js';
import type { TargetOS } from '../providers/provider.js';
import { getStrategy } from './strategy.js';
import { getMemberHomeDir } from './member-home.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../utils/agent-helpers.js';
import { escapePowerShellArgInner, escapeShellArgInner } from '../utils/shell-escape.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { serverVersion } from '../version.js';
import { parseVersion, isNewer } from './update-check.js';
import { recordFleetMcpStatus } from './registry.js';
import { probeMemberClaudeConfigDir, claudeLocalScopeConfigFile } from '../providers/claude.js';
import { OPENCODE_PROJECT_CONFIG } from '../providers/opencode.js';
import { readMemberJson, joinMemberPath, MEMBER_MCP_SERVER_NAME } from './member-config-io.js';

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
  opts: { force?: boolean } = {},
): Promise<MemberFleetInstallResult> {
  try {
    return await ensureOnce(agent, deps, opts.force === true);
  } catch (err: unknown) {
    return { state: 'unavailable', reason: 'probe-failed', detail: `install flow threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function ensureOnce(agent: Agent, deps: MemberFleetInstallDeps, force: boolean): Promise<MemberFleetInstallResult> {
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
  if (!force && before.kind === 'installed' && !isOlderThan(before.version, orchestratorVersion)) {
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

// ---------------------------------------------------------------------------
// Self-registration, MEMBER-session verification and the fleetMcp status
// (apra-fleet-b4g.56.2)
// ---------------------------------------------------------------------------

/** Machine-readable fleetMcp reasons beyond the install reasons above. */
export type FleetMcpUnavailableReason =
  | FleetInstallUnavailableReason
  /** The member's install predates `register-member --id`. */
  | 'install-too-old'
  /** The member's own install has the work folder registered under another id. */
  | 'E-FOLDER-TAKEN'
  /** register-member on the member's own install failed for another reason. */
  | 'register-failed'
  /** The per-folder apra-fleet MCP entry compose_permissions writes is absent
   *  or does not point at ?member=<uuid>. */
  | 'mcp-entry-missing'
  /** agy has no per-project MCP config fleet can point at the member session. */
  | 'no-per-project-mcp'
  /** The member's LLM provider has no MCP entry fleet configures. */
  | 'provider-unsupported'
  /** A member config file compose must edit exists but could not be read; compose wrote nothing to it. */
  | 'member-config-unreadable'
  /** A member config file compose must edit is not strict JSON; compose wrote nothing to it. */
  | 'member-config-unparseable'
  /** The work folder's opencode.json is tracked by git; compose left it untouched. */
  | 'opencode-config-tracked'
  /** The work folder's opencode.json is not strict JSON (e.g. JSONC); compose left it untouched. */
  | 'opencode-config-unparseable'
  /** A MEMBER session could not be opened or its version call failed. */
  | 'member-session-failed'
  /** The MEMBER session answered but did not list kb_* and code_* tools. */
  | 'member-tools-missing';

/** A MEMBER session's client surface (subset of the MCP client). */
export interface MemberSession {
  mcpClient: {
    callTool(name: string, args: unknown): Promise<unknown>;
    listTools(): Promise<unknown>;
  };
  close?: () => Promise<void>;
  transport?: { stop?: () => void };
}

export interface MemberFleetMcpDeps extends MemberFleetInstallDeps {
  /** Open a direct MEMBER session (?member=<uuid>) to THIS orchestrator's server (local members). */
  connectLocalMember(memberId: string): Promise<MemberSession>;
  now(): Date;
  /** Persist the observation on the member registry entry. */
  record(memberId: string, status: FleetMcpStatus): void;
}


let mcpDepsOverride: MemberFleetMcpDeps | null = null;

/** Test-only: replace the production transports used by register/update/remove_member and member_detail. Pass null to restore. */
export function __setMemberFleetMcpDeps(deps: MemberFleetMcpDeps | null): void {
  mcpDepsOverride = deps;
}

/** The deps the tool handlers use (production transports unless a test injected fakes). */
export function getMemberFleetMcpDeps(): MemberFleetMcpDeps {
  return mcpDepsOverride ?? defaultMemberFleetMcpDeps();
}

export function defaultMemberFleetMcpDeps(): MemberFleetMcpDeps {
  return {
    ...defaultMemberFleetInstallDeps(),
    connectLocalMember: async (memberId: string) => {
      const m = await import('@apralabs/apra-fleet-client/server-resolution');
      return m.connectFleetMember(memberId) as unknown as MemberSession;
    },
    now: () => new Date(),
    record: (memberId, status) => { recordFleetMcpStatus(memberId, status); },
  };
}

const MEMBER_CALL_TIMEOUT_MS = 60_000;

/** `register-member` on the member's own install, as a LOCAL member under the
 *  orchestrator's id for it (exported for tests). */
export function buildSelfRegisterCommand(binPath: string, agent: Agent, targetOs: TargetOS, shell: MemberShell): string {
  const args = [
    'register-member', '--type', 'local', '--id', agent.id,
    '--name', agent.friendlyName, '--path', agent.workFolder,
    '--llm', agent.llmProvider ?? 'claude',
  ];
  return memberCommandFor(targetOs, shell, {
    posix: `${posixQuote(binPath)} ${args.map(posixQuote).join(' ')}`,
    powershell: `& ${psQuote(binPath)} ${args.map(psQuote).join(' ')}`,
  });
}

/** `remove-member` on the member's own install (exported for tests). */
export function buildSelfRemoveCommand(binPath: string, memberId: string, targetOs: TargetOS, shell: MemberShell): string {
  const args = ['remove-member', '--id', memberId, '--force'];
  return memberCommandFor(targetOs, shell, {
    posix: `${posixQuote(binPath)} ${args.map(posixQuote).join(' ')}`,
    powershell: `& ${psQuote(binPath)} ${args.map(psQuote).join(' ')}`,
  });
}

/** `call --member <uuid> version` (with a `{}` args file written first) or
 *  `call --member <uuid> --list-tools`, on the member (exported for tests). */
export function buildMemberCallCommand(
  binPath: string,
  memberId: string,
  what: 'version' | 'list-tools',
  argsPath: string,
  targetOs: TargetOS,
  shell: MemberShell,
): string {
  const callArgs = what === 'list-tools'
    ? ['call', '--member', memberId, '--list-tools']
    : ['call', '--member', memberId, 'version', '--args-file', argsPath, '--rm-args-file'];
  if (what === 'list-tools') {
    return memberCommandFor(targetOs, shell, {
      posix: `${posixQuote(binPath)} ${callArgs.map(posixQuote).join(' ')}`,
      powershell: `& ${psQuote(binPath)} ${callArgs.map(psQuote).join(' ')}`,
    });
  }
  return memberCommandFor(targetOs, shell, {
    posix: `printf '%s' '{}' > ${posixQuote(argsPath)} && ${posixQuote(binPath)} ${callArgs.map(posixQuote).join(' ')}`,
    powershell:
      `Set-Content -LiteralPath ${psQuote(argsPath)} -Value '{}' -NoNewline -Encoding ascii; ` +
      `& ${psQuote(binPath)} ${callArgs.map(psQuote).join(' ')}`,
  });
}

/** Last parseable JSON object line in command output. */
function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* keep looking */ }
  }
  return null;
}

function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> } | null)?.content;
  return Array.isArray(content) ? content.map(c => c?.text ?? '').join('\n') : '';
}

function toolNames(list: unknown): string[] {
  const tools = (list as { tools?: Array<{ name?: string }> } | null)?.tools;
  return Array.isArray(tools) ? tools.map(t => String(t?.name ?? '')).filter(Boolean) : [];
}

const VERSION_TOKEN_RE = /v?\d+\.\d+\.\d+[^\s"',]*/;

/** Judge a MEMBER session's version + tools/list answers. */
function judgeSession(versionResult: unknown, list: unknown): { ok: true; version?: string } | { ok: false; reason: FleetMcpUnavailableReason; detail: string } {
  if ((versionResult as { isError?: boolean } | null)?.isError) {
    return { ok: false, reason: 'member-session-failed', detail: `version returned an error: ${toolResultText(versionResult).slice(0, 200)}` };
  }
  const names = toolNames(list);
  const hasKb = names.some(n => n.startsWith('kb_'));
  const hasCode = names.some(n => n.startsWith('code_'));
  if (!hasKb || !hasCode) {
    return {
      ok: false,
      reason: 'member-tools-missing',
      detail: `member session tools/list lacks ${[!hasKb && 'kb_*', !hasCode && 'code_*'].filter(Boolean).join(' and ')} (got ${names.length} tools)`,
    };
  }
  const m = VERSION_TOKEN_RE.exec(toolResultText(versionResult));
  return { ok: true, version: m?.[0] };
}

/** Parse `apra-fleet call` output; a {"error":{code,message}} line is a failure. */
function parseCallOutput(r: SSHExecResult, what: string): { ok: true; value: Record<string, unknown> } | { ok: false; detail: string } {
  const parsed = lastJsonObject(`${r.stdout}\n${r.stderr}`);
  const err = parsed?.error as { code?: string; message?: string } | undefined;
  if (err && typeof err === 'object') return { ok: false, detail: `${what}: ${err.code ?? 'E-REMOTE'}: ${err.message ?? ''}`.trim() };
  if (r.code !== 0) return { ok: false, detail: `${what} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-300)}` };
  if (!parsed) return { ok: false, detail: `${what}: unparseable output: ${r.stdout.trim().slice(0, 200)}` };
  return { ok: true, value: parsed };
}

/**
 * The URL of the member's per-folder apra-fleet MCP entry written by
 * compose_permissions, or null when there is none. claude:
 * <config dir>/.claude.json projects[<folder>].mcpServers['apra-fleet'].url;
 * opencode: <workFolder>/opencode.json mcp['apra-fleet'].url.
 */
export async function readMemberMcpEntryUrl(agent: Agent, home: string, deps: Pick<MemberFleetInstallDeps, 'exec'>): Promise<string | null> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const isWindows = targetOs === 'windows';
  const posix = isPosixShell(targetOs, shell);
  const exec = (cmd: string, t?: number) => deps.exec(agent, cmd, t ?? PROBE_TIMEOUT_MS);
  const rec = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  try {
    if ((agent.llmProvider ?? 'claude') === 'claude') {
      const configDir = await probeMemberClaudeConfigDir(exec, targetOs, shell);
      const file = claudeLocalScopeConfigFile(configDir, home, isWindows, shell).file;
      const config = await readMemberJson(exec, file, posix);
      const key = agent.workFolder.replace(/\\/g, '/').replace(/\/+$/, '');
      const entry = rec(rec(rec(rec(config.projects)?.[key])?.mcpServers)?.[MEMBER_MCP_SERVER_NAME]);
      return typeof entry?.url === 'string' ? entry.url : null;
    }
    const file = joinMemberPath(agent.workFolder, OPENCODE_PROJECT_CONFIG, isWindows, shell);
    const config = await readMemberJson(exec, file, posix);
    const entry = rec(rec(config.mcp)?.[MEMBER_MCP_SERVER_NAME]);
    return typeof entry?.url === 'string' ? entry.url : null;
  } catch {
    return null;
  }
}

function memberQuery(agent: Agent): string {
  return `?member=${encodeURIComponent(agent.id)}`;
}

/** Providers whose per-folder apra-fleet entry this module can verify. */
const PER_FOLDER_PROVIDERS = new Set<LlmProvider>(['claude', 'opencode']);

/**
 * Observe a member's apra-fleet MCP server and return its fleetMcp status.
 * Never throws and never records -- see refreshMemberFleetMcp for that.
 *
 *  - agy: unavailable(no-per-project-mcp), unverified; nothing is probed.
 *  - providers with no per-folder fleet entry: unavailable(provider-unsupported), unverified.
 *  - LOCAL members: no install; a direct MEMBER session to this server.
 *  - remote members: ensure the install (opts.install, default true; false
 *    only probes the version), register the member on its own install
 *    (`register-member --type local --id <uuid>`), check the per-folder MCP
 *    entry, then verify a MEMBER session through `apra-fleet call` on the member.
 */
export async function probeMemberFleetMcp(
  agent: Agent,
  deps: MemberFleetMcpDeps = defaultMemberFleetMcpDeps(),
  opts: { install?: boolean; forceInstall?: boolean } = {},
): Promise<FleetMcpStatus> {
  const checkedAt = () => deps.now().toISOString();
  const unavailable = (reason: FleetMcpUnavailableReason, detail?: string, extra: Partial<FleetMcpStatus> = {}): FleetMcpStatus => ({
    state: 'unavailable', reason, checkedAt: checkedAt(), ...(detail ? { detail } : {}), ...extra,
  });
  try {
    const provider: LlmProvider = agent.llmProvider ?? 'claude';
    if (provider === 'agy') {
      return unavailable('no-per-project-mcp', 'agy has no per-project MCP config fleet can point at the member session', { unverified: true });
    }
    if (!PER_FOLDER_PROVIDERS.has(provider)) {
      return unavailable('provider-unsupported', `fleet writes no per-folder apra-fleet MCP entry for provider "${provider}"`, { unverified: true });
    }

    if (agent.agentType === 'local') return await probeLocal(agent, deps, unavailable, checkedAt);
    return await probeRemote(agent, deps, opts.install !== false, unavailable, checkedAt, opts.forceInstall === true);
  } catch (err: unknown) {
    return unavailable('probe-failed', `probe threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Unavailable = (reason: FleetMcpUnavailableReason, detail?: string, extra?: Partial<FleetMcpStatus>) => FleetMcpStatus;

async function probeLocal(agent: Agent, deps: MemberFleetMcpDeps, unavailable: Unavailable, checkedAt: () => string): Promise<FleetMcpStatus> {
  let session: MemberSession;
  try {
    session = await deps.connectLocalMember(agent.id);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return unavailable('member-session-failed', e.status === 403
      ? `server refused member ${agent.id}: not a registered member (HTTP 403)`
      : `could not open a member session: ${e.message ?? String(err)}`);
  }
  try {
    const versionResult = await session.mcpClient.callTool('version', {});
    const list = await session.mcpClient.listTools();
    const judged = judgeSession(versionResult, list);
    if (!judged.ok) return unavailable(judged.reason, judged.detail);
    return { state: 'available', checkedAt: checkedAt(), ...(judged.version ? { version: judged.version } : {}) };
  } catch (err: unknown) {
    return unavailable('member-session-failed', `member session call failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      if (session.close) await session.close(); else session.transport?.stop?.();
    } catch { /* ignore */ }
  }
}

async function probeRemote(
  agent: Agent,
  deps: MemberFleetMcpDeps,
  install: boolean,
  unavailable: Unavailable,
  checkedAt: () => string,
  forceInstall = false,
): Promise<FleetMcpStatus> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);

  const home = await deps.resolveHome(agent);
  if (!home) return unavailable('home-unresolved', 'the member home directory could not be probed');
  const binPath = memberBinPath(home, targetOs, shell);

  // 1. Install (or, when not installing, just observe the version).
  let version: string | undefined;
  if (install) {
    const r = await ensureMemberFleetInstall(agent, deps, { force: forceInstall });
    if (r.state === 'available') version = r.version;
    else if (r.version) version = r.version; // an older install is still there: try to use it
    else return unavailable(r.reason, r.detail);
  } else {
    const p = await probeMemberFleetVersion(agent, binPath, deps);
    if (p.kind === 'probe-failed') return unavailable('probe-failed', p.detail);
    if (p.kind !== 'installed') return unavailable('install-unverified', p.kind === 'broken' ? p.detail : 'apra-fleet is not installed on the member');
    version = p.version;
  }
  const withVersion = { version };

  // 2. Register the member on its own install under the orchestrator's id.
  const reg = await deps.exec(agent, buildSelfRegisterCommand(binPath, agent, targetOs, shell), MEMBER_CALL_TIMEOUT_MS);
  if (reg.code !== 0) {
    const out = `${reg.stdout}\n${reg.stderr}`;
    if (/E-FOLDER-TAKEN/.test(out)) return unavailable('E-FOLDER-TAKEN', out.trim().slice(-300), withVersion);
    if (/unknown or unexpected argument "--id"/i.test(out) || /unknown (?:option|command|argument)[^\n]*(?:--id|register-member)/i.test(out)) {
      return unavailable('install-too-old', `the member's apra-fleet ${version} does not support register-member --id`, withVersion);
    }
    return unavailable('register-failed', `register-member exited ${reg.code}: ${out.trim().slice(-300)}`, withVersion);
  }

  // 3. The per-folder MCP entry compose_permissions writes must point at this member.
  const url = await readMemberMcpEntryUrl(agent, home, deps);
  if (!url || !url.endsWith(memberQuery(agent))) {
    return unavailable('mcp-entry-missing', url
      ? `per-folder apra-fleet entry points at ${url}, not ${memberQuery(agent)}`
      : 'no per-folder apra-fleet MCP entry for the work folder; run compose_permissions', withVersion);
  }

  // 4. A MEMBER session on the member answers version and lists kb_* / code_*.
  const argsPath = memberJoin(targetOs, shell, home, '.apra-fleet', `version-args-${agent.id}.json`);
  const v = parseCallOutput(
    await deps.exec(agent, buildMemberCallCommand(binPath, agent.id, 'version', argsPath, targetOs, shell), MEMBER_CALL_TIMEOUT_MS),
    'call version',
  );
  if (!v.ok) return unavailable('member-session-failed', v.detail, withVersion);
  const l = parseCallOutput(
    await deps.exec(agent, buildMemberCallCommand(binPath, agent.id, 'list-tools', argsPath, targetOs, shell), MEMBER_CALL_TIMEOUT_MS),
    'call --list-tools',
  );
  if (!l.ok) return unavailable('member-session-failed', l.detail, withVersion);
  const judged = judgeSession(v.value, l.value);
  if (!judged.ok) return unavailable(judged.reason, judged.detail, withVersion);
  return { state: 'available', version, checkedAt: checkedAt() };
}

/**
 * Probe and RECORD the member's fleetMcp status on its registry entry. The
 * record is an observation, overwritten on every call, so a re-probe after a
 * manual fix flips unavailable -> available with no restart.
 */
export async function refreshMemberFleetMcp(
  agent: Agent,
  deps: MemberFleetMcpDeps = defaultMemberFleetMcpDeps(),
  opts: { install?: boolean; forceInstall?: boolean } = {},
): Promise<FleetMcpStatus> {
  const status = await probeMemberFleetMcp(agent, deps, opts);
  deps.record(agent.id, status);
  return status;
}

export type SelfRemoveResult =
  | { removed: boolean; detail: string }
  | { removed: false; reason: 'home-unresolved' | 'install-too-old' | 'remove-failed' | 'probe-failed'; detail: string };

/**
 * Remove the member's self-registration from its OWN install (remove_member's
 * counterpart of the register step). Local members share this orchestrator's
 * install, whose registry remove_member already edits, so nothing runs for
 * them. A member with no install has nothing to remove. Never throws.
 */
export async function removeMemberFromOwnInstall(
  agent: Agent,
  deps: MemberFleetInstallDeps = defaultMemberFleetInstallDeps(),
): Promise<SelfRemoveResult> {
  if (agent.agentType === 'local') return { removed: false, detail: 'local member: shares this install; nothing to remove member-side' };
  try {
    const targetOs = getAgentOS(agent) as TargetOS;
    const shell = getAgentShell(agent);
    const home = await deps.resolveHome(agent);
    if (!home) return { removed: false, reason: 'home-unresolved', detail: 'the member home directory could not be probed' };
    const binPath = memberBinPath(home, targetOs, shell);
    const probe = await probeMemberFleetVersion(agent, binPath, deps);
    if (probe.kind === 'missing') return { removed: false, detail: 'apra-fleet is not installed on the member; nothing to remove' };
    if (probe.kind === 'probe-failed') return { removed: false, reason: 'probe-failed', detail: probe.detail };
    const r = await deps.exec(agent, buildSelfRemoveCommand(binPath, agent.id, targetOs, shell), MEMBER_CALL_TIMEOUT_MS);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) {
      return /E-NOT-REGISTERED/.test(out)
        ? { removed: false, detail: `member ${agent.id} was not registered on its own install` }
        : { removed: true, detail: `removed member ${agent.id} from its own install` };
    }
    if (/unknown (?:option|command|argument)[^\n]*remove-member/i.test(out) || /remove-member/.test(out) && /unknown/i.test(out)) {
      return { removed: false, reason: 'install-too-old', detail: 'the member install has no remove-member verb' };
    }
    return { removed: false, reason: 'remove-failed', detail: `remove-member exited ${r.code}: ${out.trim().slice(-300)}` };
  } catch (err: unknown) {
    return { removed: false, reason: 'remove-failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
