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
import crypto from 'node:crypto';
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
import { serverVersion, clientExpectedVersion } from '../version.js';
import { BUILTIN_DEFAULT_PORT, validPort } from '../paths.js';
import { FULL_INSTALL_RUNNING_CODE, FORCE_STOP_FULL_INSTALL_FLAG, MEMBER_STANDALONE_CODE } from '../cli/install-guard.js';
import { parseVersion, isNewer } from './update-check.js';
import { recordFleetMcpStatus, updateAgent } from './registry.js';
import { encryptPassword } from '../utils/crypto.js';
import { ensureRemoteMemberAccessSecret, type StageSecretFileFn } from './member-access-secret.js';
import { removeMemberSecretFile, writeMemberSecretFile } from './member-secret-env.js';
import { probeMemberClaudeConfigDir, claudeLocalScopeConfigFile } from '../providers/claude.js';
import { OPENCODE_PROJECT_CONFIG } from '../providers/opencode.js';
import { readMemberJson, joinMemberPath, memberFileExistsPosixCommand, memberFileExistsPwshCommand, resolveClaudeProjectKey, MEMBER_MCP_SERVER_NAME } from './member-config-io.js';

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
  /** The release asset download did not finish within the bounded timeout. Recoverable: retry. */
  | 'download-timeout'
  /** The downloaded asset's SHA-256 does not match the published checksum; it was discarded. */
  | 'checksum-mismatch'
  /** No published checksum for the asset could be fetched, so it cannot be verified; it was discarded. */
  | 'checksum-unavailable'
  /** No published release (exact-build prerelease, or stable release whose
   *  BUILD_INFO names this build) carries an installer for the orchestrator's
   *  build. */
  | 'no-matching-release'
  /** The member apra-fleet install has no member-install marker (a full install, or a member install older than the
   *  marker): it was not installed over, its server (if running) was left running, and the member was not
   *  self-registered into it. */
  | 'full-install-running'
  /** Copying the installer onto the member failed. */
  | 'transfer-failed'
  /** The installer ran but exited non-zero. */
  | 'install-failed'
  /** After installing, the member still does not report a version >= the
   *  orchestrator's. */
  | 'install-unverified'
  /** The opt-in full-install replacement (fleet_install "replace-full") failed
   *  at a step that ran on the member; the detail names the step and, from the
   *  uninstall step on, the rollback commands. */
  | 'replace-failed';

/** What the probe observed about the member's current install. */
export type MemberFleetProbe =
  | { kind: 'installed'; version: string; binPath: string }
  | { kind: 'missing'; binPath: string }
  | { kind: 'broken'; binPath: string; detail: string }
  | { kind: 'probe-failed'; detail: string };

export type InstallSource =
  | { kind: 'orchestrator-executable'; localPath: string }
  | {
      kind: 'release-asset';
      assetName: string;
      /** The first URL tried (candidates[0]). */
      url: string;
      /** Releases tried in order (stable first, BUILD_INFO-gated, then the
       *  exact-build prerelease) until one has a verified asset for this
       *  build; see releaseCandidatesFor and fetchReleaseInstaller. */
      candidates: ReleaseCandidate[];
    };

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
      /** Set when this call replaced an unmarked (full) install with a member
       *  install (fleet_install "replace-full"). */
      replaced?: ReplacedFullInstall;
      /** Set when no release carried the exact build and the signed stable
       *  release of the same core was installed instead. */
      sameCoreFallback?: SameCoreFallback;
      /** Set when THIS call's installer reported MEMBER-STANDALONE: the member
       *  has no usable user-mode service manager, so nothing started its server. */
      standalone?: string;
    }
  | {
      state: 'unavailable';
      reason: FleetInstallUnavailableReason;
      detail?: string;
      /** Version observed before any install attempt, if one was present. */
      version?: string;
      /** OS-correct manual install steps for the member (buildManualInstallSteps). */
      manualSteps?: string;
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
  /** Download `url` to a local temp file named `assetName`, verified against
   *  the release's SHA256SUMS; returns its path. With `expectBuild`, the
   *  release must also be that build (its BUILD_INFO). Throws on failure
   *  (a ReleaseDownloadError names the reason). */
  downloadReleaseAsset(url: string, assetName: string, expectBuild?: string): Promise<string>;
  /** Remove a local temp file created by downloadReleaseAsset. Best effort. */
  removeLocal(localPath: string): void;
  /** Clock for the full-install replacement's backup timestamp. Optional:
   *  absent means the real clock. */
  now?(): Date;
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

/** The `_build` suffix of a version ("v0.4.4_abc" -> "abc"), or "" when none. */
function buildSuffixOf(version: string): string {
  const i = version.indexOf('_');
  return i < 0 ? '' : version.slice(i + 1);
}

/**
 * Build-aware outdated check for the member install (exported for tests).
 * Rule: a member core OLDER than the orchestrator's is always outdated; a
 * NEWER core never is (never downgrade, whatever the suffixes). At the SAME
 * core, a differing build suffix counts as outdated only when
 * `canSupplyOrchestratorBuild` -- i.e. the source installs exactly the
 * orchestrator's build: its own executable, or (suffixed orchestrator) a
 * release whose BUILD_INFO names that build (sourceSuppliesBuild). A bare
 * release orchestrator installs whatever build its stable tag has, so a
 * same-core build difference there is "up to date" (else it would reinstall
 * on every registration and report install-unverified). Mixed
 * suffix/no-suffix at the same core follows the same rule; identical
 * versions are never outdated.
 * isNewer/parseVersion (shared with the CLI self-update check) are untouched.
 */
export function isMemberOutdated(
  memberVersion: string,
  orchestratorVersion: string,
  canSupplyOrchestratorBuild: boolean,
): boolean {
  if (isOlderThan(memberVersion, orchestratorVersion)) return true;
  if (isNewer(memberVersion, orchestratorVersion)) return false;
  return canSupplyOrchestratorBuild && buildSuffixOf(memberVersion) !== buildSuffixOf(orchestratorVersion);
}

/** Release asset names published by .github/workflows/ci.yml, by platform. */
export const RELEASE_ASSETS: Record<string, string> = {
  'linux/x64': 'apra-fleet-installer-linux-x64',
  'macos/arm64': 'apra-fleet-installer-darwin-arm64',
  'macos/x64': 'apra-fleet-installer-darwin-x64',
  'windows/x64': 'apra-fleet-installer-win-x64.exe',
};

export function releaseAssetNameFor(platform: MemberPlatform): string | null {
  return RELEASE_ASSETS[`${platform.os}/${platform.arch}`] ?? null;
}

/** `v0.4.4_abc123` -> `v0.4.4`: the STABLE release tag of a build's core version. */
export function releaseTagFor(version: string): string {
  return `v${version.replace(/^v/, '').split('_')[0]}`;
}

/** `v0.4.4_abc123` -> `v0.4.4_abc123`: the exact-build prerelease tag CI
 *  publishes for builds of its prerelease branches (ci.yml job prerelease),
 *  or null for a bare release version, which has no build to match. */
export function prereleaseTagFor(version: string): string | null {
  const v = version.startsWith('v') ? version : `v${version}`;
  return buildSuffixOf(v) ? v : null;
}

/** Anonymous download URL of `fileName` in the release tagged `tag`. */
export function releaseFileUrl(tag: string, fileName: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${fileName}`;
}

/** Human-browsable page of the release tagged `tag`. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`;
}

/** Where a build's installer may be published, in the order the installer
 *  tries them: the STABLE release of the core version first, accepted only
 *  when its BUILD_INFO names the same build (see buildInfoMatches) -- stable
 *  tag builds carry a build suffix too, and their commit also gets an
 *  unsigned prerelease when it is pushed to main, so a stable orchestrator
 *  must get the signed stable assets -- then the exact-build prerelease
 *  (dev/branch builds). The same-core stable fallback is not a candidate: it
 *  is a separate, opt-in last step in fetchReleaseInstaller. */
export interface ReleaseCandidate {
  tag: string;
  channel: 'prerelease' | 'stable';
}

export function releaseCandidatesFor(version: string): ReleaseCandidate[] {
  const pre = prereleaseTagFor(version);
  return [
    { tag: releaseTagFor(version), channel: 'stable' as const },
    ...(pre ? [{ tag: pre, channel: 'prerelease' as const }] : []),
  ];
}

/** The URL the installer tries first for `version` (the stable release). */
export function releaseAssetUrl(version: string, assetName: string): string {
  return releaseFileUrl(releaseCandidatesFor(version)[0].tag, assetName);
}

/** True when a release source supplies exactly the orchestrator's build: a
 *  dev/branch build only ever accepts a release whose BUILD_INFO names that
 *  build, so the installed member reports the same suffix. A bare release
 *  version accepts any build of its core (the stable tag build). */
function releaseSuppliesExactBuild(orchestratorVersion: string): boolean {
  return buildSuffixOf(orchestratorVersion) !== '';
}

/** Whether the chosen source installs exactly the orchestrator's build. */
function sourceSuppliesBuild(source: InstallSource, orchestratorVersion: string): boolean {
  return source.kind === 'orchestrator-executable' || releaseSuppliesExactBuild(orchestratorVersion);
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
    return {
      kind: 'release-asset', assetName,
      url: releaseAssetUrl(orchestratorVersion, assetName),
      candidates: releaseCandidatesFor(orchestratorVersion),
    };
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
  // --force-stop-full-install is NEVER added: the fleet cannot tell a human
  // full install from an unmarked older member install, so overriding a
  // refusal is left to the owner on the member (see buildFullInstallReplaceHint).
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

/** Bound on each release HTTP request (asset and checksum list). */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Name of the checksum list published next to the release assets (ci.yml release job). */
export const CHECKSUM_ASSET = 'SHA256SUMS';

/** Build marker published next to the release assets (ci.yml release and
 *  prerelease jobs): `version=<exact build version>` and `commit=<full sha>`
 *  lines, itself listed in SHA256SUMS. */
export const BUILD_INFO_ASSET = 'BUILD_INFO';

/** Typed download failure reasons. `release-not-found` (the tag has no
 *  release: SHA256SUMS is HTTP 404) and `build-mismatch` (the release is not
 *  this build) only move on to the next candidate release; when every
 *  candidate ends that way the result is `no-matching-release`. */
export type ReleaseDownloadReason =
  | 'download-failed' | 'download-timeout' | 'checksum-mismatch' | 'checksum-unavailable'
  | 'release-not-found' | 'build-mismatch' | 'no-matching-release';

/** A typed download failure; ensureOnce maps `reason` onto the fleetMcp status. */
export class ReleaseDownloadError extends Error {
  constructor(
    public readonly reason: ReleaseDownloadReason,
    message: string,
    /** HTTP status of the failed request, when it got an answer. */
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ReleaseDownloadError';
  }
}

/** Map a download failure onto the install reason recorded in fleetMcp. */
function downloadFailureReason(err: unknown): FleetInstallUnavailableReason {
  if (!(err instanceof ReleaseDownloadError)) return 'download-failed';
  if (err.reason === 'release-not-found' || err.reason === 'build-mismatch') return 'no-matching-release';
  return err.reason;
}

/** Parse BUILD_INFO (`key=value` lines). */
export function parseBuildInfo(text: string): { version?: string; commit?: string } {
  const out: { version?: string; commit?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(version|commit)\s*=\s*(\S+)\s*$/.exec(line);
    if (m) out[m[1] as 'version' | 'commit'] = m[2];
  }
  return out;
}

/**
 * Does a release's BUILD_INFO describe the build `expected` (the
 * orchestrator's version)? A dev/branch build `v<x.y.z>_<sha6>` matches only
 * the same version, or the same core built from a commit starting with that
 * sha; a bare release version `v<x.y.z>` matches any build of that core.
 */
export function buildInfoMatches(info: { version?: string; commit?: string }, expected: string): boolean {
  if (!info.version) return false;
  const norm = (v: string) => (v.startsWith('v') ? v : `v${v}`);
  const want = norm(expected);
  const got = norm(info.version);
  if (releaseTagFor(got) !== releaseTagFor(want)) return false;
  const suffix = buildSuffixOf(want);
  if (!suffix) return true;
  return got === want || (!!info.commit && info.commit.toLowerCase().startsWith(suffix.toLowerCase()));
}

/** The expected hex digest for `assetName` in a `sha256sum`-format list, or null. */
export function parseSha256Sums(text: string, assetName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === assetName) return m[1].toLowerCase();
  }
  return null;
}

