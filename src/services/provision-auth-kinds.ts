import {
  credentialResolve,
  lookupLiveSecret,
  type CredentialMeta,
  type LiveSecretRecord,
} from './credential-store.js';
import {
  dropCachedLiveToken,
  getLiveTokenDetail,
  liveSecretAllowsMember,
} from './live-secret-cache.js';
import { LiveSecretError } from './live-secret-runner.js';
import { getAgent } from './registry.js';
import { resolveMember } from '../utils/resolve-member.js';
import { appendLogRecord } from '../utils/log-helpers.js';
import { deliverKb, KbStepError, prepareKb } from './provision-kb.js';
import type { Agent } from '../types.js';

/**
 * provision_auth(kind, ...): gives a member a named secret from the orchestrator.
 * Named provisionAuthForKind because provisionAuth in src/tools/provision-auth.ts
 * is the provision_llm_auth tool, until that tool moves into this table.
 * An internal function, not an MCP tool. The steps every kind shares live here:
 * the secret is resolved on the orchestrator, its policy is applied before any
 * mint, and the result carries names only. Policy is the same for a remote and a
 * local member. How a value reaches a member is the kind's own, in the handler
 * table below.
 *
 * Order, so that a refused call runs no script:
 *   member -> handler -> params -> allowedMembers -> deny -> prepare
 *   -> member again -> allowedMembers -> deny -> rejected drop -> resolve -> deliver
 */

/** Why a handler step failed. Each has fixed text, so no handler text can reach a result or the log. */
const HANDLER_FAILURES = {
  'bad-input': 'the input for this kind is not valid',
  'delivery-failed': 'the secret could not be delivered to the member',
  'member-unreachable': 'the member could not be reached or started; check it with member_detail',
  'relay-unsupported': 'a relay member has no channel that delivers a secret without a command line, so it cannot be provisioned; use a remote (SSH) member',
  'secret-file-unavailable': 'could not write the token file on the member (SFTP unavailable, connection lost, or a disk or permission error in the member home); the token is sent only through that file. Check the member is reachable, its sshd has the SFTP subsystem, and its home is writable with free space, then try again',
  'install-too-old': 'the apra-fleet install on the member is missing or too old for this; run update_member {member_id, fleet_install: "auto"}, then try again',
  'not-member-install': 'the member runs a full apra-fleet install, not a member install, so the fleet does not manage it; replace it with update_member {member_id, fleet_install: "replace-full"} (or by hand, as update_member describes), then try again',
  'kb-not-configured': 'the KB config on the orchestrator does not take its token from this secret at this remote, and a local member shares that config, which this tool does not change; run kb_setup on the orchestrator with provider http, this remote and token {{secret.<the secret>}}',
  'kb-other-remote': 'the KB config on the orchestrator names a different remote, and a local member shares that config, which this tool does not change; pass that remote, or run kb_setup on the orchestrator to change it',
  'member-kb-other-remote': 'the member KB config names another remote; keep_member_kb leaves it as it is, so nothing was minted or pushed',
  'member-kb-local-store': 'the member KB config uses its local store; keep_member_kb leaves it as it is, so nothing was minted or pushed',
  'member-kb-unreadable': 'the member KB config could not be read; keep_member_kb leaves it as it is, so nothing was minted or pushed',
  'kb-setup-failed': 'the secret was stored on the member and stays there, but setting up the member KB to use it failed; run apra-fleet kb-setup --remote <url> --token-ref <secret> on the member to see why',
} as const;

export type ProvisionHandlerFailure = keyof typeof HANDLER_FAILURES;

/** Every handler failure reason, for callers that list them (the client typedefs). */
export const PROVISION_HANDLER_FAILURES = Object.keys(HANDLER_FAILURES) as ProvisionHandlerFailure[];

export type ProvisionKindFailure =
  | ProvisionHandlerFailure
  | 'member-not-found'
  | 'unknown-kind'
  | 'secret-not-found'
  | 'secret-unreadable'
  | 'secret-expired'
  | 'member-not-allowed'
  | 'policy-deny'
  | 'mint-failed';

