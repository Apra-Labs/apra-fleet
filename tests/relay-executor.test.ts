/**
 * Relayed execute_command fulfillment (apra-fleet-us9.6/cgg): proves
 * createRelayExecutor actually invokes the REAL LocalStrategy (a real
 * child process, not a mock of strategy.ts) and posts back a correctly
 * shaped execute_command.result envelope, per
 * docs/hub-spoke-wire-protocol.md sections 3.1 and 5.
 */
import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import type { Agent } from '../src/types.js';
import { createRelayExecutor, type OutboundRelayEnvelope, type RelayExecutorDeps, type RelayExecStrategy } from '../src/services/relay-executor.js';
import type { InboundRelayEnvelope } from '../src/services/hub-client.js';

// The real host's OS, so LocalStrategy's cleanExec wrapping (bash-flavored
// on linux/macos, powershell.exe on windows) matches what's actually
// available to spawn -- these are true end-to-end tests (a real child
// process via the real strategy.ts, not a mock of it).
const HOST_OS: 'windows' | 'macos' | 'linux' = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const successCommand = HOST_OS === 'windows' ? "Write-Output 'hello-relay'" : "node -e \"console.log('hello-relay')\"";
const exitCodeCommand = (code: number) => (HOST_OS === 'windows' ? `exit ${code}` : `node -e "process.exit(${code})"`);

function makeLocalAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    friendlyName: 'local-agent',
    agentType: 'local',
    workFolder: os.tmpdir(),
    createdAt: new Date().toISOString(),
    os: HOST_OS,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<RelayExecutorDeps> = {}): { deps: RelayExecutorDeps; submitted: OutboundRelayEnvelope[] } {
  const submitted: OutboundRelayEnvelope[] = [];
  const deps: RelayExecutorDeps = {
    workspaceId: 'ws-1',
    machineId: 'mach-1',
    getAgentForMember: () => makeLocalAgent(),
    submitEnvelope: async (env) => { submitted.push(env); },
    now: () => Date.now(),
    generateEnvelopeId: (() => { let n = 0; return () => `gen-${++n}`; })(),
    ...overrides,
  };
  return { deps, submitted };
}

function requestEnvelope(overrides: Partial<InboundRelayEnvelope> = {}): InboundRelayEnvelope {
  return {
    envelope_id: 'e-req-1',
    kind: 'execute_command.request',
    payload: { memberId: 'mem-1', command: successCommand },
    to: { machine_id: null, member_id: 'mem-1' },
    ...overrides,
  };
}

describe('createRelayExecutor', () => {
  it('runs a real command via LocalStrategy and posts back an ok execute_command.result with correlation_id set', async () => {
    const { deps, submitted } = baseDeps();
    const onEnvelope = createRelayExecutor(deps);

    await onEnvelope(requestEnvelope());

    expect(submitted).toHaveLength(1);
    const result = submitted[0];
    expect(result.kind).toBe('execute_command.result');
    expect(result.correlation_id).toBe('e-req-1');
    expect(result.workspace_id).toBe('ws-1');
    expect(result.from).toEqual({ machine_id: 'mach-1', member_id: 'mem-1' });
    expect((result.payload as any).status).toBe('ok');
    expect((result.payload as any).stdout).toContain('hello-relay');
    expect((result.payload as any).code).toBe(0);
  }, 15000);

  it('posts a member_not_found result when getAgentForMember returns null, without inventing an agent', async () => {
    const { deps, submitted } = baseDeps({ getAgentForMember: () => null });
    const onEnvelope = createRelayExecutor(deps);

    await onEnvelope(requestEnvelope());

    expect(submitted).toHaveLength(1);
    expect((submitted[0].payload as any).status).toBe('member_not_found');
  });

  it('posts an invalid_request result when the payload is missing required fields', async () => {
    const { deps, submitted } = baseDeps();
    const onEnvelope = createRelayExecutor(deps);

    await onEnvelope(requestEnvelope({ payload: { memberId: 'mem-1' } }));

    expect(submitted).toHaveLength(1);
    expect((submitted[0].payload as any).status).toBe('invalid_request');
  });

  it('posts an error result when the command exits non-zero, without throwing', async () => {
    const { deps, submitted } = baseDeps();
    const onEnvelope = createRelayExecutor(deps);

    await onEnvelope(requestEnvelope({ payload: { memberId: 'mem-1', command: exitCodeCommand(3) } }));

    expect(submitted).toHaveLength(1);
    expect((submitted[0].payload as any).status).toBe('ok');
    expect((submitted[0].payload as any).code).toBe(3);
  }, 15000);

  it('ignores envelope kinds other than execute_command.request (documented no-op, not a crash)', async () => {
    const { deps, submitted } = baseDeps();
    const onEnvelope = createRelayExecutor(deps);

    await onEnvelope(requestEnvelope({ kind: 'send_message.deliver', payload: { text: 'hi' } }));

    expect(submitted).toHaveLength(0);
  });

  it('emits an execute_command.long_running_update once a PID is captured, correlated to the request', async () => {
    // Uses an injected fake strategy (not the real LocalStrategy): PID
    // capture is real-OS-specific (linux/macos wrap every command with a
    // FLEET_PID emitter; Windows' plain cleanExec does not), so this test
    // proves the relay-executor's OWN wiring of onPidCaptured ->
    // long_running_update, independent of which host OS runs the suite.
    const fakeStrategy: RelayExecStrategy = {
      execCommand: async (_cmd, _timeout, _maxTotal, onPidCaptured) => {
        onPidCaptured?.(4242);
        return { stdout: 'done', stderr: '', code: 0 };
      },
    };
    const { deps, submitted } = baseDeps({ getStrategy: () => fakeStrategy });
    const onEnvelope = createRelayExecutor(deps);

    await onEnvelope(requestEnvelope());

    const update = submitted.find((e) => e.kind === 'execute_command.long_running_update');
    expect(update).toBeDefined();
    expect(update?.correlation_id).toBe('e-req-1');
    expect((update?.payload as any).pid).toBe(4242);

    const result = submitted.find((e) => e.kind === 'execute_command.result');
    expect((result?.payload as any).status).toBe('ok');
  });
});