export interface DownloadOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The build the release must be (the orchestrator's version). When set,
   *  the release is resolved, not assumed: SHA256SUMS HTTP 404 is
   *  `release-not-found`, and the release's BUILD_INFO (listed in SHA256SUMS
   *  and checksum-verified) must name this build, else `build-mismatch`. */
  expectBuild?: string;
}

/** Anonymous GET: no Authorization header, ever (release assets of the public
 *  repo download without a GitHub account). */
async function boundedGet(url: string, opts: DownloadOpts): Promise<Buffer> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': `apra-fleet/${serverVersion}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new ReleaseDownloadError('download-failed', `GET ${url} -> HTTP ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  } catch (err: unknown) {
    if (err instanceof ReleaseDownloadError) throw err;
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ReleaseDownloadError('download-timeout', `GET ${url} did not complete within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new ReleaseDownloadError('download-failed', `GET ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Download a release asset to a temp file, bounded by a timeout, and verify its
 * SHA-256 against the release's published SHA256SUMS before returning the path.
 * Fails closed: a missing checksum is `checksum-unavailable`, a differing one
 * `checksum-mismatch`; nothing unverified is ever written to disk.
 */
export async function downloadVerifiedAsset(url: string, assetName: string, opts: DownloadOpts = {}): Promise<string> {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const sumsUrl = base + CHECKSUM_ASSET;
  let sums: string;
  try {
    sums = (await boundedGet(sumsUrl, opts)).toString('utf8');
  } catch (err: unknown) {
    if (err instanceof ReleaseDownloadError && err.reason === 'download-timeout') throw err;
    if (opts.expectBuild && err instanceof ReleaseDownloadError && err.status === 404) {
      throw new ReleaseDownloadError('release-not-found', `no release at ${base} (${sumsUrl} -> HTTP 404)`, 404);
    }
    // No HTTP answer at all (DNS, connection reset, TLS): a network failure,
    // reported as such -- not as a missing checksum.
    if (err instanceof ReleaseDownloadError && err.status === undefined) throw err;
    throw new ReleaseDownloadError('checksum-unavailable', `no published checksum could be fetched (${err instanceof Error ? err.message : String(err)})`);
  }
  if (opts.expectBuild) {
    // The release must be THIS build: its BUILD_INFO, verified against the same
    // SHA256SUMS, names the build version and commit.
    const infoSha = parseSha256Sums(sums, BUILD_INFO_ASSET);
    if (!infoSha) throw new ReleaseDownloadError('build-mismatch', `${sumsUrl} lists no ${BUILD_INFO_ASSET}, so the release cannot be matched to build ${opts.expectBuild}`);
    const infoBody = await boundedGet(base + BUILD_INFO_ASSET, opts);
    if (crypto.createHash('sha256').update(infoBody).digest('hex') !== infoSha) {
      throw new ReleaseDownloadError('checksum-mismatch', `${BUILD_INFO_ASSET} at ${base} does not match its published SHA256SUMS entry`);
    }
    const info = parseBuildInfo(infoBody.toString('utf8'));
    if (!buildInfoMatches(info, opts.expectBuild)) {
      throw new ReleaseDownloadError('build-mismatch', `the release at ${base} is build ${info.version ?? '(unnamed)'}${info.commit ? ` (commit ${info.commit.slice(0, 12)})` : ''}, not ${opts.expectBuild}`);
    }
  }
  const expected = parseSha256Sums(sums, assetName);
  if (!expected) throw new ReleaseDownloadError('checksum-unavailable', `${sumsUrl} does not list ${assetName}`);
  const body = await boundedGet(url, opts);
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  if (actual !== expected) {
    throw new ReleaseDownloadError('checksum-mismatch', `${assetName} sha256 ${actual} does not match the published ${expected}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-member-install-'));
  const out = path.join(dir, assetName);
  fs.writeFileSync(out, body);
  return out;
}

const defaultDownload = (url: string, assetName: string, expectBuild?: string): Promise<string> =>
  downloadVerifiedAsset(url, assetName, expectBuild ? { expectBuild } : {});

/**
 * Fetch the verified installer for the orchestrator's build from the first
 * candidate release that has it: the stable release whose BUILD_INFO names
 * this build, then the exact-build prerelease, then -- only with
 * `allowSameCoreStable` (member has no apra-fleet or an older core) -- the
 * signed stable release of the same core (never across cores). Only a
 * missing release or one that is not this build moves on to the next
 * candidate; any other failure (network, timeout, checksum) is reported as
 * itself, never hidden behind the fallback. Anonymous URLs only.
 */
export async function fetchReleaseInstaller(
  deps: Pick<MemberFleetInstallDeps, 'downloadReleaseAsset'>,
  source: Extract<InstallSource, { kind: 'release-asset' }>,
  orchestratorVersion: string,
  opts: { allowSameCoreStable?: boolean } = {},
): Promise<FetchedReleaseInstaller> {
  const tried: string[] = [];
  for (const c of source.candidates) {
    const url = releaseFileUrl(c.tag, source.assetName);
    try {
      return { localPath: await deps.downloadReleaseAsset(url, source.assetName, orchestratorVersion), url, tag: c.tag };
    } catch (err: unknown) {
      if (err instanceof ReleaseDownloadError && (err.reason === 'release-not-found' || err.reason === 'build-mismatch')) {
        tried.push(`${c.channel} ${c.tag}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  const exactMissing = `no published release carries the ${source.assetName} installer for build ${orchestratorVersion} (tried ${tried.join('; ')})`;
  // Same-core stable fallback (never across cores): only for a suffixed build
  // whose exact build is unpublished, and only when the caller allows it (the
  // member has no apra-fleet or an older core). Accepts any build of the core
  // whose BUILD_INFO says so -- the signed stable release.
  const core = releaseTagFor(orchestratorVersion);
  if (opts.allowSameCoreStable && prereleaseTagFor(orchestratorVersion)) {
    const url = releaseFileUrl(core, source.assetName);
    try {
      const localPath = await deps.downloadReleaseAsset(url, source.assetName, core);
      return { localPath, url, tag: core, sameCoreFallback: { wantedBuild: orchestratorVersion, why: exactMissing } };
    } catch (err: unknown) {
      if (err instanceof ReleaseDownloadError && (err.reason === 'release-not-found' || err.reason === 'build-mismatch')) {
        tried.push(`same-core stable fallback ${core}: ${err.message}`);
        throw new ReleaseDownloadError('no-matching-release', `no published release carries the ${source.assetName} installer for build ${orchestratorVersion} or its core ${core} (tried ${tried.join('; ')})`);
      }
      throw err;
    }
  }
  throw new ReleaseDownloadError('no-matching-release', exactMissing);
}

/** The signed stable release installed in place of an unpublished exact build. */
export interface SameCoreFallback {
  /** The stable tag installed, e.g. v0.4.4. */
  tag: string;
  /** The orchestrator build that has no published release. */
  wantedBuild: string;
  /** Why the exact build could not be fetched. */
  why: string;
}

/** A fetched, verified installer and where it came from. */
export interface FetchedReleaseInstaller {
  localPath: string;
  url: string;
  tag: string;
  /** Set when no release carries the exact build and the signed stable
   *  release of the same core was used instead. */
  sameCoreFallback?: { wantedBuild: string; why: string };
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

/** Where the installer for the replacement ended up (or why it did not). */
export type ReplacementInstaller =
  | { staged: true; path: string }
  | { staged: false; why: string; target: string; fetchCommand?: string };

/**
 * The manual steps an OWNER runs on the member to replace an unmarked install
 * (a full install, or a member install older than the marker) with a member
 * install, which writes the marker. Every path is resolved here in JS from the
 * probed home -- no ~ or $HOME -- and quoted for the member's shell. The fleet
 * never runs these itself. Steps use the INSTALLED binary only for `uninstall`
 * (present in old installs) and the freshly STAGED current installer for the
 * install, so no flag the old binary predates is ever needed. ASCII, one line.
 */
export function buildFullInstallReplaceHint(opts: {
  home: string;
  targetOs: TargetOS;
  shell: MemberShell;
  provider: LlmProvider;
  installer: ReplacementInstaller;
}): string {
  const { home, targetOs, shell, provider, installer } = opts;
  const posix = isPosixShell(targetOs, shell);
  const q = posix ? posixQuote : psQuote;
  const j = (...parts: string[]) => memberJoin(targetOs, shell, home, ...parts);
  const data = j('.apra-fleet', 'data');
  const key = j('.apra-fleet', 'fleet.key');
  const backup = j('.apra-fleet-data.full-install.bak');
  const aside = j('.apra-fleet', 'data.replaced');
  const bin = memberBinPath(home, targetOs, shell);
  const installerPath = installer.staged ? installer.path : installer.target;
  const steps: string[] = [];
  if (!installer.staged) {
    steps.push(
      `(0) the current installer could not be staged on the member (${installer.why}); ` +
      (installer.fetchCommand
        ? `fetch it with: ${installer.fetchCommand}`
        : `download the apra-fleet installer for this platform from the release page to ${installerPath}`),
    );
  }
  steps.push(
    posix
      ? `(1) back up, including the signing key that lives outside data/: cp -R ${q(data)} ${q(backup)} && cp ${q(key)} ${q(backup + '/')}`
      : `(1) back up, including the signing key that lives outside data/: Copy-Item -Recurse -LiteralPath ${q(data)} -Destination ${q(backup)}; Copy-Item -LiteralPath ${q(key)} -Destination ${q(backup + String.fromCharCode(92))}`,
    `(2) uninstall with the INSTALLED binary (keeps data/): ${posix ? '' : '& '}${q(bin)} uninstall --force --yes`,
    posix
      ? `(3) move the old data aside (the backup stays as the rollback copy): mv ${q(data)} ${q(aside)}`
      : `(3) move the old data aside (the backup stays as the rollback copy): Move-Item -LiteralPath ${q(data)} -Destination ${q(aside)}`,
  );
  if (targetOs === 'linux') {
    const unit = j('.config', 'systemd', 'user', 'fleet-supervisor.service');
    steps.push(
      `(3b) linux only: uninstall leaves fleet-supervisor.service running with its serve.mjs deleted; stop it: ` +
      `systemctl --user stop fleet-supervisor; systemctl --user disable fleet-supervisor; mv ${q(unit)} ${q(backup + '/')}; systemctl --user daemon-reload`,
    );
  }
  steps.push(
    posix
      ? `(4) run the current installer: chmod +x ${q(installerPath)} && ${q(installerPath)} install --member --llm ${provider} --force`
      : `(4) run the current installer: & ${q(installerPath)} install --member --llm ${provider} --force`,
    '(5) on the orchestrator: update_member {member_id, fleet_install: "auto"} for every member on that Unix user (one member install per Unix user; each member self-registers its own uuid)',
  );
  return (
    'The fleet does not touch an apra-fleet install without the member-install marker (a full install, or a member install older than the marker). ' +
    `To replace it with a member install, its owner runs on the member: ${steps.join('; ')}. ` +
    `Or opt in to the fleet running these steps itself (back up data and fleet.key, uninstall, member install, self-register): update_member {member_id, fleet_install: "${REPLACE_FULL_INSTALL}"}.`
  );
}

// ---------------------------------------------------------------------------
// Opt-in full-install replacement (fleet_install "replace-full")
// ---------------------------------------------------------------------------

/** The explicit fleet_install value that lets the fleet replace an unmarked
 *  (full) install with a member install. Never implied by "auto". */
export const REPLACE_FULL_INSTALL = 'replace-full';

/** Tag the linux supervisor step prints when it moved a unit file into the backup. */
export const SUPERVISOR_MOVED_SENTINEL = '__APRA_FLEET_SUPERVISOR_MOVED__';

/** What a successful replacement removed and where the backup is. */
export interface ReplacedFullInstall {
  /** The replaced install's version. */
  previousVersion: string;
  /** Human-readable items the replacement removed or moved. */
  removed: string[];
  /** Timestamped backup directory on the member (data/ and fleet.key). */
  backupPath: string;
}

export type ReplaceStepName = 'backup' | 'uninstall' | 'supervisor' | 'move-data' | 'install';

export interface ReplaceFullInstallPlan {
  backupDir: string;
  dataAside: string;
  /** Ordered member-bound commands (already wrapped for the member's shell). */
  steps: Array<{ name: ReplaceStepName; command: string }>;
  /** Rollback commands, in order, per failed step (empty for a backup failure):
   *  data/ is left in place before step 4 completes, restored from dataAside
   *  after it, and the (possibly torn) backup copy is only a last resort. */
  rollbackFor: Record<ReplaceStepName | 'verify', string[]>;
}

/** Path-safe UTC stamp (no ':'): 20261006T143000Z. */
export function replaceBackupStamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

/**
 * The member-bound command sequence of the opt-in replacement (pure; exported
 * for tests). Every path is resolved here from the probed home and quoted for
 * the member's shell; PowerShell is wrapped via -EncodedCommand. Steps:
 *   backup     -- copy data/ and fleet.key (outside data/) into a timestamped dir;
 *   uninstall  -- the INSTALLED binary's own uninstall --force --yes;
 *   supervisor -- linux: stop/disable the fleet-supervisor user unit when its
 *                 unit file exists, move the file into the backup, daemon-reload
 *                 (uninstall leaves it running);
 *   move-data  -- move data/ aside;
 *   install    -- the staged CURRENT installer in member mode.
 * Self-registration and the per-folder MCP entry follow in the probe.
 */
export function buildReplaceFullInstallPlan(opts: {
  home: string;
  targetOs: TargetOS;
  shell: MemberShell;
  provider: LlmProvider;
  installerPath: string;
  stamp: string;
}): ReplaceFullInstallPlan {
  const { home, targetOs, shell, provider, installerPath, stamp } = opts;
  const posix = isPosixShell(targetOs, shell);
  const j = (...parts: string[]) => memberJoin(targetOs, shell, home, ...parts);
  const data = j('.apra-fleet', 'data');
  const key = j('.apra-fleet', 'fleet.key');
  const bin = memberBinPath(home, targetOs, shell);
  const backupDir = j(`.apra-fleet-replace-backup-${stamp}`);
  const backupData = memberJoin(targetOs, shell, backupDir, 'data');
  const backupKey = memberJoin(targetOs, shell, backupDir, 'fleet.key');
  const dataAside = j('.apra-fleet', `data.replaced-${stamp}`);
  const unitName = 'fleet-supervisor.service';
  const unit = j('.config', 'systemd', 'user', unitName);
  const backupUnit = memberJoin(targetOs, shell, backupDir, unitName);
  const q = posix ? posixQuote : psQuote;
  // PowerShell steps run inside wrapPowerShellEncoded, which sets
  // $ErrorActionPreference = 'Stop' and exits non-zero on an error or a native
  // non-zero $LASTEXITCODE: a failed copy, move or uninstall is a failed step.
  const cmd = (posixForm: string, psForm: string) => memberCommandFor(targetOs, shell, { posix: posixForm, powershell: psForm });

  const steps: ReplaceFullInstallPlan['steps'] = [
    {
      name: 'backup',
      command: cmd(
        `mkdir -p ${q(backupDir)} && cp -R ${q(data)} ${q(backupData)} && if [ -f ${q(key)} ]; then cp ${q(key)} ${q(backupKey)}; fi`,
        `New-Item -ItemType Directory -Force -Path ${q(backupDir)} | Out-Null; Copy-Item -Recurse -LiteralPath ${q(data)} -Destination ${q(backupData)}; if (Test-Path -LiteralPath ${q(key)} -PathType Leaf) { Copy-Item -LiteralPath ${q(key)} -Destination ${q(backupKey)} }`,
      ),
    },
    {
      name: 'uninstall',
      command: cmd(
        `${q(bin)} uninstall --force --yes`,
        `& ${q(bin)} uninstall --force --yes`,
      ),
    },
  ];
  if (targetOs === 'linux' && posix) {
    steps.push({
      name: 'supervisor',
      command:
        `if [ -f ${q(unit)} ]; then systemctl --user stop fleet-supervisor || true; systemctl --user disable fleet-supervisor || true; ` +
        `mv ${q(unit)} ${q(backupUnit)} && printf '%s\\n' '${SUPERVISOR_MOVED_SENTINEL}' && (systemctl --user daemon-reload || true); fi`,
    });
  }
  steps.push(
    {
      name: 'move-data',
      command: cmd(`mv ${q(data)} ${q(dataAside)}`, `Move-Item -LiteralPath ${q(data)} -Destination ${q(dataAside)}`),
    },
    { name: 'install', command: buildInstallCommand(installerPath, provider, targetOs, shell) },
  );

  // The rollback depends on how far the replacement got. Before step 4 completed
  // the in-place data/ is intact (uninstall keeps it) and must NOT be replaced by
  // the backup, which was copied while the old server was still running and may
  // be torn. From step 5 on, data/ was moved aside AFTER the server stopped, so
  // that consistent copy is the source; the backup is a last resort used only
  // when the aside copy is gone.
  const unitRestore = targetOs === 'linux' && posix
    ? [`if [ -f ${q(backupUnit)} ]; then mkdir -p ${q(j('.config', 'systemd', 'user'))} && mv ${q(backupUnit)} ${q(unit)} && systemctl --user daemon-reload && systemctl --user enable --now fleet-supervisor; fi`]
    : [];
  const reinstall = posix
    ? `chmod +x ${q(installerPath)} && ${q(installerPath)} install --llm ${provider} --force`
    : `& ${q(installerPath)} install --llm ${provider} --force`;
  const keyRestoreIfMissing = posix
    ? `if [ ! -f ${q(key)} ] && [ -f ${q(backupKey)} ]; then cp ${q(backupKey)} ${q(key)}; fi`
    : `if (-not (Test-Path -LiteralPath ${q(key)} -PathType Leaf) -and (Test-Path -LiteralPath ${q(backupKey)} -PathType Leaf)) { Copy-Item -LiteralPath ${q(backupKey)} -Destination ${q(key)} }`;
  const dataInPlace: string[] = [keyRestoreIfMissing, ...unitRestore, reinstall];
  const dataFromAside: string[] = [
    posix
      ? `if [ -d ${q(dataAside)} ]; then rm -rf ${q(data)} && mv ${q(dataAside)} ${q(data)}; else rm -rf ${q(data)} && cp -R ${q(backupData)} ${q(data)}; fi`
      : `if (Test-Path -LiteralPath ${q(data)}) { Remove-Item -Recurse -Force -LiteralPath ${q(data)} }; if (Test-Path -LiteralPath ${q(dataAside)}) { Move-Item -LiteralPath ${q(dataAside)} -Destination ${q(data)} } else { Copy-Item -Recurse -LiteralPath ${q(backupData)} -Destination ${q(data)} }`,
    keyRestoreIfMissing,
    ...unitRestore,
    reinstall,
  ];
  const rollbackFor: ReplaceFullInstallPlan['rollbackFor'] = {
    backup: [],
    uninstall: dataInPlace,
    supervisor: dataInPlace,
    'move-data': dataInPlace,
    install: dataFromAside,
    verify: dataFromAside,
  };
  return { backupDir, dataAside, steps, rollbackFor };
}

const REPLACE_STEP_LABEL: Record<ReplaceStepName, string> = {
  backup: 'step 1 (back up data and fleet.key)',
  uninstall: 'step 2 (uninstall with the installed binary)',
  supervisor: 'step 3 (stop and disable the fleet-supervisor user unit)',
  'move-data': 'step 4 (move data aside)',
  install: 'step 5 (run the current installer in member mode)',
};

/**
 * Replace an unmarked (full) install at `binPath` with a member install. The
 * caller has already established: the opt-in was given, an apra-fleet install
 * runs there, and the marker probe answered cleanly "absent". The installer is
 * fetched and staged BEFORE anything destructive, so a download, checksum or
 * transfer failure leaves the install untouched. Never throws.
 */
async function replaceFullInstall(
  agent: Agent,
  deps: MemberFleetInstallDeps,
  home: string,
  binPath: string,
  previousVersion: string,
  ctx: InstallCtx = {},
): Promise<MemberFleetInstallResult> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const provider: LlmProvider = agent.llmProvider ?? 'claude';
  const orchestratorVersion = deps.orchestratorVersion();
  const untouched = (reason: FleetInstallUnavailableReason, detail: string): MemberFleetInstallResult => ({
    state: 'unavailable', reason, detail: `${detail}; the full install was not replaced and nothing on the member was changed`, version: previousVersion,
  });

  const arch = await probeMemberArch(agent, deps);
  ctx.arch = arch;
  if (!arch) return untouched('arch-unknown', 'the member CPU architecture could not be probed');
  const source = chooseInstallSource({ os: targetOs, arch }, deps.orchestratorPlatform(), deps.orchestratorExecutable(), orchestratorVersion);
  if (source.kind === 'unavailable') return untouched(source.reason, source.detail);

  let localPath: string;
  let downloaded = false;
  let sameCoreFallback: SameCoreFallback | undefined;
  if (source.kind === 'orchestrator-executable') {
    localPath = source.localPath;
  } else {
    try {
      // Same-core stable fallback only when the replaced install is an older core.
      const fetched = await fetchReleaseInstaller(deps, source, orchestratorVersion, { allowSameCoreStable: isOlderThan(previousVersion, orchestratorVersion) });
      localPath = fetched.localPath;
      sameCoreFallback = fetched.sameCoreFallback ? { tag: fetched.tag, ...fetched.sameCoreFallback } : undefined;
      downloaded = true;
    } catch (err: unknown) {
      return untouched(downloadFailureReason(err), err instanceof Error ? err.message : String(err));
    }
  }
  const stagingDir = memberStagingDir(home, targetOs, shell);
  try {
    const sent = await deps.transfer(agent, [localPath], stagingDir);
    if (sent.failed.length > 0 || sent.success.length === 0) {
      return untouched('transfer-failed', sent.failed.map(f => `${f.path}: ${f.error}`).join('; ') || 'nothing was transferred');
    }
  } finally {
    if (downloaded) deps.removeLocal(localPath);
  }
  const installerPath = memberJoin(targetOs, shell, stagingDir, anyBasename(localPath));

  const stamp = replaceBackupStamp(deps.now ? deps.now() : new Date());
  const plan = buildReplaceFullInstallPlan({ home, targetOs, shell, provider, installerPath, stamp });
  let supervisorMoved = false;
  const failedAt = (name: ReplaceStepName | 'verify', why: string): MemberFleetInstallResult => {
    const label = name === 'verify' ? 'the version check after step 5' : REPLACE_STEP_LABEL[name];
    const detail = name === 'backup'
      ? `replacing the full install failed at ${label}: ${why}. Nothing was removed; the apra-fleet ${previousVersion} full install is unchanged`
      : `replacing the full install failed at ${label}: ${why}. The backup is at ${plan.backupDir}. To roll back, run on the member: ${plan.rollbackFor[name].join('; ')}`;
    return { state: 'unavailable', reason: 'replace-failed', detail, version: previousVersion };
  };
  let standalone: string | undefined;
  for (const step of plan.steps) {
    let r: SSHExecResult;
    try {
      r = await deps.exec(agent, step.command, step.name === 'install' || step.name === 'uninstall' ? INSTALL_TIMEOUT_MS : MEMBER_CALL_TIMEOUT_MS);
    } catch (err: unknown) {
      return failedAt(step.name, err instanceof Error ? err.message : String(err));
    }
    if (r.code !== 0) {
      return failedAt(step.name, `exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).slice(-400)}`);
    }
    if (step.name === 'supervisor' && r.stdout.includes(SUPERVISOR_MOVED_SENTINEL)) supervisorMoved = true;
    if (step.name === 'install') standalone = standaloneReason(`${r.stdout}\n${r.stderr}`);
  }

  const after = await probeMemberFleetVersion(agent, binPath, deps);
  if (after.kind !== 'installed' || isMemberOutdated(after.version, orchestratorVersion, !sameCoreFallback && sourceSuppliesBuild(source, orchestratorVersion))) {
    const seen = after.kind === 'installed' ? `reports ${after.version}` : after.kind === 'probe-failed' ? after.detail : after.kind;
    return failedAt('verify', `after install the member ${seen}; expected >= ${orchestratorVersion}`);
  }
  const removed = [
    `the apra-fleet ${previousVersion} full install (uninstalled with its own binary)`,
    ...(supervisorMoved ? [`the fleet-supervisor user unit (stopped, disabled, unit file moved into the backup)`] : []),
    `its data directory (moved aside to ${plan.dataAside})`,
  ];
  return {
    state: 'available', version: after.version, installed: true, source: source.kind, binPath,
    replaced: { previousVersion, removed, backupPath: plan.backupDir },
    ...(sameCoreFallback ? { sameCoreFallback } : {}),
    ...(standalone !== undefined ? { standalone } : {}),
  };
}

/**
 * Stage the orchestrator's installer on the member (same staging dir and
 * source logic as an upgrade) so the replacement hint can name a path that
 * exists. When `stage` is false nothing is transferred or downloaded. A failure
 * never throws: it is returned so the hint names it and gives the download
 * command for the platform instead.
 */
async function stageReplacementInstaller(
  agent: Agent,
  deps: MemberFleetInstallDeps,
  home: string,
  source: InstallSource | null,
  stage: boolean,
): Promise<ReplacementInstaller> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const stagingDir = memberStagingDir(home, targetOs, shell);
  const fallbackTarget = memberJoin(targetOs, shell, stagingDir, binaryNameFor(targetOs));
  // The release-asset download for THIS member's platform, whatever the staging
  // source was: it is what the owner runs when staging did not leave an
  // installer on the member (and on the status-only path).
  const releaseFetch = async (): Promise<{ target: string; fetchCommand: string } | null> => {
    const arch = await probeMemberArch(agent, deps);
    const assetName = arch ? releaseAssetNameFor({ os: targetOs, arch }) : null;
    if (!assetName) return null;
    const url = releaseAssetUrl(deps.orchestratorVersion(), assetName);
    const target = memberJoin(targetOs, shell, stagingDir, assetName);
    const fetchCommand = isPosixShell(targetOs, shell)
      ? `mkdir -p ${posixQuote(stagingDir)} && curl -fL -o ${posixQuote(target)} ${posixQuote(url)}`
      : `New-Item -ItemType Directory -Force -Path ${psQuote(stagingDir)} | Out-Null; Invoke-WebRequest -Uri ${psQuote(url)} -OutFile ${psQuote(target)}`;
    return { target, fetchCommand };
  };
  const notStaged = async (why: string, dflt: string): Promise<ReplacementInstaller> => {
    const f = await releaseFetch().catch(() => null);
    return f ? { staged: false, why, target: f.target, fetchCommand: f.fetchCommand } : { staged: false, why, target: dflt };
  };
  try {
    if (!source) {
      const arch = await probeMemberArch(agent, deps);
      if (!arch) return { staged: false, why: 'the member CPU architecture could not be probed', target: fallbackTarget };
      const chosen = chooseInstallSource({ os: targetOs, arch }, deps.orchestratorPlatform(), deps.orchestratorExecutable(), deps.orchestratorVersion());
      if (chosen.kind === 'unavailable') return { staged: false, why: chosen.detail, target: fallbackTarget };
      source = chosen;
    }
    const baseName = source.kind === 'release-asset' ? source.assetName : anyBasename(source.localPath);
    const target = memberJoin(targetOs, shell, stagingDir, baseName);
    if (!stage) return notStaged('not staged by this check; run update_member with fleet_install "auto" to stage it', target);
    let localPath: string;
    let downloaded = false;
    if (source.kind === 'orchestrator-executable') {
      localPath = source.localPath;
    } else {
      try {
        localPath = (await fetchReleaseInstaller(deps, source, deps.orchestratorVersion())).localPath;
        downloaded = true;
      } catch (err: unknown) {
        return notStaged(`download failed: ${err instanceof Error ? err.message : String(err)}`, target);
      }
    }
    try {
      const sent = await deps.transfer(agent, [localPath], stagingDir);
      if (sent.failed.length > 0 || sent.success.length === 0) {
        const why = sent.failed.map(f => `${f.path}: ${f.error}`).join('; ') || 'nothing was transferred';
        return notStaged(`transfer failed: ${why}`, target);
      }
    } finally {
      if (downloaded) deps.removeLocal(localPath);
    }
    return { staged: true, path: target };
  } catch (err: unknown) {
    return notStaged(err instanceof Error ? err.message : String(err), fallbackTarget);
  }
}

/** The member-install marker on the member: <home>/.apra-fleet/data/member-install.json
 *  (written by `install --member`, cleared by a full install; see
 *  src/cli/install-guard.ts writeMemberInstallMarker). Built in JS from the
 *  probed home. */
export function memberInstallMarkerPathFor(home: string, agent: Agent): string {
  const targetOs = getAgentOS(agent) as TargetOS;
  return joinMemberPath(home, '.apra-fleet/data/member-install.json', targetOs === 'windows', getAgentShell(agent));
}

/** Outcome of the member-install marker probe: three-way, never a boolean. */
export type MemberMarkerProbe =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'probe-failed'; detail: string };

/**
 * Probe whether the member's apra-fleet install carries the member-install
 * marker, i.e. it is a member install the fleet may manage and self-register
 * into.
 *
 * The marker is the SOLE fleet-ownership signal. An install without it is
 * either a human full install or a member install made before the marker
 * existed; nothing on the member tells the two apart (both may hold a LOCAL
 * registry entry for this member's uuid, because builds before this rule
 * self-registered into any install), so the fleet treats both as not its own:
 * it never self-registers into them and never sends --force-stop-full-install.
 *
 * Three outcomes: present (exit 0), cleanly absent (`test -f` / Test-Path exit
 * 1) and probe-failed (a timeout or transport error, or any other non-zero
 * exit such as 126/127/255) with the reason. A probe failure is never read as
 * "absent": a slow or flaky member is not an unowned one. Never throws.
 */
export async function probeMemberInstallMarker(
  agent: Agent,
  home: string,
  deps: Pick<MemberFleetInstallDeps, 'exec'>,
): Promise<MemberMarkerProbe> {
  const posix = isPosixShell(getAgentOS(agent) as TargetOS, getAgentShell(agent));
  const markerPath = memberInstallMarkerPathFor(home, agent);
  const cmd = posix ? memberFileExistsPosixCommand(markerPath) : memberFileExistsPwshCommand(markerPath);
  let r: SSHExecResult;
  try {
    r = await deps.exec(agent, cmd, PROBE_TIMEOUT_MS);
  } catch (err: unknown) {
    return { kind: 'probe-failed', detail: `the member-install marker probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (r.code === 0) return { kind: 'present' };
  if (r.code === 1) return { kind: 'absent' };
  return { kind: 'probe-failed', detail: `the member-install marker probe exited ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
}

/**
 * Ensure a REMOTE member runs an apra-fleet at least as new as this
 * orchestrator, installed in HTTP member mode. Never throws: every failure is a
 * typed `unavailable(<reason>)` result so the caller's registration proceeds.
 */
export async function ensureMemberFleetInstall(
  agent: Agent,
  deps: MemberFleetInstallDeps = defaultMemberFleetInstallDeps(),
  opts: { force?: boolean; replaceFull?: boolean } = {},
): Promise<MemberFleetInstallResult> {
  const ctx: InstallCtx = {};
  let r: MemberFleetInstallResult;
  try {
    r = await ensureOnce(agent, deps, opts.force === true, opts.replaceFull === true, ctx);
  } catch (err: unknown) {
    r = { state: 'unavailable', reason: 'probe-failed', detail: `install flow threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (r.state === 'unavailable' && !r.manualSteps) {
    let manualSteps: string;
    try {
      manualSteps = buildManualInstallSteps({
        home: ctx.home ?? null,
        targetOs: getAgentOS(agent) as TargetOS,
        shell: getAgentShell(agent),
        provider: agent.llmProvider ?? 'claude',
        arch: ctx.arch ?? null,
        orchestratorVersion: deps.orchestratorVersion(),
        reason: r.reason,
      });
    } catch (err: unknown) {
      manualSteps = `could not build the manual steps: ${err instanceof Error ? err.message : String(err)}`;
    }
    r = { ...r, manualSteps };
  }
  return r;
}

/** What the install flow learned about the member, for the manual steps. */
interface InstallCtx {
  home?: string;
  arch?: MemberArch | null;
}

/**
 * The exact steps an owner runs ON THE MEMBER to install this orchestrator's
 * build by hand when the fleet could not (pure; exported for tests). Built in
 * JS for the member's OS/shell from the probed home -- no ~, $HOME or other
 * shell expansion -- with every path and URL quoted. The download is the
 * anonymous release URL the fleet itself tried first (no GitHub account
 * needed); the SHA-256 check uses the release's SHA256SUMS (sha256sum on
 * linux and Git Bash, shasum -a 256 on macOS, Get-FileHash in PowerShell).
 * ASCII; one step per line.
 */
export function buildManualInstallSteps(opts: {
  home: string | null;
  targetOs: TargetOS;
  shell: MemberShell;
  provider: LlmProvider;
  arch: MemberArch | null;
  orchestratorVersion: string;
  reason: FleetInstallUnavailableReason;
}): string {
  const { home, targetOs, shell, provider, arch, orchestratorVersion, reason } = opts;
  const finish = 'then on the orchestrator run update_member {member_id, fleet_install: "auto"} so the fleet self-registers the member into that install and verifies it';
  if (reason === 'full-install-running' || reason === 'replace-failed') {
    return `follow the owner steps in the reason above, ${finish}.`;
  }
  if (!home || reason === 'home-unresolved' || reason === 'probe-failed') {
    return `make the member reachable (member_detail shows its connectivity and the error), ${finish}.`;
  }
  const asset = arch ? releaseAssetNameFor({ os: targetOs, arch }) : null;
  const pre = prereleaseTagFor(orchestratorVersion);
  // A dev/branch build's installer lives in its exact-build prerelease; a
  // released build's in the stable release (its BUILD_INFO names the build,
  // and its Windows installer is signed), noted below.
  const stableTag = releaseTagFor(orchestratorVersion);
  const tag = pre ?? stableTag;
  const args = memberInstallArgs(provider);
  if (!asset) {
    return [
      arch
        ? `no apra-fleet installer is published for ${targetOs}/${arch}; build it from source on the member:`
        : `the member CPU architecture could not be probed; pick the installer for its OS/arch from ${releasePageUrl(tag)}, or build it from source on the member:`,
      `(1) git clone https://github.com/${RELEASE_REPO}.git and check out ${pre ? `commit ${buildSuffixOf(pre)}` : `tag ${tag}`}, then npm install && npm run build:binary`,
      `(2) run the built installer (dist/apra-fleet-installer-*) with: ${args.join(' ')}`,
      `(3) ${finish}.`,
    ].join('\n');
  }
  const posix = isPosixShell(targetOs, shell);
  const q = posix ? posixQuote : psQuote;
  const staging = memberStagingDir(home, targetOs, shell);
  const file = memberJoin(targetOs, shell, staging, asset);
  const sums = memberJoin(targetOs, shell, staging, CHECKSUM_ASSET);
  const url = releaseFileUrl(tag, asset);
  const sumsUrl = releaseFileUrl(tag, CHECKSUM_ASSET);
  const lines: string[] = [];
  if (reason === 'no-matching-release') {
    lines.push(
      `no release for build ${orchestratorVersion} is published yet${pre ? ` (prereleases exist only for builds pushed to the release branches, newest 3 per branch)` : ''}; ` +
      `either run the orchestrator from a published build (${`https://github.com/${RELEASE_REPO}/releases`}) and re-run update_member, or build ${asset} from source ` +
      `(${pre ? `commit ${buildSuffixOf(pre)}` : `tag ${tag}`}: npm install && npm run build:binary) and copy it to ${file}, skip steps 1-2, and continue at step 3. ` +
      `Once ${releasePageUrl(tag)} exists, steps 1-4 install it:`,
    );
  } else {
    lines.push(`install apra-fleet ${orchestratorVersion} from ${releasePageUrl(tag)} (anonymous download, no GitHub account needed):`);
  }
  if (pre) {
    lines.push(`(if ${releaseFileUrl(stableTag, BUILD_INFO_ASSET)} names version=${orchestratorVersion}, this orchestrator is a released build: use tag ${stableTag} instead of ${pre} in the URLs below -- its Windows installer is signed)`);
  }
  if (posix) {
    const shaTool = targetOs === 'macos' ? 'shasum -a 256 -c -' : 'sha256sum -c -';
    lines.push(
      `(1) download: mkdir -p ${q(staging)} && curl -fL -o ${q(file)} ${q(url)} && curl -fL -o ${q(sums)} ${q(sumsUrl)}`,
      `(2) verify the SHA-256 (must print OK): cd ${q(staging)} && grep ${q(` ${asset}`)} ${q(CHECKSUM_ASSET)} | ${shaTool}`,
      `(3) install in member mode: chmod +x ${q(file)} && ${q(file)} ${args.map(q).join(' ')}`,
    );
  } else {
    lines.push(
      // $ProgressPreference / $h / $line are PowerShell variables the owner's
      // own session sets and reads; no path or value depends on expansion.
      `(1) download: $ProgressPreference = 'SilentlyContinue'; New-Item -ItemType Directory -Force -Path ${q(staging)} | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ${q(url)} -OutFile ${q(file)}; Invoke-WebRequest -UseBasicParsing -Uri ${q(sumsUrl)} -OutFile ${q(sums)}`,
      `(2) verify the SHA-256 (throws on a mismatch; do not run the installer then): $h = (Get-FileHash -Algorithm SHA256 -LiteralPath ${q(file)}).Hash.ToLower(); $line = (Select-String -LiteralPath ${q(sums)} -SimpleMatch ${q(` ${asset}`)} | Select-Object -First 1).Line; if (-not $line -or ($line -split '\\s+')[0].ToLower() -ne $h) { throw ${q(`SHA-256 mismatch for ${asset}: do not run it`)} } else { 'OK' }`,
      `(3) install in member mode: & ${q(file)} ${args.map(q).join(' ')}`,
    );
  }
  lines.push(`(4) ${finish}.`);
  return lines.join('\n');
}

/**
 * The prominent WARNING register_member / update_member print when a
 * requested apra-fleet install/upgrade on the member did not happen, or null
 * when there is nothing to warn about. Names (a) the consequence, (b) the
 * exact reason and (c) the manual steps. The tool call itself succeeds. ASCII.
 */
export function fleetInstallWarning(memberName: string, status: FleetMcpStatus): string | null {
  if (!status.manualInstall && status.sameCoreFallback) {
    const f = status.sameCoreFallback;
    return [
      `NOTICE: member "${memberName}" got apra-fleet from the same-core stable release: installed signed stable ${f.tag}${status.version ? ` (${status.version})` : ''}, not the exact build ${f.wantedBuild}.`,
      `  Why: ${f.why}`,
      '  KB/code tools work on that build; to get the exact build, publish it (or run the orchestrator from a published build) and run update_member {member_id, fleet_install: "auto"} again.',
    ].join('\n');
  }
  if (!status.manualInstall) return null;
  const reason = status.installFailure?.reason ?? status.reason ?? 'unknown';
  const detail = status.installFailure?.detail ?? status.detail;
  const consequence = status.state === 'available'
    ? `the member keeps its installed apra-fleet ${status.version ?? '(unknown version)'} instead of this orchestrator's build, so its KB/code tools run on that build until it is updated. Nothing else is affected.`
    : 'the member will not get the KB/code tools (kb_*, code_*) of its own apra-fleet. That is the only consequence: the member works for everything else.';
  const indent = (s: string) => s.split('\n').map(l => `    ${l}`).join('\n');
  return [
    `WARNING: apra-fleet on member "${memberName}" was not installed/updated to this orchestrator's build.`,
    `  Consequence: ${consequence}`,
    `  Reason: ${reason}${detail ? ` -- ${detail}` : ''}`,
    '  Manual steps on the member:',
    indent(status.manualInstall),
  ].join('\n');
}

async function ensureOnce(agent: Agent, deps: MemberFleetInstallDeps, force: boolean, replaceFull = false, ctx: InstallCtx = {}): Promise<MemberFleetInstallResult> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const provider: LlmProvider = agent.llmProvider ?? 'claude';
  const orchestratorVersion = deps.orchestratorVersion();

  const home = await deps.resolveHome(agent);
  if (home) ctx.home = home;
  if (!home) {
    return { state: 'unavailable', reason: 'home-unresolved', detail: 'the member home directory could not be probed' };
  }
  const binPath = memberBinPath(home, targetOs, shell);

  const before = await probeMemberFleetVersion(agent, binPath, deps);
  if (before.kind === 'probe-failed') {
    return { state: 'unavailable', reason: 'probe-failed', detail: before.detail };
  }
  // Opt-in replacement (fleet_install "replace-full"): decided BEFORE the
  // up-to-date gates, so a same-version full install is replaced too. Only a
  // clean "absent" marker answer on a working install replaces; a probe failure
  // refuses with no destructive command; a marked install takes the normal
  // upgrade path below.
  if (replaceFull && before.kind === 'installed') {
    const marker = await probeMemberInstallMarker(agent, home, deps);
    if (marker.kind === 'probe-failed') {
      return { state: 'unavailable', reason: 'probe-failed', detail: `${marker.detail}; the opt-in full-install replacement was not run`, version: before.version };
    }
    if (marker.kind === 'absent') return replaceFullInstall(agent, deps, home, binPath, before.version, ctx);
  }
  // Pre-gate: only a strictly older core is outdated for certain; a same-core
  // build difference is decided below once the install source is known.
  if (!force && before.kind === 'installed' && !isMemberOutdated(before.version, orchestratorVersion, true)) {
    return { state: 'available', version: before.version, installed: false, binPath };
  }
  const priorVersion = before.kind === 'installed' ? before.version : undefined;
  const coreOutdated = before.kind !== 'installed' || isOlderThan(before.version, orchestratorVersion);

  const arch = await probeMemberArch(agent, deps);
  ctx.arch = arch;
  if (!arch && !force && !coreOutdated && before.kind === 'installed') {
    // Build-only difference and no way to tell the source: leave it alone.
    return { state: 'available', version: before.version, installed: false, binPath };
  }
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
    if (!force && !coreOutdated && before.kind === 'installed') {
      // Build-only difference and the orchestrator cannot supply its build.
      return { state: 'available', version: before.version, installed: false, binPath };
    }
    return { state: 'unavailable', reason: source.reason, detail: source.detail, version: priorVersion };
  }
  if (
    !force && !coreOutdated && before.kind === 'installed' &&
    !isMemberOutdated(before.version, orchestratorVersion, sourceSuppliesBuild(source, orchestratorVersion))
  ) {
    // Same core, release-asset source: same core = up to date.
    return { state: 'available', version: before.version, installed: false, binPath };
  }
  // An existing install without the member-install marker is never installed
  // over: it may be a human full install whose server is simply not running
  // (no refusal would fire), and installing --member over it would hand it to
  // the fleet. Only a missing install, or a marked one, is (re)installed.
  if (before.kind !== 'missing') {
    const marker = await probeMemberInstallMarker(agent, home, deps);
    // A probe failure is never "a full install is present": report it as such.
    if (marker.kind === 'probe-failed') {
      return { state: 'unavailable', reason: 'probe-failed', detail: marker.detail, version: priorVersion };
    }
    if (marker.kind === 'absent') {
      const installer = await stageReplacementInstaller(agent, deps, home, source, true);
      return {
        state: 'unavailable',
        reason: 'full-install-running',
        detail: `the apra-fleet at ${binPath} has no member-install marker, so the fleet did not install over it. ${buildFullInstallReplaceHint({ home, targetOs, shell, provider, installer })}`,
        version: priorVersion,
      };
    }
  }

  let localPath: string;
  let downloaded = false;
  let sameCoreFallback: SameCoreFallback | undefined;
  let standalone: string | undefined;
  if (source.kind === 'orchestrator-executable') {
    localPath = source.localPath;
  } else {
    try {
      // The same-core stable fallback only when the member has no apra-fleet or
      // an older core: a signed stable build of the core beats nothing.
      const fetched = await fetchReleaseInstaller(deps, source, orchestratorVersion, { allowSameCoreStable: coreOutdated });
      localPath = fetched.localPath;
      sameCoreFallback = fetched.sameCoreFallback ? { tag: fetched.tag, ...fetched.sameCoreFallback } : undefined;
      downloaded = true;
    } catch (err: unknown) {
      return {
        state: 'unavailable',
        reason: downloadFailureReason(err),
        detail: err instanceof Error ? err.message : String(err),
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
      // A refusal means the running server has no member-install marker: a
      // human full install or an unmarked older member install. The fleet
      // never overrides it (see probeMemberInstallMarker); only the owner can.
      if (`${run.stdout}\n${run.stderr}`.includes(FULL_INSTALL_RUNNING_CODE)) {
        return {
          state: 'unavailable',
          reason: 'full-install-running',
          detail: `a running apra-fleet server on the member was not started by a member install and was left running: ${tail}. ${buildFullInstallReplaceHint({ home, targetOs, shell, provider, installer: { staged: true, path: installerPath } })}`,
          version: priorVersion,
        };
      }
      return { state: 'unavailable', reason: 'install-failed', detail: `installer exited ${run.code}: ${tail}`, version: priorVersion };
    }
    standalone = standaloneReason(`${run.stdout}\n${run.stderr}`);
  } finally {
    if (downloaded) deps.removeLocal(localPath);
  }

  const after = await probeMemberFleetVersion(agent, binPath, deps);
  if (after.kind !== 'installed' || isMemberOutdated(after.version, orchestratorVersion, !sameCoreFallback && sourceSuppliesBuild(source, orchestratorVersion))) {
    const seen = after.kind === 'installed' ? `reports ${after.version}` : after.kind === 'probe-failed' ? after.detail : after.kind;
    return {
      state: 'unavailable',
      reason: 'install-unverified',
      detail: `after install the member ${seen}; expected >= ${orchestratorVersion}`,
      version: priorVersion,
    };
  }
  return {
    state: 'available', version: after.version, installed: true, source: source.kind, binPath,
    ...(sameCoreFallback ? { sameCoreFallback } : {}),
    ...(standalone !== undefined ? { standalone } : {}),
  };
}

/** The MEMBER-STANDALONE line an installer printed (its text after the code),
 *  or undefined when the install registered a service. */
function standaloneReason(out: string): string | undefined {
  const at = out.indexOf(MEMBER_STANDALONE_CODE);
  if (at < 0) return undefined;
  const rest = out.slice(at + MEMBER_STANDALONE_CODE.length).replace(/^[:\s]+/, '');
  return rest.split(/\r?\n\s*\r?\n/)[0].replace(/\s+/g, ' ').trim() || 'no user-mode service manager is usable on the member';
}

// ---------------------------------------------------------------------------
// Standalone server on a member with no service manager
// ---------------------------------------------------------------------------

/** How long the member's `apra-fleet start` waits for /health before giving up. */
export const MEMBER_START_HEALTH_TIMEOUT_MS = 30_000;
/** Exec budget for the start command: its own health wait plus slack. */
const MEMBER_START_EXEC_TIMEOUT_MS = MEMBER_START_HEALTH_TIMEOUT_MS + 30_000;

/** Pidfile of a standalone server the fleet started: <home>/.apra-fleet/data/standalone.pid. */
export function memberStandalonePidPath(home: string, targetOs: TargetOS, shell: MemberShell): string {
  return memberJoin(targetOs, shell, home, '.apra-fleet', 'data', 'standalone.pid');
}

/**
 * The member command that starts its apra-fleet server when it is down
 * (exported for tests). It runs the member's own `apra-fleet start`, which is
 * idempotent ("already running" exits 0), goes through a registered service
 * when one works, and otherwise spawns the server DETACHED in its own session
 * (setsid via a detached spawn) with stdio appended to the server log
 * (<data dir>/fleet.log), writing its pid to `pidPath`. On POSIX members it
 * also runs under nohup with stdin from /dev/null, so the start survives the
 * SSH session even if that ends mid-start. `--autostart` keeps a deliberate
 * `apra-fleet stop` on the member in force (start refuses, naming it);
 * `--timeout-ms` lets start wait for /health and print the server log tail
 * when it never answers. Built in JS for the member OS/shell from resolved
 * paths: no shell variable expansion.
 */
export function buildMemberStartCommand(binPath: string, pidPath: string, targetOs: TargetOS, shell: MemberShell): string {
  const args = ['start', '--autostart', '--pidfile', pidPath, '--timeout-ms', String(MEMBER_START_HEALTH_TIMEOUT_MS)];
  // nohup exists on every POSIX member (coreutils, busybox, macOS); Git Bash on
  // Windows has no SIGHUP to guard against, and its nohup is not guaranteed.
  const nohup = targetOs === 'windows' ? '' : 'nohup ';
  return memberCommandFor(targetOs, shell, {
    posix: `${nohup}${posixQuote(binPath)} ${args.map(posixQuote).join(' ')} < /dev/null 2>&1`,
    powershell: `& ${psQuote(binPath)} ${args.map(psQuote).join(' ')}`,
  });
}

/** Outcome of making sure the member's server runs. */
export type MemberServerStart =
  | { ok: true; started: boolean; note?: string }
  | { ok: false; detail: string };

/**
 * Start the member's apra-fleet server when it is down, and wait for /health.
 * Never throws. A failure names the exact cause: start's own output, which
 * carries the server log tail when the server died or never answered.
 */
export async function ensureMemberServerRunning(
  agent: Agent,
  home: string,
  binPath: string,
  deps: Pick<MemberFleetInstallDeps, 'exec'>,
): Promise<MemberServerStart> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const pidPath = memberStandalonePidPath(home, targetOs, shell);
  let r: SSHExecResult;
  try {
    r = await deps.exec(agent, buildMemberStartCommand(binPath, pidPath, targetOs, shell), MEMBER_START_EXEC_TIMEOUT_MS);
  } catch (err: unknown) {
    return { ok: false, detail: `the member's apra-fleet start could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code !== 0) {
    return {
      ok: false,
      detail: `the apra-fleet server on the member is not running and '${binPath} start' failed (exit ${r.code}): ${memberErrorDetail(out) || '(no output)'}`,
    };
  }
  const m = /Server started at (\S+) pid=(\d+)/.exec(out);
  if (m) {
    return {
      ok: true, started: true,
      note: `started the apra-fleet server on the member (pid ${m[2]}, pidfile ${pidPath}); without a service manager it runs standalone and is not restarted on reboot until the next member probe`,
    };
  }
  return { ok: true, started: false };
}

/** A failed `apra-fleet call` that means "the member's server is down" (the
 *  client could not reach or auto-start it), not a session/tool failure. */
const SERVER_DOWN_RE = /\b(?:AUTOSTART_[A-Z_]+|SERVER_UNRESPONSIVE|SERVER_STOPPED_BY_USER|ECONNREFUSED)\b|no healthy apra-fleet HTTP singleton/;

/** True when a failed member call detail says the member's server is down (exported for tests). */
export function memberCallSaysServerDown(detail: string): boolean {
  return SERVER_DOWN_RE.test(detail);
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
  /** claude: the role files a `--agent <role>` dispatch loads have a tools
   *  allowlist without the member kb_* / code_* tools, so dispatched roles
   *  never see them even though the member session lists them. */
  | 'role-agents-hide-member-tools'
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
  | 'member-tools-missing'
  /** The member's apra-fleet server is down and the fleet could not start it
   *  (start failed, died during startup, never answered /health, or the
   *  member user stopped it); the detail carries the cause and log tail. */
  | 'member-server-not-running'
  /** The member install's member access secret (which its server requires on
   *  a ?member= session) could not be read, or created when missing. */
  | 'member-secret-unavailable';

/** Reasons the sprint init (not the server probe) records for providers it treats as unverified. */
export type FleetMcpProviderReason = 'no-per-tool-deny' | 'no-per-project-mcp';

/**
 * One-line operator fix per fleetMcp reason. ASCII only, no newlines. Covers
 * every FleetMcpUnavailableReason plus the provider-level reasons the sprint
 * init records (opencode: no-per-tool-deny; agy: no-per-project-mcp).
 */
export const FLEET_MCP_FIX: Record<FleetMcpUnavailableReason | FleetMcpProviderReason, string> = {
  'home-unresolved': 'Check the member is reachable and its home directory resolves, then run member_detail with refresh:true.',
  'probe-failed': 'Check the member is reachable (member_detail shows connectivity), then run member_detail with refresh:true.',
  'arch-unknown': 'Check the member shell works (uname -m / PROCESSOR_ARCHITECTURE), then run update_member with fleet_install "auto".',
  'unsupported-platform': 'Install apra-fleet on the member by hand; no release asset exists for its OS/arch.',
  'no-install-source': 'Run the orchestrator as the single-executable binary or make release assets reachable, then run update_member with fleet_install "auto".',
  'download-failed': 'Check the member/orchestrator can reach the release host, then run update_member with fleet_install "auto".',
  'download-timeout': 'The release download did not finish in time; check the network to the release host, then run update_member with fleet_install "auto".',
  'checksum-mismatch': 'The downloaded installer did not match its published SHA256SUMS; do not install it -- run update_member with fleet_install "auto" again, and report it if it repeats.',
  'checksum-unavailable': 'No published SHA256SUMS lists this installer (release missing or incomplete); publish the release assets, then run update_member with fleet_install "auto".',
  'no-matching-release': 'No published release carries an installer for this orchestrator build (no exact-build prerelease, and the stable release is a different build); install it on the member by hand with the steps in the update_member/register_member WARNING, or run the orchestrator from a published build, then run update_member with fleet_install "auto".',
  'full-install-running': 'The member apra-fleet install has no member-install marker (a full install, or a member install older than the marker), so the fleet leaves it alone; its owner replaces it with a member install using the steps in the detail (back up data and fleet.key, uninstall with the installed binary, run the staged current installer with install --member), then update_member {member_id, fleet_install: "auto"} -- or opts in to the fleet doing it with update_member {member_id, fleet_install: "replace-full"}.',
  'transfer-failed': 'Check file transfer to the member works (disk space, permissions), then run update_member with fleet_install "auto".',
  'install-failed': 'Run the apra-fleet installer on the member by hand and read its error, then member_detail with refresh:true.',
  'replace-failed': 'The full-install replacement stopped at the step named in the detail; run the rollback commands in the detail (if listed; they restore the consistent data copy, the backup only as a last resort), fix the cause, then run update_member {member_id, fleet_install: "replace-full"} again.',
  'install-unverified': 'Run update_member {member_id, fleet_install: "auto"} to upgrade apra-fleet on the member to the orchestrator version, then member_detail with refresh:true.',
  'install-too-old': 'Run update_member {member_id, fleet_install: "auto"} to upgrade apra-fleet on the member (its install predates register-member --id), then member_detail with refresh:true.',
  'E-FOLDER-TAKEN': 'The member install has this work folder registered under another id; unregister it there, then member_detail with refresh:true.',
  'register-failed': 'Run update_member {member_id, fleet_install: "auto"} to upgrade apra-fleet on the member and re-register it (read fleetMcp detail for the error), then member_detail with refresh:true.',
  'mcp-entry-missing': 'Re-run compose_permissions for the member so its per-folder apra-fleet MCP entry points at ?member=<uuid>, then member_detail with refresh:true.',
  'role-agents-hide-member-tools': 'Remote member: run update_member for it (re-provisions its role agent files); local member: the probe already tried to rewrite the role files in ~/.claude/agents, so make them writable (or re-run apra-fleet install on the orchestrator). Then member_detail with refresh:true.',
  'no-per-project-mcp': 'agy has no per-project MCP config; its roles get injected knowledge only. Use another provider for KB/code tools.',
  'provider-unsupported': 'This LLM provider has no MCP entry fleet configures; its roles get injected knowledge only.',
  'member-config-unreadable': 'Fix permissions on the member config file named in the detail, then re-run compose_permissions.',
  'member-config-unparseable': 'Make the member config file named in the detail strict JSON, then re-run compose_permissions.',
  'opencode-config-tracked': 'Untrack opencode.json from git (add it to .gitignore), then re-run compose_permissions.',
  'opencode-config-unparseable': 'Make the work folder opencode.json strict JSON (no comments), then re-run compose_permissions.',
  'member-session-failed': 'Check the member apra-fleet server is running (apra-fleet status / start on the member), then member_detail with refresh:true.',
  'member-server-not-running': 'Fix the cause in the detail (it includes the member server log tail), then run apra-fleet start on the member as the member user and member_detail with refresh:true.',
  'member-tools-missing': 'Run update_member {member_id, fleet_install: "auto"} to upgrade apra-fleet on the member so its session lists kb_* and code_* tools, then member_detail with refresh:true.',
  'member-secret-unavailable': 'Check the member access secret file named in the detail is readable by the member user (and that SFTP works on the member, which creates it), then run update_member {member_id, fleet_install: "auto"}.',
  'no-per-tool-deny': 'opencode cannot deny individual tools, so its roles get injected knowledge only. Use another provider for KB/code tools.',
};

/**
 * The one-line fix to show for a fleetMcp status, or null when the member's KB
 * and code tools are usable (available and not flagged unverified).
 */
export function fleetMcpFixLine(
  status: { state: string; reason?: string; unverified?: boolean; installFailure?: { reason: string } } | null | undefined,
): string | null {
  if (!status) return null;
  if (status.state === 'available' && !status.unverified) {
    // Usable on an older install after a failed upgrade: show the upgrade fix.
    const f = status.installFailure ? (FLEET_MCP_FIX as Record<string, string>)[status.installFailure.reason] : undefined;
    return f ?? null;
  }
  const known = status.reason ? (FLEET_MCP_FIX as Record<string, string>)[status.reason] : undefined;
  return known ?? 'Run member_detail with refresh:true after fixing the cause named in the detail; KB/code tools are unverified on this member.';
}

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
  /** Do the role files a `claude --agent <role>` dispatch loads grant the
   *  member kb_* / code_* tools? Heals what it can (local: rewrites bad role
   *  files; remote: re-provisions) and reports `healed` files. Optional:
   *  absent means not checked. */
  roleAgents?(agent: Agent): Promise<{ ok: true; healed?: string[] } | { ok: false; detail: string }>;
  /** Write the member's per-folder apra-fleet MCP entry (the compose_permissions
   *  writer). Optional: absent means the probe only checks the entry. `reason`
   *  is set when a member config could not be safely edited. */
  writeMcpEntry?(agent: Agent): Promise<{ ok: true } | { ok: false; reason?: string; detail: string }>;
  /** Stage content in a fresh owner-only file on the member (the secret-file
   *  channel); used to create a missing member access secret there. Optional:
   *  absent means a missing secret cannot be created. */
  stageSecretFile?: StageSecretFileFn;
  /** Persist the member install's access secret (encrypted) on the registry entry. */
  recordMemberSecret?(memberId: string, secret: string): void;
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
      const expectedVersion = clientExpectedVersion();
      return m.connectFleetMember(memberId, expectedVersion ? { expectedVersion } : {}) as unknown as MemberSession;
    },
    now: () => new Date(),
    record: (memberId, status) => { recordFleetMcpStatus(memberId, status); },
    roleAgents: async (agent: Agent) => {
      const m = await import('./agent-provisioner.js');
      return m.checkRoleAgentMemberTools(agent);
    },
    writeMcpEntry: async (agent: Agent) => {
      const m = await import('../tools/compose-permissions.js');
      return m.writeMemberMcpEntry(agent);
    },
    stageSecretFile: (agent: Agent, content: string) => writeMemberSecretFile(agent, content, 'member-access'),
    recordMemberSecret: (memberId: string, secret: string) => { updateAgent(memberId, { encryptedMemberMcpSecret: encryptPassword(secret) }); },
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

/**
 * Cap on member-side error text recorded in fleetMcp.detail. Large enough that
 * the leading ERROR line plus its cause (e.g. compose_permissions' full
 * searched-path list) always survive; only a runaway output is truncated.
 */
export const MEMBER_ERROR_DETAIL_MAX = 4000;

/**
 * The member-side error text to record in fleetMcp.detail. Keeps the HEAD of
 * the output (the `ERROR: ...` line and its cause come first), never the tail:
 * a tail slice drops the leading cause and leaves only the end of a long list.
 */
export function memberErrorDetail(out: string, max = MEMBER_ERROR_DETAIL_MAX): string {
  let text = out.trim();
  if (text.length <= max) return text;
  // Over the cap: start at the first ERROR line when log noise precedes it,
  // so the cap is spent on the error and its cause.
  const errAt = text.search(/^.*\bERROR\b/m);
  if (errAt > 0) text = text.slice(errAt);
  if (text.length <= max) return text;
  return `${text.slice(0, max)} ... [${text.length - max} more chars truncated]`;
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
      const key = await resolveClaudeProjectKey(exec, agent.workFolder, isWindows, posix);
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

/** Outcome of resolving the port a remote member's own install listens on. */
export type MemberPortResolution =
  | { kind: 'resolved'; port: number; source: 'marker' | 'default'; note?: string }
  | { kind: 'failed'; detail: string };

/**
 * The port a REMOTE member's own apra-fleet install listens on, resolved on
 * the member: the `port` its member-install marker
 * (<home>/.apra-fleet/data/member-install.json) records. server.json in the
 * same data dir is only advisory -- a no-op `apra-fleet start` never rewrites
 * it, so it can describe an older instance -- and a disagreement is reported
 * in `note` while the marker wins. A marker that records no port (an install
 * from before port recording) resolves to the built-in default with a note
 * saying so. Read commands carry resolved, quoted paths built here in JS (no
 * shell variable expansion). Never throws.
 */
export async function resolveMemberMcpPort(
  agent: Agent,
  home: string,
  deps: Pick<MemberFleetInstallDeps, 'exec'>,
): Promise<MemberPortResolution> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const posix = isPosixShell(targetOs, shell);
  const exec = (cmd: string, t?: number) => deps.exec(agent, cmd, t ?? PROBE_TIMEOUT_MS);
  const markerPath = memberInstallMarkerPathFor(home, agent);
  let marker: Record<string, unknown>;
  try {
    marker = await readMemberJson(exec, markerPath, posix);
  } catch (err: unknown) {
    return { kind: 'failed', detail: `the member's apra-fleet port could not be read from ${markerPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let serverPort: number | undefined;
  try {
    const info = await readMemberJson(exec, joinMemberPath(home, '.apra-fleet/data/server.json', targetOs === 'windows', shell), posix);
    serverPort = validPort(info.port);
  } catch { /* advisory only */ }
  const recorded = validPort(marker.port);
  if (recorded === undefined) {
    const seen = serverPort !== undefined && serverPort !== BUILTIN_DEFAULT_PORT ? ` (server.json there records port ${serverPort}, not used)` : '';
    return {
      kind: 'resolved', port: BUILTIN_DEFAULT_PORT, source: 'default',
      note: `the member install did not record its port in ${markerPath}, so the built-in default port ${BUILTIN_DEFAULT_PORT} is used${seen}; re-run update_member with fleet_install "auto" to record it`,
    };
  }
  if (serverPort !== undefined && serverPort !== recorded) {
    return {
      kind: 'resolved', port: recorded, source: 'marker',
      note: `the member-install marker records port ${recorded} but server.json records port ${serverPort}; using the marker's port ${recorded} (server.json may describe a stale or other instance)`,
    };
  }
  return { kind: 'resolved', port: recorded, source: 'marker' };
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
 *  - LOCAL members: no install and no per-folder entry (a claude dispatch gets
 *    the member config per session, --mcp-config). Verified by opening a
 *    MEMBER session for the uuid on this server through the client's own
 *    server resolution (registered member, version answers, kb_* / code_*
 *    listed) -- the same server and member identity the injected URL names,
 *    not a request to that literal URL or a run of the CLI with the file.
 *  - remote members: ensure the install (opts.install, default true; false
 *    only probes the version), register the member on its own install
 *    (`register-member --type local --id <uuid>`), check the per-folder MCP
 *    entry (not for claude: per-session config, the entry is only its
 *    fallback), then verify a MEMBER session through `apra-fleet call`.
 *  - claude, both: the role files `--agent <role>` loads must grant the member
 *    tools; roleAgents heals them (local rewrite, remote re-provision) first.
 */
export async function probeMemberFleetMcp(
  agent: Agent,
  deps: MemberFleetMcpDeps = defaultMemberFleetMcpDeps(),
  opts: ProbeOpts = {},
): Promise<FleetMcpStatus> {
  const ctx = { installedNow: false };
  const status = await probeMemberFleetMcpInner(agent, deps, opts, ctx);
  // Stamp fleetInstalledAt only from a successful fleet install in THIS probe;
  // otherwise carry the previously recorded value forward unchanged.
  const stamp = ctx.installedNow ? status.checkedAt : agent.fleetMcp?.fleetInstalledAt;
  const stamped = stamp ? { ...status, fleetInstalledAt: stamp } : status;
  // Local members share this orchestrator's install (its installer reports bd).
  if (agent.agentType === 'local') return stamped;
  const beads = await probeMemberBeads(agent, deps);
  return beads ? { ...stamped, beads } : stamped;
}

/** Fix line recorded with a missing/broken bd on a member. ASCII, one line. */
export const BEADS_MISSING_FIX =
  'Run update_member {member_id, fleet_install: "auto"} so the member installer puts bd in <home>/.apra-fleet/bin (or install bd on the member so bd --version works), then member_detail with refresh:true.';

/** Suffix for a register/update fleetMcp result line: names a missing bd, else ''. */
export function beadsStatusNote(status: Pick<FleetMcpStatus, 'beads'>): string {
  return status.beads ? ` -- warning: bd ${status.beads.state} on the member (${status.beads.detail}). Fix: ${status.beads.fix}` : '';
}

/** Where the member installer places bd when npm -g is not writable. */
export function memberBeadsPath(home: string, targetOs: TargetOS, shell: MemberShell): string {
  return memberJoin(targetOs, shell, home, '.apra-fleet', 'bin', targetOs === 'windows' ? 'bd.exe' : 'bd');
}

/**
 * The member-side bd probe: bd on the member's PATH first, else the member
 * install's <home>/.apra-fleet/bin copy -- the same order every fleet-built
 * member command resolves it in (BIN_DIR is appended to PATH). Tagged like
 * buildFleetVersionProbe: always exits 0, outcome in stdout.
 */
export function buildBeadsProbe(bdPath: string, targetOs: TargetOS, shell: MemberShell): string {
  const p = posixQuote(bdPath);
  const ps = psQuote(bdPath);
  return memberCommandFor(targetOs, shell, {
    posix:
      `if command -v bd >/dev/null 2>&1; then bd --version 2>/dev/null || printf '%s\\n' '${EXEC_FAILED_SENTINEL}'; ` +
      `elif [ -x ${p} ]; then ${p} --version 2>/dev/null || printf '%s\\n' '${EXEC_FAILED_SENTINEL}'; ` +
      `else printf '%s\\n' '${NO_INSTALL_SENTINEL}'; fi`,
    powershell:
      `if (Get-Command bd -ErrorAction SilentlyContinue) { $bd = 'bd' } elseif (Test-Path -LiteralPath ${ps}) { $bd = ${ps} } else { $bd = $null }; ` +
      `if ($bd) { try { $out = & $bd --version; if ($LASTEXITCODE -ne 0) { [Console]::Out.Write('${EXEC_FAILED_SENTINEL}') } ` +
      `else { [Console]::Out.Write(($out | Out-String)) } } catch { [Console]::Out.Write('${EXEC_FAILED_SENTINEL}') } } ` +
      `else { [Console]::Out.Write('${NO_INSTALL_SENTINEL}') }; exit 0`,
  });
}

/**
 * Probe bd on a remote member. Returns the `beads` field to record when bd is
 * missing or broken there, or null when it works or the probe itself could
 * not run (an unreachable member is reported by the fleetMcp status already).
 * Never throws.
 */
export async function probeMemberBeads(
  agent: Agent,
  deps: MemberFleetInstallDeps,
): Promise<NonNullable<FleetMcpStatus['beads']> | null> {
  try {
    const targetOs = getAgentOS(agent) as TargetOS;
    const shell = getAgentShell(agent);
    const home = await deps.resolveHome(agent);
    if (!home) return null;
    const bdPath = memberBeadsPath(home, targetOs, shell);
    const r = await deps.exec(agent, buildBeadsProbe(bdPath, targetOs, shell), PROBE_TIMEOUT_MS);
    if (r.stdout.includes(NO_INSTALL_SENTINEL)) {
      return { state: 'missing', detail: `bd is not on the member PATH and not at ${bdPath}`, fix: BEADS_MISSING_FIX };
    }
    if (r.stdout.includes(EXEC_FAILED_SENTINEL)) {
      return { state: 'broken', detail: 'bd is present on the member but bd --version failed', fix: BEADS_MISSING_FIX };
    }
    return null;
  } catch {
    return null;
  }
}

async function probeMemberFleetMcpInner(
  agent: Agent,
  deps: MemberFleetMcpDeps,
  opts: ProbeOpts,
  ctx: { installedNow: boolean },
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

    const status = agent.agentType === 'local'
      ? await probeLocal(agent, deps, unavailable, checkedAt)
      : await probeRemote(agent, deps, opts.install !== false, unavailable, checkedAt, opts.forceInstall === true, ctx, opts.writeMcpEntry === true, opts.replaceFull === true);
    // The member session listing kb_*/code_* proves the server, not what a
    // dispatched role sees: roles run as `claude --agent <role>`, whose tools
    // list filters the session. Verify that path too.
    if (status.state === 'available' && provider === 'claude' && deps.roleAgents) {
      const roles = await deps.roleAgents(agent);
      if (!roles.ok) {
        const { state: _s, checkedAt: _c, detail: prior, ...keep } = status;
        return unavailable('role-agents-hide-member-tools', prior ? `${roles.detail}. Also: ${prior}` : roles.detail, keep);
      }
      if (roles.healed && roles.healed.length > 0) {
        const note = `rewrote role files that hid the member kb_*/code_* tools: ${roles.healed.join(', ')}`;
        return { ...status, detail: status.detail ? `${status.detail}. ${note}` : note };
      }
    }
    return status;
  } catch (err: unknown) {
    return unavailable('probe-failed', `probe threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Probe options. `writeMcpEntry` (register_member / update_member with a
 *  fleet install) writes the per-folder MCP entry before it is checked;
 *  without it (member_detail refresh) the probe stays read-only. */
export interface ProbeOpts {
  install?: boolean;
  forceInstall?: boolean;
  writeMcpEntry?: boolean;
  /** fleet_install "replace-full": with `install`, replace an unmarked (full)
   *  install with a member install instead of refusing it. Never implied. */
  replaceFull?: boolean;
}

type Unavailable = (reason: FleetMcpUnavailableReason, detail?: string, extra?: Partial<FleetMcpStatus>) => FleetMcpStatus;

/**
 * Install failures the member probe never falls back from: the installer ran
 * (or was refused) on the member, or the member could not be probed at all.
 * Every other install failure happened before the member was touched, so an
 * older install there is intact and stays in use (reported, never silent).
 */
const INSTALL_FAIL_CLOSED: ReadonlySet<string> = new Set([
  'install-failed', 'install-unverified', 'full-install-running', 'probe-failed', 'home-unresolved', 'replace-failed',
]);

/** One line naming a failed upgrade and the older install still in use. */
function installFailureNote(f: { reason: string; detail?: string }, version: string | undefined): string {
  return `the apra-fleet upgrade on the member failed (${f.reason}${f.detail ? `: ${f.detail.replace(/\.\s*$/, '')}` : ''}); the older apra-fleet ${version ?? '(unknown version)'} install is in use`;
}

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
  ctx: { installedNow: boolean } = { installedNow: false },
  writeMcpEntry = false,
  replaceFull = false,
): Promise<FleetMcpStatus> {
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);

  const home = await deps.resolveHome(agent);
  if (!home) return unavailable('home-unresolved', 'the member home directory could not be probed');
  const binPath = memberBinPath(home, targetOs, shell);

  // 1. Install (or, when not installing, just observe the version).
  let version: string | undefined;
  let installedNow = false;
  // A requested upgrade that failed BEFORE anything on the member was touched,
  // while the older install keeps serving: carried into the final status.
  let installFailure: { reason: string; detail?: string } | undefined;
  // A full install this probe replaced (opt-in): reported on every outcome.
  let replaced: ReplacedFullInstall | undefined;
  // Manual install steps for the member when a requested install did not happen.
  let manualInstall: string | undefined;
  // The signed same-core stable release installed instead of the exact build.
  let sameCoreFallback: SameCoreFallback | undefined;
  // Set when this probe's install reported MEMBER-STANDALONE (no usable
  // service manager on the member): nothing started its server.
  let standaloneInstall: string | undefined;
  if (install) {
    const r = await ensureMemberFleetInstall(agent, deps, { force: forceInstall, replaceFull });
    if (r.state === 'available') {
      version = r.version;
      if (r.installed) { ctx.installedNow = true; installedNow = true; }
      replaced = r.replaced;
      sameCoreFallback = r.sameCoreFallback;
      standaloneInstall = r.standalone;
    }
    // Fail closed -- with the install's OWN reason and detail, never a later
    // step's error (apra-fleet-b4g.73) -- when the installer ran or was
    // refused on the member, the probe itself failed, there is no older
    // install, or a provider change forced the install (the old install is
    // configured for the old provider).
    else if (!r.version || forceInstall || INSTALL_FAIL_CLOSED.has(r.reason)) {
      const detail = r.version
        ? `${(r.detail ?? r.reason).replace(/\.\s*$/, '')}; the member still has apra-fleet ${r.version}, which was not used`
        : r.detail;
      return unavailable(r.reason, detail, { ...(r.version ? { version: r.version } : {}), ...(r.manualSteps ? { manualInstall: r.manualSteps } : {}) });
    }
    // Otherwise the upgrade failed before the member was touched (no arch, no
    // source, download/checksum/transfer failure): the older install is
    // intact, so keep the member usable on it -- still only through the 2a
    // marker check below -- and report the failed upgrade in every outcome.
    else {
      version = r.version;
      installFailure = { reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
      manualInstall = r.manualSteps;
    }
  } else {
    const p = await probeMemberFleetVersion(agent, binPath, deps);
    if (p.kind === 'probe-failed') return unavailable('probe-failed', p.detail);
    if (p.kind !== 'installed') return unavailable('install-unverified', p.kind === 'broken' ? p.detail : 'apra-fleet is not installed on the member');
    version = p.version;
  }
  const withVersion = {
    version,
    ...(installFailure ? { installFailure } : {}),
    ...(replaced ? { replacedFullInstall: replaced } : {}),
    ...(sameCoreFallback ? { sameCoreFallback } : {}),
  };
  const upgradeNote = installFailure ? installFailureNote(installFailure, version) : undefined;
  const replaceNote = replaced
    ? `replaced the apra-fleet ${replaced.previousVersion} full install with a member install ${version}; removed: ${replaced.removed.join('; ')}; backup at ${replaced.backupPath}`
    : undefined;
  // Set once the member's port is resolved (step 2c): the port fields and the
  // note about it ride on every later outcome, like a failed upgrade.
  let portFields: Partial<FleetMcpStatus> = {};
  let portNote: string | undefined;
  // Set when this probe started the member's server (standalone mode).
  let startNote: string | undefined;
  const notes = (): string[] => [replaceNote, upgradeNote, portNote, startNote].filter((n): n is string => !!n);
  // Every later outcome keeps a failed upgrade visible: a later step's error
  // must never hide it, and an available status still names it.
  const fail: Unavailable = (reason, detail) => {
    const also = notes();
    return unavailable(reason, also.length ? `${(detail ?? reason).replace(/\.\s*$/, '')}. Also: ${also.join('. ')}` : detail, { ...withVersion, ...(manualInstall ? { manualInstall } : {}), ...portFields });
  };

  // 2a. Self-register ONLY into a member install (marker present). An install
  // without the marker -- a human full install at the same <home>/.apra-fleet
  // path, or an unmarked older member install -- is never written to: a LOCAL
  // entry for this uuid there would let a later run mistake it for the fleet's
  // own. An install this probe just ran (--member) wrote the marker itself.
  if (!installedNow) {
    const marker = await probeMemberInstallMarker(agent, home, deps);
    if (marker.kind === 'probe-failed') return fail('probe-failed', marker.detail);
    if (marker.kind === 'absent') {
      // Stage the current installer only when an install was requested; a plain
      // status refresh must not copy or download a binary on every probe.
      const installer = await stageReplacementInstaller(agent, deps, home, null, install);
      if (install) manualInstall = manualInstall ?? `follow the owner steps in the reason above, then on the orchestrator run update_member {member_id, fleet_install: "auto"} so the fleet self-registers the member into that install and verifies it.`;
      return fail('full-install-running', `the apra-fleet ${version} at ${binPath} has no member-install marker, so the member was not registered into it. ${buildFullInstallReplaceHint({ home, targetOs, shell, provider: agent.llmProvider ?? 'claude', installer })}`);
    }
  }

  // 2c. The port the member's own install listens on, from its marker: the
  // per-folder entry written below and every later session config use it.
  // An unreadable marker keeps the previously recorded port (never a silent
  // fall back to the default, which another user's server may hold).
  const portRes = await resolveMemberMcpPort(agent, home, deps);
  let portAgent: Agent = agent;
  if (portRes.kind === 'resolved') {
    portFields = { port: portRes.port, portSource: portRes.source };
    portNote = portRes.note;
    portAgent = { ...agent, memberMcpPort: portRes.source === 'marker' ? portRes.port : undefined };
  } else {
    portNote = portRes.detail;
  }

  // 2d. The member install's access secret: its server refuses a ?member=
  // session without it, so the per-folder entry written below and every
  // session config carry it. An install older than the secret has none; when
  // an install was requested (fleet_install "auto") it is created there
  // through the secret-file channel, never a command string.
  const secretRes = await ensureRemoteMemberAccessSecret(
    agent, home,
    { exec: (cmd, t) => deps.exec(agent, cmd, t ?? PROBE_TIMEOUT_MS), stage: deps.stageSecretFile, removeStaged: removeMemberSecretFile },
    install,
  );
  if (secretRes.kind === 'failed') return fail('member-secret-unavailable', secretRes.detail);
  // 'absent' (read-only probe of an install older than the secret): its
  // server does not check one, so sessions there work without it.
  if (secretRes.kind === 'found' || secretRes.kind === 'created') {
    deps.recordMemberSecret?.(agent.id, secretRes.secret);
    portAgent = { ...portAgent, encryptedMemberMcpSecret: encryptPassword(secretRes.secret) };
  }

  // 2b. Register the member on its own install under the orchestrator's id.
  const reg = await deps.exec(agent, buildSelfRegisterCommand(binPath, agent, targetOs, shell), MEMBER_CALL_TIMEOUT_MS);
  if (reg.code !== 0) {
    const out = `${reg.stdout}\n${reg.stderr}`;
    if (/E-FOLDER-TAKEN/.test(out)) return fail('E-FOLDER-TAKEN', memberErrorDetail(out));
    if (/unknown or unexpected argument "--id"/i.test(out) || /unknown (?:option|command|argument)[^\n]*(?:--id|register-member)/i.test(out)) {
      return fail('install-too-old', `the member's apra-fleet ${version} does not support register-member --id`);
    }
    return fail('register-failed', `register-member exited ${reg.code}: ${memberErrorDetail(out)}`);
  }

  // 3a. Write the per-folder MCP entry (the compose_permissions writer) so one
  // register/update call ends with it in place -- after self-registration, so
  // nothing the member-side register does can race it.
  // 3b. The per-folder MCP entry must point at this member -- for providers
  // whose dispatched session reads it. A claude dispatch gets the member
  // config per session (--mcp-config, see session-mcp-config.ts) once this
  // probe reports available, so for claude the entry is only the fallback:
  // it is still written (best effort) but neither its write nor its check gates.
  const perFolderGates = (agent.llmProvider ?? 'claude') !== 'claude';
  if (writeMcpEntry && deps.writeMcpEntry) {
    const w = await deps.writeMcpEntry(portAgent);
    if (!w.ok && perFolderGates) return fail((w.reason as FleetMcpUnavailableReason | undefined) ?? 'mcp-entry-missing', w.detail);
  }
  if (perFolderGates) {
    const url = await readMemberMcpEntryUrl(agent, home, deps);
    if (!url || !url.endsWith(memberQuery(agent))) {
      return fail('mcp-entry-missing', url
        ? `per-folder apra-fleet entry points at ${url}, not ${memberQuery(agent)}`
        : 'no per-folder apra-fleet MCP entry for the work folder; run compose_permissions');
    }
  }

  // 3c. Standalone server: an install that found no usable service manager
  // started nothing, so the fleet starts the server detached now (and step 4
  // starts it again whenever a later probe finds it down).
  let startTried = false;
  const startServer = async (why: string): Promise<FleetMcpStatus | null> => {
    startTried = true;
    const st = await ensureMemberServerRunning(agent, home, binPath, deps);
    if (!st.ok) return fail('member-server-not-running', `${st.detail.replace(/\.\s*$/, '')}. (${why})`);
    if (st.note) startNote = st.note;
    return null;
  };
  if (standaloneInstall !== undefined) {
    const failed = await startServer(`the member install reported standalone mode: ${standaloneInstall}`);
    if (failed) return failed;
  }

  // 4. A MEMBER session on the member answers version and lists kb_* / code_*.
  const argsPath = memberJoin(targetOs, shell, home, '.apra-fleet', `version-args-${agent.id}.json`);
  const callVersion = async () => parseCallOutput(
    await deps.exec(agent, buildMemberCallCommand(binPath, agent.id, 'version', argsPath, targetOs, shell), MEMBER_CALL_TIMEOUT_MS),
    'call version',
  );
  let v = await callVersion();
  // The member's server is down (the call could not reach or auto-start it):
  // start it the same way and retry once.
  if (!v.ok && !startTried && memberCallSaysServerDown(v.detail)) {
    const failed = await startServer(`the member session call found the server down: ${v.detail}`);
    if (failed) return failed;
    v = await callVersion();
  }
  if (!v.ok) return fail('member-session-failed', v.detail);
  const l = parseCallOutput(
    await deps.exec(agent, buildMemberCallCommand(binPath, agent.id, 'list-tools', argsPath, targetOs, shell), MEMBER_CALL_TIMEOUT_MS),
    'call --list-tools',
  );
  if (!l.ok) return fail('member-session-failed', l.detail);
  const judged = judgeSession(v.value, l.value);
  if (!judged.ok) return fail(judged.reason, judged.detail);
  const finalNotes = notes();
  return {
    state: 'available', version, checkedAt: checkedAt(),
    ...(installFailure ? { installFailure } : {}),
    ...(manualInstall ? { manualInstall } : {}),
    ...(replaced ? { replacedFullInstall: replaced } : {}),
    ...(sameCoreFallback ? { sameCoreFallback } : {}),
    ...(finalNotes.length ? { detail: finalNotes.join('. ') } : {}),
    ...portFields,
  };
}

/**
 * Probe and RECORD the member's fleetMcp status on its registry entry. The
 * record is an observation, overwritten on every call, so a re-probe after a
 * manual fix flips unavailable -> available with no restart.
 */
export async function refreshMemberFleetMcp(
  agent: Agent,
  deps: MemberFleetMcpDeps = defaultMemberFleetMcpDeps(),
  opts: ProbeOpts = {},
): Promise<FleetMcpStatus> {
  const status = await probeMemberFleetMcp(agent, deps, opts);
  deps.record(agent.id, status);
  return status;
}

export type SelfRemoveResult =
  | { removed: boolean; detail: string }
  | { removed: false; reason: 'home-unresolved' | 'install-too-old' | 'remove-failed' | 'probe-failed'; detail: string }
  /** The member-side removal was deliberately not run: the install is not fleet-owned (marker absent) or ownership could not be established (marker probe failed). */
  | { removed: false; skipped: true; reason: 'not-fleet-owned' | 'probe-failed'; detail: string };

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
    // The marker is the sole ownership signal: never touch an install the fleet
    // does not own, and never read a failed probe as ownership.
    const marker = await probeMemberInstallMarker(agent, home, deps);
    if (marker.kind === 'absent') {
      return { removed: false, skipped: true, reason: 'not-fleet-owned', detail: `skipped the member-side registration removal: the apra-fleet install at ${binPath} has no member-install marker, so it is not fleet-owned` };
    }
    if (marker.kind === 'probe-failed') {
      return { removed: false, skipped: true, reason: 'probe-failed', detail: `skipped the member-side registration removal: ownership of the member install could not be established (${marker.detail})` };
    }
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
