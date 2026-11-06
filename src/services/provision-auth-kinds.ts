import { collectOobConfirm } from './auth-socket.js';
import {
  credentialResolve,
  lookupLiveSecret,
  type LiveSecretRecord,
} from './credential-store.js';
import {
  dropLiveTokenMintedBefore,
  getLiveTokenDetail,
  liveSecretAllowsMember,
} from './live-secret-cache.js';
import { LiveSecretError } from './live-secret-runner.js';
import { resolveMember } from '../utils/resolve-member.js';
import { appendLogRecord } from '../utils/log-helpers.js';
import type { Agent } from '../types.js';

/**
 * provision_auth(kind, ...): gives a member a named secret from the orchestrator.
 * Named provisionAuthForKind because provisionAuth in src/tools/provision-auth.ts
 * is the provision_llm_auth tool, until that tool moves into this table.
 * An internal function, not an MCP tool. The steps every kind shares live here:
 * the secret is resolved on the orchestrator, its policy is applied before any
 * mint or prompt, and the result carries names only. How a value reaches a member
 * is the kind's own, in the handler table below.
 *
 * Order, so that a refused call runs no script and shows no prompt:
 *   member -> handler -> params -> allowedMembers -> deny -> prepare -> confirm
 *   -> rejected drop -> resolve -> deliver
 */

export type ProvisionKindFailure =
  | 'bad-input'
  | 'member-not-found'
  | 'unknown-kind'
  | 'secret-not-found'
  | 'secret-unreadable'
  | 'secret-expired'
  | 'member-not-allowed'
  | 'policy-deny'
  | 'confirm-declined'
  | 'confirm-unavailable'
  | 'mint-failed'
  | 'not-available'
  | 'delivery-failed';

/** A provisioning failure. The message names the member and secret, never a value. */
export class ProvisionAuthError extends Error {
  readonly code = 'E-PROVISION-AUTH';
  constructor(readonly reason: ProvisionKindFailure, message: string) {
    super(message);
    this.name = 'ProvisionAuthError';
  }
}

export interface ProvisionKindInput {
  kind: string;
  member_id?: string;
  member_name?: string;
  /** A live or static secret on the orchestrator. */
  secret: string;
  /** kb: the KB server URL. */
  remote?: string;
  /** The server refused the token this secret last gave out. */
  reason?: 'rejected';
  /**
   * With reason 'rejected': a time on the orchestrator's clock at or after the
   * rejection, such as when the orchestrator learned of it. Default: now. A
   * member's own clock must not be used: if it runs behind, the rejected token
   * looks newer than the rejection and is pushed again. A late time only costs
   * one extra mint.
   */
  rejected_at?: string;
}

export interface ProvisionKindVerification {
  status: 'verified' | 'failed';
  /** Names only: scrubbed of the value before it reaches the result or the log. */
  detail?: string;
}

/** What provision_auth reports. The caller must act on verification.status. */
export interface ProvisionKindResult {
  member: { id: string; name: string };
  kind: string;
  secret: string;
  /** When the value expires; null for a static secret with no expiry. */
  expiresAt: string | null;
  verification: ProvisionKindVerification;
}

export interface ProvisionKindContext<P> {
  member: Agent;
  secret: string;
  params: P;
}

/**
 * One kind of provisioning: the seam a kind plugs into. A handler branches on
 * member.agentType, because a local member shares the orchestrator's fleet server
 * and a remote member is reached only over SSH.
 */
export interface ProvisionKindHandler<P = unknown> {
  /** Checks the kind's own input and returns its params. Throws 'bad-input'. Runs before anything else. */
  parse(input: ProvisionKindInput): P;
  /** Where the value goes, for the confirmation prompt. Names and hosts only. */
  describe(params: P): string;
  /** Anything that can fail without the value, such as an install version check. Runs before the prompt and the mint. */
  prepare?(ctx: ProvisionKindContext<P>): Promise<void>;
  /** Hands the value on and verifies it. Throw a ProvisionAuthError to fail; any other error is reported without its text. */
  deliver(ctx: ProvisionKindContext<P> & { value: string; expiresAt: string | null }): Promise<ProvisionKindVerification>;
}