/** A provisioning failure. The message names the member and secret, never a value. */
export class ProvisionAuthError extends Error {
  readonly code = 'E-PROVISION-AUTH';
  /** Set when delivery failed after the value was resolved: its expiry, null for none. A pushed copy may be left with it. */
  expiresAt?: string | null;
  constructor(readonly reason: ProvisionKindFailure, message: string) {
    super(message);
    this.name = 'ProvisionAuthError';
  }
}

/** How a handler fails: a reason from the closed list and no text. A new failure gets its fixed text in HANDLER_FAILURES. */
export class ProvisionHandlerError extends Error {
  constructor(readonly reason: ProvisionHandlerFailure) {
    super(reason);
    this.name = 'ProvisionHandlerError';
  }
}

/** Why a delivered value could not be verified, with fixed text as above. */
const VERIFICATION_FAILURES = {
  rejected: 'the receiving server refused the value',
  unreachable: 'the receiving server could not be reached',
  'not-configured': 'the member is not configured to use the value',
  unverified: 'the value could not be verified',
} as const;

export type ProvisionVerificationFailure = keyof typeof VERIFICATION_FAILURES;

export interface ProvisionKindInput {
  kind: string;
  member_id?: string;
  member_name?: string;
  /** A live or static secret on the orchestrator. */
  secret: string;
  /** kb: the KB server URL. */
  remote?: string;
  /** The server refused what this secret last gave out: a cached token is dropped and a new one minted. */
  reason?: 'rejected';
  /** kb: never rewrite a remote member KB config that names another remote or uses its local store. */
  keep_member_kb?: boolean;
}

/** What delivery changed on the member besides the secret, with fixed text. */
const MEMBER_CHANGES = {
  'kb-config-created': 'the member had no KB config; one was written that takes its token from this secret',
  'kb-config-replaced-sqlite': 'the member KB config used its local store; it now uses this remote, with its token from this secret',
  'kb-config-replaced-remote': 'the member KB config named another remote; it now names this one, with its token from this secret',
  'kb-config-replaced-token': 'the member KB config named this remote with another token source; it now takes its token from this secret',
  'kb-config-replaced-unreadable': 'the member KB config could not be read; it was replaced with one that takes its token from this secret',
} as const;

export type ProvisionMemberChange = keyof typeof MEMBER_CHANGES;

/** What a handler's deliver reports. Reasons only: there is no field for its own words. */
export type ProvisionKindDelivery =
  | { status: 'verified'; change?: ProvisionMemberChange }
  | { status: 'failed'; reason: ProvisionVerificationFailure; change?: ProvisionMemberChange };

export type ProvisionKindVerification =
  | { status: 'verified' }
  | { status: 'failed'; reason: ProvisionVerificationFailure; detail: string };

/** What provision_auth reports. The caller must act on verification.status. */
export interface ProvisionKindResult {
  member: { id: string; name: string };
  kind: string;
  secret: string;
  /** When the value expires; null for a static secret with no expiry. */
  expiresAt: string | null;
  verification: ProvisionKindVerification;
  /** What else delivery changed on the member, or null. Kept even when verification failed. */
  memberChange: { reason: ProvisionMemberChange; detail: string } | null;
}

export interface ProvisionKindContext<P> {
  member: Agent;
  secret: string;
  params: P;
}

/**
 * One kind of provisioning: the seam a kind plugs into. A handler branches on
 * member.agentType, because a local member shares the orchestrator's fleet server
 * and a remote member is reached only over SSH. A step fails by throwing a
 * ProvisionHandlerError; anything else it throws is reported as delivery-failed,
 * and its text is never used.
 */
