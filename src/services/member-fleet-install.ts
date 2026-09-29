/**
 * Resolves each MEMBER's OWN apra-fleet install and returns either a stdio
 * launch descriptor for it or a named, structured reason why that member is
 * "unscoped" (apra-fleet-b4g.23.3).
 *
 * WHY THIS MODULE EXISTS
 *
 * The owner design is that every member runs its own apra-fleet MCP server over
 * LOCAL stdio -- no central KB server, no tunnel, no mirror, no endpoint URL and
 * no credential. Composing a member config for that design needs one thing the
 * repo did not have: the command that starts apra-fleet ON THAT MEMBER.
 *
 * The two shapes that already existed were both wrong for the job:
 *
 *  - `src/cli/install.ts`'s `mcpConfig` is ORCHESTRATOR-LOCAL process
 *    introspection (`binaryPath` under the orchestrator's own `BIN_DIR`,
 *    `process.execPath`, `process.argv[1]`, `findProjectRoot()`). Reusing it for
 *    a remote member writes the ORCHESTRATOR's paths into the MEMBER's config --
 *    a command that does not exist on the member and fails silently at MCP
 *    startup. That is exactly the "implicit environment decides behaviour and
 *    failure is silent" shape CLAUDE.md forbids.
 *  - `src/services/member-home.ts` resolves the member's HOME, but nothing built
 *    a fleet-install path on top of it.
 *
 * So callers were left with two bad outcomes: write a path that is wrong on the
 * member, or hard-fail config composition for every member (which is all of
 * them today) and break remote-member sprint init. This module creates the
 * THIRD outcome: a resolution that either produces a descriptor it has actually
 * VERIFIED on the member, or a named machine-readable reason plus a remediation
 * string a user with no tribal knowledge can act on. Callers write the MCP entry
 * in the first case and record the named reason in the second. No
 * orchestrator-derived path is ever written into a remote member's config, and
 * nothing here ever throws for the mere absence of an install.
 *
 * PROVISIONING DECISION (required to be explicit, not implicit)
 *
 * An absent member-side install is a REGISTRATION PREREQUISITE that this module
 * VERIFIES AND SURFACES. It is deliberately NOT auto-provisioned, which is where
 * this diverges from `agent-provisioner.ts`'s push-what-is-missing precedent.
 * The reason is that the precedent does not carry over: agent-provisioner pushes
 * small text files whose canonical content the orchestrator holds and which are
 * platform-independent. An apra-fleet install is a platform-specific native
 * executable (or a Node project plus its dependency tree). The orchestrator
 * holds a build for ITS OWN platform only and cannot produce one for a member on
 * a different OS/arch, so "push what is missing" would either ship a binary that
 * cannot run on the member or silently degrade to the wrong artifact -- another
 * silent failure. Instead the remediation string below names the exact command
 * the member's operator runs, and until they do, the member is reported unscoped
 * rather than being wired to something broken.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../types.js';
import type { TargetOS } from '../providers/provider.js';
import { BIN_DIR } from '../cli/config.js';
import { getStrategy } from './strategy.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { escapePowerShellArgInner, escapeShellArgInner } from '../utils/shell-escape.js';
import { logWarn } from '../utils/log-helpers.js';
import { getMemberPathContext, memberCommandFor, memberJoin } from './member-home.js';

/** Trailing args that start the stdio MCP server. Passed explicitly so an MCP
 *  host invokes `apra-fleet run` and never the no-arg default (installation). */
export const FLEET_STDIO_ARGS: readonly string[] = ['run', '--transport', 'stdio'];

/**
 * Oldest member-side apra-fleet that can serve this design. The member-local
 * stdio server with per-tool kb_* / code_* scoping ships in 0.4.4; an older
 * install answers `run --transport stdio` but does not enforce the member tool
 * scope, so wiring it up would grant a member more than it should have. Treated
 * as `install-unusable` rather than silently accepted.
 */
export const MIN_MEMBER_FLEET_VERSION = '0.4.4';

const PROBE_TIMEOUT_MS = 15_000;

/** Emitted by the probe when the resolved path is not present/executable. */
const NO_INSTALL_SENTINEL = '__APRA_FLEET_NO_INSTALL__';
/** Emitted by the probe when the path exists but running it failed. */
const EXEC_FAILED_SENTINEL = '__APRA_FLEET_EXEC_FAILED__';

