/**
 * `apra-fleet spoke` (apra-fleet-jfn): runs this machine as an outbound
 * hub-connected spoke, composing the pieces built across
 * apra-fleet-us9.6/us9.7/us9.12 into one running process:
 *  - hub-client.ts: the outbound SSE connection, presence, heartbeat.
 *  - relay-executor.ts: FULFILLS execute_command.request envelopes
 *    addressed to a member THIS machine hosts (found via
 *    getAgentForMember, matching registry.json entries by relayMemberId).
 *  - relay-request.ts's PendingRelayRequests: lets this machine ORIGINATE
 *    a relayed request (via RelayStrategy, see relay-context.ts) and
 *    resolve the correlated result delivered back over its own stream.
 *
 * Reads hub-credentials.json (written by `apra-fleet join <token>`,
 * src/cli/join.ts) -- `apra-fleet join` must run first.
 *
 * `originMemberId` (which hub member this machine acts AS when
 * ORIGINATING a relayed request) is deliberately an explicit required
 * input here, not inferred: a machine can host multiple members, and
 * which one "owns" an outbound relay call is a real, not-yet-designed
 * product question (which local Agent initiated the action?) -- see
 * apra-fleet-jfn's notes. This keeps the gap honest rather than guessing.
 */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { HUB_CREDENTIALS_PATH, type HubCredentials } from './join.js';
import { createHubClient, type HubClientDeps, type HubClientHandle, type MemberSnapshotEntry } from '../services/hub-client.js';
import { createRelayExecutor, type RelayExecutorDeps } from '../services/relay-executor.js';
import { PendingRelayRequests, composeEnvelopeHandler, type RelayRequestDeps } from '../services/relay-request.js';
import { setRelayContext } from '../services/relay-context.js';
import { getAllAgents } from '../services/registry.js';
import type { Agent } from '../types.js';

export interface SpokeDeps {
  fetch: typeof fetch;
  hostname(): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
  readCredentials(): HubCredentials | null;
  getAgentForMember(memberId: string): Agent | null;
  getMemberSnapshot(): MemberSnapshotEntry[];
  onLog(message: string): void;
}

const realDeps: SpokeDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  hostname: () => os.hostname(),
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as any),
  random: () => Math.random(),
  readCredentials(): HubCredentials | null {
    if (!fs.existsSync(HUB_CREDENTIALS_PATH)) return null;
    try {
      return JSON.parse(fs.readFileSync(HUB_CREDENTIALS_PATH, 'utf-8')) as HubCredentials;
    } catch {
      return null;
    }
  },
  getAgentForMember(memberId: string): Agent | null {
    return getAllAgents().find((a) => a.agentType === 'relay' && a.relayMemberId === memberId)
      ?? getAllAgents().find((a) => a.relayMemberId === memberId)
      ?? null;
  },
  getMemberSnapshot(): MemberSnapshotEntry[] {
    return getAllAgents()
      .filter((a) => a.relayMemberId)
      .map((a) => ({ memberId: a.relayMemberId!, status: 'online' }));
  },
  onLog: (msg) => process.stderr.write(`[spoke] ${msg}\n`),
};

export interface SpokeHandle {
  hubClient: HubClientHandle;
  stop(): void;
}

/**
 * Starts the spoke process. `originMemberId` identifies which hub member
 * this machine acts as when ORIGINATING a relayed request (see module
 * docstring). Returns null (and logs/exits) if no hub credentials exist.
 */
export function runSpoke(originMemberId: string, deps: SpokeDeps = realDeps): SpokeHandle | null {
  const credentials = deps.readCredentials();
  if (!credentials) {
    deps.onLog('No hub credentials found. Run `apra-fleet join <token>` first.');
    return null;
  }

  const registry = new PendingRelayRequests();
  const relayRequestDeps: RelayRequestDeps = {
    workspaceId: credentials.workspaceId,
    originMemberId,
    now: deps.now,
    submitEnvelope: async (envelope) => {
      const res = await deps.fetch(`${credentials.hubUrl}/ws/${credentials.workspaceId}/envelopes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.jwt}` },
        body: JSON.stringify(envelope),
      });
      return { ok: res.ok, status: res.status };
    },
  };
  setRelayContext({ deps: relayRequestDeps, registry });

  const executorDeps: RelayExecutorDeps = {
    workspaceId: credentials.workspaceId,
    machineId: credentials.machineId,
    getAgentForMember: deps.getAgentForMember,
    submitEnvelope: async (envelope) => {
      await deps.fetch(`${credentials.hubUrl}/ws/${credentials.workspaceId}/envelopes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.jwt}` },
        body: JSON.stringify(envelope),
      });
    },
    now: deps.now,
    generateEnvelopeId: () => crypto.randomUUID(),
  };
  const fulfiller = createRelayExecutor(executorDeps);
  const onEnvelope = composeEnvelopeHandler(registry, fulfiller);

  const hubClientDeps: HubClientDeps = {
    fetch: deps.fetch,
    now: deps.now,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    random: deps.random,
    hubUrl: credentials.hubUrl,
    machineId: credentials.machineId,
    workspaceId: credentials.workspaceId,
    jwt: credentials.jwt,
    getMemberSnapshot: deps.getMemberSnapshot,
    onEnvelope,
    onLog: deps.onLog,
  };
  const hubClient = createHubClient(hubClientDeps);

  return {
    hubClient,
    stop(): void {
      hubClient.stop();
      registry.cancelAll('spoke stopped');
      setRelayContext(null);
    },
  };
}

export async function runSpokeCli(args: string[], deps: SpokeDeps = realDeps): Promise<void> {
  const originMemberId = args[0];
  if (!originMemberId) {
    console.error('Usage: apra-fleet spoke <origin-member-id>');
    console.error('  <origin-member-id>: the hub member this machine acts as when originating relayed requests.');
    process.exitCode = 1;
    return;
  }
  const handle = runSpoke(originMemberId, deps);
  if (!handle) {
    process.exitCode = 1;
    return;
  }
  console.log('Spoke mode running. Press Ctrl+C to stop.');
  process.on('SIGINT', () => { handle.stop(); process.exit(0); });
  process.on('SIGTERM', () => { handle.stop(); process.exit(0); });
}