export interface ProvisionKindHandler<P = unknown> {
  /** Checks the kind's own input and returns its params. Runs before anything else. */
  parse(input: ProvisionKindInput): P;
  /**
   * Anything that can fail without the value, such as an install version check.
   * Runs before the mint. It may change the host: starting a stopped cloud
   * member gives it a new address in the registry, so ctx.member is stale after
   * this. The secret and its policy may also change while it runs. The core reads
   * the member, the secret and the policy again afterwards.
   */
  prepare?(ctx: ProvisionKindContext<P>): Promise<void>;
  /** Hands the value on and verifies it. ctx.member is the member as read after prepare. */
  deliver(ctx: ProvisionKindContext<P> & { value: string; expiresAt: string | null }): Promise<ProvisionKindDelivery>;
}

/** A kb step's failure as a handler failure: the reason only. */
async function kbStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof KbStepError) throw new ProvisionHandlerError(err.reason);
    throw err;
  }
}

/**
 * kb: provision_kb_auth (src/services/provision-kb.ts). Policy is enforced by the
 * core on the orchestrator first: the pushed record is a plain static secret
 * with allow and all members.
 */
const kbHandler: ProvisionKindHandler<{ remote: string; keepMemberKb: boolean }> = {
  parse: (input) => {
    let url: URL | null = null;
    try {
      if (input.remote) url = new URL(input.remote);
    } catch { /* reported below */ }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new ProvisionHandlerError('bad-input');
    return { remote: input.remote as string, keepMemberKb: input.keep_member_kb === true };
  },
  prepare: (ctx) => kbStep(() => prepareKb(ctx.member, ctx.params.remote, ctx.secret, { keepMemberKb: ctx.params.keepMemberKb })),
  deliver: async (ctx) => {
    const { verification: v, change } = await kbStep(() => deliverKb(ctx.member, ctx.params.remote, ctx.secret, ctx.value, ctx.expiresAt));
    const extra = change ? { change } : {};
    return v === 'verified' ? { status: 'verified', ...extra } : { status: 'failed', reason: v, ...extra };
  },
};

const HANDLERS: Readonly<Record<string, ProvisionKindHandler<any>>> = { kb: kbHandler };

type SecretSource =
  | { live: LiveSecretRecord }
  | { value: string; expiresAt: string | null };

function refuseIfDenied(name: string, policy: CredentialMeta['network_policy']): void {
  if (policy === 'deny') {
    throw new ProvisionAuthError('policy-deny', `secret "${name}" has network_policy=deny, so it is not provisioned`);
  }
}