/** `apra-fleet --version` prints `apra-fleet <semver>` on its FIRST line, then
 *  Mode/Binary lines. Scanned line-by-line (not "last line") so a login-shell
 *  or PowerShell banner on either side of the real output is skipped. */
const VERSION_LINE_RE = /^apra-fleet\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/;

/** Machine-readable reasons a member has no usable apra-fleet of its own. */
export type FleetInstallUnscopedReason =
  /** Nothing apra-fleet-shaped at the member's expected install path. */
  | 'no-install-found'
  /** Present, but too old or it would not report a usable version. */
  | 'install-unusable'
  /** The member could not be probed at all (unreachable, transport error,
   *  home directory unknown). Distinct from 'no-install-found': we do NOT know
   *  whether an install exists. */
  | 'probe-failed'
  /** Engine invariant tripwire: a descriptor for a REMOTE member was built from
   *  an orchestrator-derived value. Never reachable on the correct path. */
  | 'orchestrator-path-leak'
  /** The member's LLM provider cannot run an MCP server fleet configures, so
   *  there is nothing to enable regardless of what is installed
   *  (apra-fleet-b4g.23.1 criterion 10). Named rather than silently skipped. */
  | 'provider-unsupported'
  /** A human explicitly disabled the fleet MCP server for this member. Honoured,
   *  never overridden -- reported as the reason the member is unscoped. */
  | 'human-disabled';

/** How the descriptor was arrived at. Exposed so callers (and tests) can see
 *  that a local member took the local branch DELIBERATELY rather than falling
 *  through the remote logic. */
export type FleetInstallOrigin = 'local-host' | 'member-probe';

export interface FleetLaunchDescriptor {
  /** Absolute path (on the member) of the executable to launch. */
  command: string;
  /** Args that make it serve MCP over stdio. */
  args: string[];
}

export interface FleetInstallScoped {
  scoped: true;
  descriptor: FleetLaunchDescriptor;
  /** Version string the member's own install actually reported. */
  version: string;
  origin: FleetInstallOrigin;
}

export interface FleetInstallUnscoped {
  scoped: false;
  reason: FleetInstallUnscopedReason;
  /** User-actionable, self-contained: names the command to run and where. */
  remediation: string;
  /** Diagnostic context (probe stderr, observed version, ...). Never required. */
  detail?: string;
}

export type MemberFleetInstall = FleetInstallScoped | FleetInstallUnscoped;

/** memberId -> resolved install. SUCCESSES ONLY (same discipline as
 *  member-home.ts): a failure is never cached, so a briefly unreachable member
 *  recovers on the next poll without a server restart. */
const installCache = new Map<string, FleetInstallScoped>();
/** memberId -> in-flight resolution, so N concurrent callers cause ONE probe. */
const inFlight = new Map<string, Promise<MemberFleetInstall>>();

/** Compare dotted numeric versions. Pre-release/build suffixes are ignored for
 *  ordering -- a `0.4.4-rc1` member counts as 0.4.4 rather than being rejected. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split('.').map(n => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Executable name apra-fleet installs itself as on the member's OS. */
function binaryNameFor(targetOs: TargetOS | undefined): string {
  return targetOs === 'windows' ? 'apra-fleet.exe' : 'apra-fleet';
}

/**
 * The member-side probe, built ENTIRELY in JavaScript from an already-resolved
 * absolute path. Contains no shell-expansion token -- no `$VAR`, no `~`, no
 * backtick -- in either branch, because the member's shell may be PowerShell and
 * because `~`/`$HOME` would be resolved by whichever shell happens to sit in
 * between (CLAUDE.md's member-bound-command rule).
 *
 * Both branches are written to exit 0 and to TAG their outcome in stdout, so a
 * non-zero exit code means "the shell/transport itself failed" and nothing else.
 * That is what lets 'no-install-found' and 'probe-failed' stay distinguishable.
 *
 * POWERSHELL BRANCH -- DO NOT "SIMPLIFY" THE $LASTEXITCODE TEST OR THE TRAILING
 * `exit 0`. PowerShell raises NO terminating error when a NATIVE executable
 * exits non-zero, so the obvious `try { & $p --version } catch { <sentinel> }`
 * shape never reaches its catch for a present-but-broken install: the probe
 * returns partial stdout with no sentinel, and wrapPowerShellEncoded()
 * (src/os/windows.ts) then propagates the leftover $LASTEXITCODE as the process
 * exit code. verifyOnMember() below sees "no sentinel + non-zero exit" and
 * reports probe-failed ("check the member is powered on and reachable") for a
 * perfectly reachable machine whose install is the real problem -- exactly the
 * confidently-wrong named cause CLAUDE.md forbids. Hence the explicit
 * $LASTEXITCODE branch, and the trailing `exit 0` that keeps the wrapper's exit
 * code reserved for genuine transport failure. The catch is still needed for a
 * path that exists but cannot be launched at all (bad image, not executable).
 * Both branches are execute-verified against a real interpreter by the live-pwsh
 * assertions in tests/member-mcp-scope.test.ts, not just pattern-matched.
 */
