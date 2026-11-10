/**
 * The kb kind of provision_auth: how a KB token reaches a member
 * (provision_kb_auth). The core (provision-auth-kinds.ts) has already applied the
 * secret's policy on the orchestrator and resolved the value.
 *
 * Local member: it shares the orchestrator's fleet server and KB config, which is
 * machine-wide, so nothing is pushed and the config is never changed. prepare
 * checks the config names this remote and {{secret.NAME}}; the core's resolve is
 * the one resolve that verifies it.
 *
 * Remote member, reached only over SSH, with the same binary and data dir as its
 * own fleet server (<home>/.apra-fleet/bin, default data dir, as `apra-fleet call`):
 *  prepare: start a cloud member (its host may change), then refuse an install
 *           that is missing, older than KB_AUTH_MIN_MEMBER_VERSION, or not a
 *           member install. Nothing is minted before this passes.
 *  deliver: (1) the value is staged in an owner-only file and piped into
 *           `apra-fleet secret --set NAME --persist --expires-at <time> -y`,
 *           which removes the file in the same command; it is never on a command
 *           line. (2) `apra-fleet kb-setup --remote <url> --token-ref NAME`
 *           points the member's KB at it if it does not already, and checks it
 *           with one KB call.
 * A step fails with a KbStepError reason only: no member output reaches a result.
 */
import type { Agent, SSHExecResult } from '../types.js';
import type { TargetOS } from '../providers/provider.js';
import { getStrategy } from './strategy.js';
import { getMemberHomeDir } from './member-home.js';
import { ensureCloudReady } from './cloud/lifecycle.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { escapePowerShellArgInner, escapeShellArgInner } from '../utils/shell-escape.js';
import { memberCommandFor, memberBinPath, probeMemberFleetVersion, probeMemberInstallMarker, isOlderThan, type MemberFleetInstallDeps } from './member-fleet-install.js';
import { removeMemberSecretFile, writeMemberSecretFile } from './member-secret-env.js';
import { kbConfigMatch } from './knowledge/kb-config.js';

/** The first member install with `secret --set --expires-at` and `kb-setup`. */
export const KB_AUTH_MIN_MEMBER_VERSION = '0.4.5';

const PROBE_TIMEOUT_MS = 15_000;
const MEMBER_CLI_TIMEOUT_MS = 60_000;

/** Why a kb step failed. provision-auth-kinds.ts gives each its fixed text. */
export type KbStepFailure =
  | 'member-unreachable'
  | 'install-too-old'
  | 'not-member-install'
  | 'relay-unsupported'
  | 'kb-not-configured'
  | 'kb-other-remote'
  | 'secret-file-unavailable'
  | 'delivery-failed'
  | 'kb-setup-failed';

export class KbStepError extends Error {
  constructor(readonly reason: KbStepFailure) {
    super(reason);
    this.name = 'KbStepError';
  }
}

export type KbVerification = 'verified' | 'rejected' | 'unreachable' | 'unverified';

/** What kb-setup changed in the member's KB config, when it wrote one. */
export type KbMemberChange =
  | 'kb-config-created'
  | 'kb-config-replaced-sqlite'
  | 'kb-config-replaced-remote'
  | 'kb-config-replaced-token'
  | 'kb-config-replaced-unreadable';

const CHANGE_OF_PREVIOUS: Record<string, KbMemberChange> = {
  missing: 'kb-config-created',
  'not-http': 'kb-config-replaced-sqlite',
  'other-remote': 'kb-config-replaced-remote',
  'other-token': 'kb-config-replaced-token',
  unreadable: 'kb-config-replaced-unreadable',
};

export interface KbDelivery {
  verification: KbVerification;
  /** Set when kb-setup wrote the member's KB config; absent when it was already right. */
  change?: KbMemberChange;
}

export interface ProvisionKbDeps {
  exec(agent: Agent, command: string, timeoutMs: number): Promise<SSHExecResult>;
  resolveHome(agent: Agent): Promise<string | null>;
  /** Writes content to a fresh owner-only file on the member; returns its path. */
  stage(agent: Agent, content: string): Promise<string>;
  removeStaged(agent: Agent, filePath: string): Promise<void>;
  /** Starts a stopped cloud member; returns the member as registered afterwards. */
  ensureReady(agent: Agent): Promise<Agent>;
}