/** The secret, after its allowedMembers and deny checks. No script runs here. */
function readSecret(name: string, member: Agent): SecretSource {
  const unreadable = () => new ProvisionAuthError('secret-unreadable', `secret "${name}" could not be read from the credential store`);
  const notShared = () => new ProvisionAuthError('member-not-allowed', `secret "${name}" is not shared with member "${member.friendlyName}"`);
  let live: LiveSecretRecord | null;
  try {
    live = lookupLiveSecret(name);
  } catch {
    throw unreadable();
  }
  if (live) {
    if (!liveSecretAllowsMember(live, member.friendlyName)) throw notShared();
    refuseIfDenied(name, live.network_policy);
    return { live };
  }
  let resolved: ReturnType<typeof credentialResolve>;
  try {
    resolved = credentialResolve(name, member.friendlyName);
  } catch {
    throw unreadable();
  }
  if (!resolved) throw new ProvisionAuthError('secret-not-found', `secret "${name}" does not exist on the orchestrator`);
  if ('denied' in resolved) throw notShared();
  if ('expired' in resolved) throw new ProvisionAuthError('secret-expired', resolved.expired);
  refuseIfDenied(name, resolved.meta.network_policy);
  return { value: resolved.plaintext, expiresAt: resolved.meta.expiresAt ?? null };
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

/** Runs a handler step. Only a known reason survives a failure, with its fixed text. */
async function handlerStep<T>(step: () => T | Promise<T>, kind: string, name: string, member: Agent): Promise<T> {
  try {
    return await step();
  } catch (err) {
    const known = err instanceof ProvisionHandlerError && Object.hasOwn(HANDLER_FAILURES, err.reason);
    const reason: ProvisionHandlerFailure = known ? err.reason : 'delivery-failed';
    throw new ProvisionAuthError(reason, `${HANDLER_FAILURES[reason]} (kind "${kind}", secret "${name}", member "${member.friendlyName}")`);
  }
}

function verificationOf(delivery: ProvisionKindDelivery): ProvisionKindVerification {
  if (delivery.status === 'verified') return { status: 'verified' };
  const reason: ProvisionVerificationFailure = Object.hasOwn(VERIFICATION_FAILURES, delivery.reason) ? delivery.reason : 'unverified';
  return { status: 'failed', reason, detail: VERIFICATION_FAILURES[reason] };
}

async function run(
  input: ProvisionKindInput,
  handlers: Readonly<Record<string, ProvisionKindHandler<any>>>,
): Promise<ProvisionKindResult> {
  const resolved = resolveMember(input.member_id, input.member_name);
  if (typeof resolved === 'string') throw new ProvisionAuthError('member-not-found', resolved);
  let member = resolved;
  const { kind, secret: name } = input;
  if (!Object.hasOwn(handlers, kind)) throw new ProvisionAuthError('unknown-kind', `unknown provisioning kind "${kind}"`);
  const handler = handlers[kind];
  if (!name) throw new ProvisionAuthError('bad-input', 'secret names the secret to provision, and is required');
  if (input.reason !== undefined && input.reason !== 'rejected') throw new ProvisionAuthError('bad-input', `unknown reason "${String(input.reason)}"`);
  const params = await handlerStep(() => handler.parse(input), kind, name, member);

  let source = readSecret(name, member);
  if (handler.prepare) {
    const ctx = { member, secret: name, params };
    await handlerStep(() => handler.prepare!(ctx), kind, name, member);
    const fresh = getAgent(member.id);
    if (!fresh) throw new ProvisionAuthError('member-not-found', `member "${member.friendlyName}" is no longer registered`);
    member = fresh;
    source = readSecret(name, member);
  }

  // After the policy checks: a refused caller must not be able to change the cache.
  if (input.reason === 'rejected' && 'live' in source && dropCachedLiveToken(name)) {
    appendLogRecord('info', { tag: 'provision-auth', msg: `dropped the cached token of live secret "${name}": a rejection was reported for member "${member.friendlyName}"` });
  }

  const { value, expiresAt } = await resolveValue(name, source);
  const deliveredTo = member;
  let delivery: ProvisionKindDelivery;
  try {
    delivery = await handlerStep(() => handler.deliver({ member: deliveredTo, secret: name, params, value, expiresAt }), kind, name, member);
  } catch (err) {
    if (err instanceof ProvisionAuthError) err.expiresAt = expiresAt;
    throw err;
  }
  const change = delivery.change !== undefined && Object.hasOwn(MEMBER_CHANGES, delivery.change) ? delivery.change : null;
  return {
    member: { id: member.id, name: member.friendlyName },
    kind,
    secret: name,
    expiresAt,
    verification: verificationOf(delivery),
    memberChange: change ? { reason: change, detail: MEMBER_CHANGES[change] } : null,
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
    const verification = result.verification;
    appendLogRecord(verification.status === 'verified' ? 'info' : 'warn', {
      tag: 'provision-auth',
      msg: `kind=${input.kind} member="${result.member.name}" secret="${result.secret}" expires=${result.expiresAt ?? 'none'} verification=${verification.status === 'verified' ? 'verified' : `failed: ${verification.reason}`}`,
    });
    return result;
  } catch (err) {
    const failure = err instanceof ProvisionAuthError
      ? err
      : new ProvisionAuthError('delivery-failed', `secret "${input.secret}" could not be delivered to member "${member}"`);
    appendLogRecord('warn', { tag: 'provision-auth', msg: `kind=${input.kind} member="${member}" secret="${input.secret}" failed: ${failure.reason}: ${failure.message}` });
    throw failure;
  }
}