function parseKbParams(input: ProvisionKindInput): { remote: string } {
  const remote = input.remote;
  let url: URL | null = null;
  try {
    if (remote) url = new URL(remote);
  } catch { /* reported below */ }
  if (!remote || !url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new ProvisionAuthError('bad-input', 'kind "kb" needs remote: the KB server\'s http(s) URL');
  }
  return { remote };
}

function kbNotAvailable(): ProvisionAuthError {
  return new ProvisionAuthError('not-available', 'delivering a KB token to a member is not available yet');
}

const kbHandler: ProvisionKindHandler<{ remote: string }> = {
  parse: parseKbParams,
  describe: ({ remote }) => `KB token for ${new URL(remote).origin}`,
  // The delivery comes with provision_kb_auth, which fills in prepare (the install
  // version check) and deliver (local: verify only; remote: push the token, set up
  // the KB, verify). Refusing in prepare means no prompt and no mint until then.
  prepare: async () => { throw kbNotAvailable(); },
  deliver: async () => { throw kbNotAvailable(); },
};

const HANDLERS: Readonly<Record<string, ProvisionKindHandler<any>>> = { kb: kbHandler };

type SecretSource =
  | { live: LiveSecretRecord; policy: LiveSecretRecord['network_policy'] }
  | { value: string; expiresAt: string | null; policy: LiveSecretRecord['network_policy'] };

/** The secret and its policy, after the allowedMembers check. No script runs here. */
function readSecret(name: string, member: Agent): SecretSource {
  const unreadable = () => new ProvisionAuthError('secret-unreadable', `secret "${name}" could not be read from the credential store`);
  let live: LiveSecretRecord | null;
  try {
    live = lookupLiveSecret(name);
  } catch {
    throw unreadable();
  }
  if (live) {
    if (!liveSecretAllowsMember(live, member.friendlyName)) {
      throw new ProvisionAuthError('member-not-allowed', `secret "${name}" is not shared with member "${member.friendlyName}"`);
    }
    return { live, policy: live.network_policy };
  }
  let resolved: ReturnType<typeof credentialResolve>;
  try {
    resolved = credentialResolve(name, member.friendlyName);
  } catch {
    throw unreadable();
  }
  if (!resolved) throw new ProvisionAuthError('secret-not-found', `secret "${name}" does not exist on the orchestrator`);
  if ('denied' in resolved) {
    throw new ProvisionAuthError('member-not-allowed', `secret "${name}" is not shared with member "${member.friendlyName}"`);
  }
  if ('expired' in resolved) throw new ProvisionAuthError('secret-expired', resolved.expired);
  return { value: resolved.plaintext, expiresAt: resolved.meta.expiresAt ?? null, policy: resolved.meta.network_policy };
}

async function confirmEgress(name: string, member: Agent, kind: string, what: string): Promise<void> {
  const { confirmed, terminalUnavailable } = await collectOobConfirm(name, {
    command: `provision ${kind} auth: ${what}`,
    memberName: member.friendlyName,
  });
  if (confirmed) return;
  if (terminalUnavailable) {
    throw new ProvisionAuthError('confirm-unavailable', `secret "${name}" has network_policy=confirm and could not be confirmed (terminal unavailable)`);
  }
  throw new ProvisionAuthError('confirm-declined', `secret "${name}" has network_policy=confirm and was not confirmed`);
}

function rejectionTime(input: ProvisionKindInput): number {
  if (input.rejected_at === undefined) return Date.now();
  const ms = Date.parse(input.rejected_at);
  if (Number.isNaN(ms)) throw new ProvisionAuthError('bad-input', 'rejected_at is not a valid time');
  return ms;
}

async function resolveValue(name: string, source: SecretSource): Promise<{ value: string; expiresAt: string | null }> {
  if (!('live' in source)) return source;
  try {
    const { token, expiresAt } = await getLiveTokenDetail(name, source.live);
    return { value: token, expiresAt };
  } catch (err) {
    // A LiveSecretError's message is leak-free by contract; anything else is not quoted.
    const detail = err instanceof LiveSecretError ? err.message : `live secret "${name}" could not be minted`;
    throw new ProvisionAuthError('mint-failed', detail);
  }
}