function defaultDeps(): ProvisionKbDeps {
  return {
    exec: (agent, command, timeoutMs) => getStrategy(agent).execCommand(command, timeoutMs),
    resolveHome: (agent) => getMemberHomeDir(agent),
    stage: (agent, content) => writeMemberSecretFile(agent, content, 'kb-token'),
    removeStaged: (agent, filePath) => removeMemberSecretFile(agent, filePath),
    ensureReady: (agent) => ensureCloudReady(agent),
  };
}

let depsOverride: ProvisionKbDeps | null = null;

/** Test-only: replace the transports. Pass null to restore. */
export function __setProvisionKbDeps(deps: ProvisionKbDeps | null): void {
  depsOverride = deps;
}

function deps(): ProvisionKbDeps {
  return depsOverride ?? defaultDeps();
}

const posixQuote = (s: string): string => `'${escapeShellArgInner(s)}'`;
const psQuote = (s: string): string => `'${escapePowerShellArgInner(s)}'`;

function osAndShell(agent: Agent): { targetOs: TargetOS; shell: ReturnType<typeof getAgentShell> } {
  return { targetOs: getAgentOS(agent) as TargetOS, shell: getAgentShell(agent) };
}

/**
 * `secret --set NAME --persist --expires-at <time|none> --allow --members * -y`
 * reading the staged file on stdin, then removing it whatever the outcome, and
 * exiting with the CLI's code. The value is only in the file. The record is plain
 * allow, all members, whatever was stored under the name on the member: policy
 * was applied on the orchestrator before the push. POSIX: a trap removes the
 * file if the shell exits early or is hung up on. Exported for tests.
 */
export function buildPushSecretCommand(binPath: string, name: string, expiresAt: string | null, staged: string, targetOs: TargetOS, shell: ReturnType<typeof getAgentShell>): string {
  const args = ['secret', '--set', name, '--persist', '--expires-at', expiresAt ?? 'none', '--allow', '--members', '*', '-y'];
  const s = posixQuote(staged);
  return memberCommandFor(targetOs, shell, {
    posix:
      `f=${s}; trap 'rm -f "$f"' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; ` +
      `${posixQuote(binPath)} ${args.map(posixQuote).join(' ')} < "$f" 2>&1`,
    // stderr is merged as text: under the encoded wrapper's Stop preference a
    // native stderr line would otherwise end the script before the cleanup.
    powershell:
      `$ErrorActionPreference = 'Continue'; $rc = 1; ` +
      `try { Get-Content -Raw -LiteralPath ${psQuote(staged)} | & ${psQuote(binPath)} ${args.map(psQuote).join(' ')} 2>&1 | ForEach-Object { "$_" }; $rc = $LASTEXITCODE } ` +
      `finally { Remove-Item -Force -LiteralPath ${psQuote(staged)} -ErrorAction SilentlyContinue }; exit $rc`,
  });
}

/** `kb-setup --remote <url> --token-ref NAME` on the member. Exported for tests. */
export function buildKbSetupCommand(binPath: string, remote: string, name: string, targetOs: TargetOS, shell: ReturnType<typeof getAgentShell>): string {
  const args = ['kb-setup', '--remote', remote, '--token-ref', name];
  return memberCommandFor(targetOs, shell, {
    posix: `${posixQuote(binPath)} ${args.map(posixQuote).join(' ')} 2>&1`,
    powershell: `$ErrorActionPreference = 'Continue'; & ${psQuote(binPath)} ${args.map(psQuote).join(' ')} 2>&1 | ForEach-Object { "$_" }; exit $LASTEXITCODE`,
  });
}

/** True when the member's CLI does not know an option or verb this step needs: an install older than this one. */
function isUnknownToOldInstall(r: SSHExecResult): boolean {
  const out = `${r.stdout}\n${r.stderr}`;
  return /Unknown option "--expires-at"/.test(out) || /unknown option 'kb-setup'/.test(out);
}