export function buildFleetVersionProbe(
  binPath: string,
  targetOs: TargetOS,
  shell: ReturnType<typeof getAgentShell>,
): string {
  const posixPath = `'${escapeShellArgInner(binPath)}'`;
  const psPath = `'${escapePowerShellArgInner(binPath)}'`;
  return memberCommandFor(targetOs, shell, {
    posix:
      `if [ -x ${posixPath} ]; then ${posixPath} --version 2>/dev/null || ` +
      `printf '%s\\n' '${EXEC_FAILED_SENTINEL}'; else printf '%s\\n' '${NO_INSTALL_SENTINEL}'; fi`,
    powershell:
      `if (Test-Path -LiteralPath ${psPath}) { try { $out = & ${psPath} --version; ` +
      `if ($LASTEXITCODE -ne 0) { [Console]::Out.Write('${EXEC_FAILED_SENTINEL}') } ` +
      `else { [Console]::Out.Write(($out | Out-String)) } } catch ` +
      `{ [Console]::Out.Write('${EXEC_FAILED_SENTINEL}') } } else ` +
      `{ [Console]::Out.Write('${NO_INSTALL_SENTINEL}') }; exit 0`,
  });
}

/** First `apra-fleet <semver>` line in the probe output, or null. */
export function parseFleetVersion(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const m = VERSION_LINE_RE.exec(raw.trim());
    if (m) return m[1];
  }
  return null;
}

function notInstalled(binPath: string, agent: Agent): FleetInstallUnscoped {
  return {
    scoped: false,
    reason: 'no-install-found',
    remediation:
      `apra-fleet is not installed on member "${agent.friendlyName}". Log in to that machine as ` +
      `the user fleet connects as (${agent.username ?? 'the member account'}) and run ` +
      `"apra-fleet install" there, then re-run member registration. The install must be ` +
      `version ${MIN_MEMBER_FLEET_VERSION} or newer and must place its executable at ${binPath}.`,
    detail: `probed ${binPath}`,
  };
}

function tooOld(binPath: string, observed: string, agent: Agent): FleetInstallUnscoped {
  return {
    scoped: false,
    reason: 'install-unusable',
    remediation:
      `Member "${agent.friendlyName}" has apra-fleet ${observed} at ${binPath}, but this feature ` +
      `needs ${MIN_MEMBER_FLEET_VERSION} or newer. Log in to that machine as ` +
      `${agent.username ?? 'the member account'} and re-run "apra-fleet install" to upgrade it.`,
    detail: `observed version ${observed} < ${MIN_MEMBER_FLEET_VERSION}`,
  };
}

function unusable(binPath: string, agent: Agent, detail: string): FleetInstallUnscoped {
  return {
    scoped: false,
    reason: 'install-unusable',
    remediation:
      `Member "${agent.friendlyName}" has a file at ${binPath} but it did not report an ` +
      `apra-fleet version. Log in to that machine as ${agent.username ?? 'the member account'}, ` +
      `run "${binPath} --version" to see what it reports, and re-run "apra-fleet install" ` +
      `there to repair the install.`,
    detail,
  };
}

function probeFailed(agent: Agent, detail: string): FleetInstallUnscoped {
  return {
    scoped: false,
    reason: 'probe-failed',
    remediation:
      `Could not probe member "${agent.friendlyName}" for its apra-fleet install, so whether one ` +
      `exists is unknown. Check that the member is powered on and reachable (check_member_health ` +
      `reports its connectivity), then retry. No configuration was changed for this member.`,
    detail,
  };
}