function scrub(text: string, value: string, name: string): string {
  return value.length > 0 ? text.replaceAll(value, `[REDACTED:${name}]`) : text;
}

/** Runs a handler step: its own typed error stands, anything else loses its text. */
async function handlerStep<T>(step: () => Promise<T>, name: string, member: Agent, value = ''): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof ProvisionAuthError) {
      throw new ProvisionAuthError(err.reason, scrub(err.message, value, name));
    }
    throw new ProvisionAuthError('delivery-failed', `secret "${name}" could not be delivered to member "${member.friendlyName}"`);
  }
}

async function run(
  input: ProvisionKindInput,
  handlers: Readonly<Record<string, ProvisionKindHandler<any>>>,
): Promise<ProvisionKindResult> {
  const member = resolveMember(input.member_id, input.member_name);
  if (typeof member === 'string') throw new ProvisionAuthError('member-not-found', member);
  if (!Object.hasOwn(handlers, input.kind)) throw new ProvisionAuthError('unknown-kind', `unknown provisioning kind "${input.kind}"`);
  const handler = handlers[input.kind];
  const name = input.secret;
  if (!name) throw new ProvisionAuthError('bad-input', 'secret names the secret to provision, and is required');
  if (input.reason !== undefined && input.reason !== 'rejected') throw new ProvisionAuthError('bad-input', `unknown reason "${String(input.reason)}"`);
  if (input.rejected_at !== undefined && input.reason !== 'rejected') throw new ProvisionAuthError('bad-input', 'rejected_at needs reason "rejected"');
  const rejectedAtMs = input.reason === 'rejected' ? rejectionTime(input) : null;
  const params = handler.parse(input);
  const ctx: ProvisionKindContext<unknown> = { member, secret: name, params };

  const source = readSecret(name, member);
  if (source.policy === 'deny') {
    throw new ProvisionAuthError('policy-deny', `secret "${name}" has network_policy=deny, so it cannot leave the orchestrator`);
  }
  if (handler.prepare) await handlerStep(() => handler.prepare!(ctx), name, member);
  if (source.policy === 'confirm') await confirmEgress(name, member, input.kind, handler.describe(params));

  // After the policy checks: a refused caller must not be able to change the cache.
  if (rejectedAtMs !== null && 'live' in source && dropLiveTokenMintedBefore(name, rejectedAtMs)) {
    appendLogRecord('info', { tag: 'provision-auth', msg: `dropped the cached token of live secret "${name}": minted before a rejection reported for member "${member.friendlyName}"` });
  }

  const { value, expiresAt } = await resolveValue(name, source);
  const verification = await handlerStep(() => handler.deliver({ ...ctx, value, expiresAt }), name, member, value);
  return {
    member: { id: member.id, name: member.friendlyName },
    kind: input.kind,
    secret: name,
    expiresAt,
    verification: {
      status: verification.status,
      ...(verification.detail !== undefined ? { detail: scrub(verification.detail, value, name) } : {}),
    },
  };
}

/**
 * Provision `input.secret` to a member. Throws a ProvisionAuthError when refused
 * or failed. `handlers` replaces the kind table, for tests.
 */
export async function provisionAuthForKind(
  input: ProvisionKindInput,
  handlers: Readonly<Record<string, ProvisionKindHandler<any>>> = HANDLERS,
): Promise<ProvisionKindResult> {
  const member = input.member_id ?? input.member_name;
  try {
    const result = await run(input, handlers);
    appendLogRecord('info', { tag: 'provision-auth', msg: `kind=${input.kind} member="${result.member.name}" secret="${result.secret}" expires=${result.expiresAt ?? 'none'} verification=${result.verification.status}` });
    return result;
  } catch (err) {
    const failure = err instanceof ProvisionAuthError
      ? err
      : new ProvisionAuthError('delivery-failed', `secret "${input.secret}" could not be delivered to member "${member}"`);
    appendLogRecord('warn', { tag: 'provision-auth', msg: `kind=${input.kind} member="${member}" secret="${input.secret}" failed: ${failure.reason}: ${failure.message}` });
    throw failure;
  }
}