/** Last JSON object line of the kb-setup output, or null. */
function lastJson(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Everything that can fail without the value. May start a cloud member. */
export async function prepareKb(member: Agent, remote: string, secret: string): Promise<void> {
  // A relay member has no channel that writes a file without a command line.
  if (member.agentType === 'relay') throw new KbStepError('relay-unsupported');
  if (member.agentType === 'local') {
    const match = kbConfigMatch(remote, secret);
    if (match === 'match') return;
    throw new KbStepError(match === 'other-remote' ? 'kb-other-remote' : 'kb-not-configured');
  }
  const d = deps();
  let ready: Agent;
  try {
    ready = await d.ensureReady(member);
  } catch {
    throw new KbStepError('member-unreachable');
  }
  const home = await d.resolveHome(ready);
  if (!home) throw new KbStepError('member-unreachable');
  const { targetOs, shell } = osAndShell(ready);
  const probeDeps = { exec: (a: Agent, c: string, t?: number) => d.exec(a, c, t ?? PROBE_TIMEOUT_MS) };
  const probe = await probeMemberFleetVersion(ready, memberBinPath(home, targetOs, shell), probeDeps as unknown as MemberFleetInstallDeps);
  if (probe.kind === 'probe-failed') throw new KbStepError('member-unreachable');
  if (probe.kind !== 'installed' || isOlderThan(probe.version, KB_AUTH_MIN_MEMBER_VERSION)) throw new KbStepError('install-too-old');
  const marker = await probeMemberInstallMarker(ready, home, probeDeps);
  if (marker.kind === 'probe-failed') throw new KbStepError('member-unreachable');
  if (marker.kind === 'absent') throw new KbStepError('not-member-install');
}

/**
 * Hands the value to the member and verifies it. `member` is the member as read
 * after prepare. A failure after the push leaves the pushed secret on the member,
 * where it is unused until its KB config names it.
 */
export async function deliverKb(member: Agent, remote: string, secret: string, value: string, expiresAt: string | null): Promise<KbDelivery> {
  // Local: the core resolved the value through the orchestrator's store, which
  // is what this member's KB calls use. No KB call is made.
  if (member.agentType === 'local') return { verification: 'verified' };
  const d = deps();
  const home = await d.resolveHome(member);
  if (!home) throw new KbStepError('member-unreachable');
  const { targetOs, shell } = osAndShell(member);
  const binPath = memberBinPath(home, targetOs, shell);

  // A helper may print any ISO 8601 zone form (+0530); the member takes UTC.
  const pushExpiry = expiresAt === null ? null : new Date(expiresAt).toISOString();
  let staged: string;
  try {
    staged = await d.stage(member, value);
  } catch {
    throw new KbStepError('secret-file-unavailable');
  }
  let push: SSHExecResult;
  try {
    push = await d.exec(member, buildPushSecretCommand(binPath, secret, pushExpiry, staged, targetOs, shell), MEMBER_CLI_TIMEOUT_MS);
  } catch {
    await d.removeStaged(member, staged);
    throw new KbStepError('delivery-failed');
  }
  if (push.code !== 0) {
    // The command removes the file itself; this covers a shell that never got that far.
    await d.removeStaged(member, staged);
    throw new KbStepError(isUnknownToOldInstall(push) ? 'install-too-old' : 'delivery-failed');
  }

  let setup: SSHExecResult;
  try {
    setup = await d.exec(member, buildKbSetupCommand(binPath, remote, secret, targetOs, shell), MEMBER_CLI_TIMEOUT_MS);
  } catch {
    throw new KbStepError('kb-setup-failed');
  }
  if (isUnknownToOldInstall(setup)) throw new KbStepError('install-too-old');
  const result = lastJson(`${setup.stdout}\n${setup.stderr}`);
  const verification = result?.verification;
  if (setup.code !== 0 || !result || typeof verification !== 'string') throw new KbStepError('kb-setup-failed');
  const change = result.kbSetup === 'written' && typeof result.previous === 'string' ? CHANGE_OF_PREVIOUS[result.previous] : undefined;
  return {
    verification: (['verified', 'rejected', 'unreachable'] as const).includes(verification as never) ? verification as KbVerification : 'unverified',
    ...(change ? { change } : {}),
  };
}