/**
 * The member's LLM provider has no MCP surface fleet can configure, so no
 * install could help (apra-fleet-b4g.23.1 criterion 10). A named outcome rather
 * than a silently unreachable member, and non-fatal like every other unscoped
 * reason.
 */
export function providerUnsupportedUnscoped(providerName: string, friendlyName: string): FleetInstallUnscoped {
  return {
    scoped: false,
    reason: 'provider-unsupported',
    remediation:
      `Member "${friendlyName}" runs the "${providerName}" agent CLI, which apra-fleet cannot ` +
      `configure an MCP server for, so it cannot use the KB or code-intelligence tools. To give ` +
      `this member those tools, re-register it with a provider that supports MCP (claude or agy). ` +
      `Everything else about this member is unaffected.`,
    detail: `provider "${providerName}" reports supportsMemberMcp() === false`,
  };
}

/**
 * A human explicitly turned the fleet MCP server off for this member. Their
 * choice is authoritative and is never overwritten (apra-fleet-b4g.23.1
 * criterion 8); it becomes the named reason the member is unscoped.
 */
export function humanDisabledUnscoped(friendlyName: string, whereFound: string): FleetInstallUnscoped {
  return {
    scoped: false,
    reason: 'human-disabled',
    remediation:
      `The apra-fleet MCP server is explicitly disabled for member "${friendlyName}" in ` +
      `${whereFound}. apra-fleet does not override that. Remove the server from that ` +
      `disabled list on the member and re-run compose_permissions to give it the KB and ` +
      `code-intelligence tools.`,
    detail: `human-set disable found in ${whereFound}`,
  };
}

/**
 * Values that belong to the ORCHESTRATOR's process and must never appear in a
 * REMOTE member's launch descriptor. Collected in one place so the tripwire and
 * the tests that assert on it cannot drift.
 */
export function orchestratorOwnedValues(): string[] {
  return [process.execPath, process.argv[1], BIN_DIR, os.homedir()].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

/**
 * Tripwire for criterion 2: a remote member's descriptor may contain nothing
 * derived from the orchestrator's own process. This cannot fire on the correct
 * path (a remote descriptor is built only from the member's probed home), so a
 * hit is an engine bug. It is surfaced as a named unscoped result rather than a
 * throw, because callers must stay usable for every member.
 */
function orchestratorLeak(descriptor: FleetLaunchDescriptor): string | null {
  const haystack = [descriptor.command, ...descriptor.args].join('\n');
  for (const owned of orchestratorOwnedValues()) {
    if (haystack.includes(owned)) return owned;
  }
  return null;
}

/**
 * The orchestrator's own install, for a LOCAL member only.
 *
 * Reached ONLY from the `agentType === 'local'` branch in `resolveOnce`. A local
 * member runs as this process's own OS user on this very host, so the
 * orchestrator's install IS that member's own install -- this is the deliberate
 * exception criterion 2 allows, not a fallthrough. The installed binary is
 * preferred; the dev/npm shape (`<node> <entry>`) is the honest answer when
 * there is no copied binary, and is still local-only.
 */
function localCandidate(): FleetLaunchDescriptor | null {
  const binPath = path.join(BIN_DIR, binaryNameFor(process.platform === 'win32' ? 'windows' : undefined));
  if (fs.existsSync(binPath)) return { command: binPath, args: [...FLEET_STDIO_ARGS] };
  const entry = process.argv[1];
  if (entry && fs.existsSync(entry)) {
    return { command: process.execPath, args: [entry, ...FLEET_STDIO_ARGS] };
  }
  return null;
}

/** Run the probe and turn its outcome into a scoped/unscoped result. */
async function verifyOnMember(
  agent: Agent,
  descriptor: FleetLaunchDescriptor,
  origin: FleetInstallOrigin,
  targetOs: TargetOS,
  shell: ReturnType<typeof getAgentShell>,
): Promise<MemberFleetInstall> {
  const probe = buildFleetVersionProbe(descriptor.command, targetOs, shell);
  let result;
  try {
    result = await getStrategy(agent).execCommand(probe, PROBE_TIMEOUT_MS);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return probeFailed(agent, `probe threw: ${msg}`);
  }

  if (result.stdout.includes(NO_INSTALL_SENTINEL)) return notInstalled(descriptor.command, agent);
  if (result.stdout.includes(EXEC_FAILED_SENTINEL)) {
    return unusable(descriptor.command, agent, 'member reported the executable could not be run');
  }
  if (result.code !== 0) {
    return probeFailed(agent, `probe exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
  }

  const version = parseFleetVersion(result.stdout);
  if (!version) {
    return unusable(descriptor.command, agent, `unparseable --version output: ${result.stdout.trim().slice(0, 200)}`);
  }
  if (compareVersions(version, MIN_MEMBER_FLEET_VERSION) < 0) {
    return tooOld(descriptor.command, version, agent);
  }

  if (origin === 'member-probe') {
    const leaked = orchestratorLeak(descriptor);
    if (leaked) {
      logWarn(
        'member_fleet_install',
        `BUG: remote descriptor for ${agent.friendlyName} contains orchestrator-owned value ${leaked}; refusing it`,
      );
      return {
        scoped: false,
        reason: 'orchestrator-path-leak',
        remediation:
          `Internal fault: the launch command resolved for member "${agent.friendlyName}" contains a ` +
          `path belonging to the orchestrator (${leaked}), which cannot be valid on the member. This ` +
          `is an apra-fleet bug -- please report it. No configuration was changed for this member.`,
        detail: `leaked value: ${leaked}`,
      };
    }
  }

  return { scoped: true, descriptor, version, origin };
}

async function resolveOnce(agent: Agent): Promise<MemberFleetInstall> {
  // --- DELIBERATE local branch (criterion 2). Keyed on agentType, before any
  // member-side path resolution, so it can never be reached by fallthrough. ---
  if (agent.agentType === 'local') {
    const descriptor = localCandidate();
    if (!descriptor) {
      return {
        scoped: false,
        reason: 'no-install-found',
        remediation:
          `This host has no apra-fleet install to share with local member "${agent.friendlyName}". ` +
          `Run "apra-fleet install" on this machine, then retry.`,
        detail: `no binary under ${BIN_DIR} and no resolvable entry script`,
      };
    }
    const localOs = (process.platform === 'win32' ? 'windows' : 'linux') as TargetOS;
    return verifyOnMember(agent, descriptor, 'local-host', localOs, getAgentShell(agent));
  }

  // --- Remote/relay: every path segment comes from the MEMBER. ---
  const targetOs = getAgentOS(agent) as TargetOS;
  const shell = getAgentShell(agent);
  const ctx = await getMemberPathContext(agent);
  if (!ctx.homeDir) {
    return probeFailed(agent, 'member home directory could not be resolved');
  }

  const binPath = memberJoin(targetOs, shell, ctx.homeDir, '.apra-fleet', 'bin', binaryNameFor(targetOs));
  const descriptor: FleetLaunchDescriptor = { command: binPath, args: [...FLEET_STDIO_ARGS] };
  return verifyOnMember(agent, descriptor, 'member-probe', targetOs, shell);
}

/**
 * Resolve the member's OWN apra-fleet stdio launch descriptor, or a named reason
 * it is unscoped. NEVER throws and never returns a descriptor it has not
 * verified by running that exact executable on that exact member.
 */
export async function resolveMemberFleetInstall(agent: Agent): Promise<MemberFleetInstall> {
  const cached = installCache.get(agent.id);
  if (cached) return cached;

  const existing = inFlight.get(agent.id);
  if (existing) return existing;

  const run = resolveOnce(agent)
    .then(result => {
      // Successes cached, failures NOT -- a transient probe failure must re-probe
      // on the next call rather than sticking until a server restart.
      if (result.scoped) installCache.set(agent.id, result);
      return result;
    })
    .catch((err: unknown): MemberFleetInstall => {
      const msg = err instanceof Error ? err.message : String(err);
      return probeFailed(agent, `resolution threw: ${msg}`);
    })
    .finally(() => inFlight.delete(agent.id));

  inFlight.set(agent.id, run);
  return run;
}

/** Drop cached resolutions (a specific member, or all). Used when a member is
 *  re-registered/removed, and by tests. */
export function clearMemberFleetInstallCache(memberId?: string): void {
  if (memberId === undefined) {
    installCache.clear();
    inFlight.clear();
    return;
  }
  installCache.delete(memberId);
  inFlight.delete(memberId);
}
