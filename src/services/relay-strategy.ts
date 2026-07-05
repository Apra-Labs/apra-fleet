/**
 * RelayStrategy (apra-fleet-jfn): the AgentStrategy implementation for an
 * agent whose commands run on a DIFFERENT machine reached via the hub
 * relay (Agent.agentType === 'relay', Agent.relayMemberId identifying the
 * hub member), rather than via SSH (RemoteStrategy) or a local child
 * process (LocalStrategy). Uses relay-request.ts's
 * submitAndAwaitResult() against THIS machine's own outbound hub
 * connection (relay-context.ts), addressed to `agent.relayMemberId`.
 *
 * Deliberately narrow: only execCommand and a best-effort testConnection
 * (a trivial relayed command, reusing execCommand) are implemented and
 * tested here. transferFiles/receiveFiles/deleteFiles throw a clear
 * "not yet supported over relay" error rather than fabricating success --
 * file-transfer-relay.ts's sendFileOverRelay exists and could wire into
 * transferFiles's send (push) direction as a small follow-on, but
 * receiveFiles has no pull-direction wire-protocol kind designed yet
 * (file-transfer-relay.ts is push-only), so leaving all three unsupported
 * keeps the interface's behavior symmetric and honest rather than
 * partially working in a way that's easy to miss.
 */
import type { Agent, SSHExecResult, TransferResult } from '../types.js';
import type { AgentStrategy } from './strategy.js';
import { submitAndAwaitResult } from './relay-request.js';
import { getRelayContext } from './relay-context.js';

const DEFAULT_EXEC_TTL_MS = 30000;

interface ExecuteCommandResultPayload {
  status: 'ok' | 'member_not_found' | 'invalid_request' | 'error';
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: string;
}

export class RelayStrategy implements AgentStrategy {
  constructor(private agent: Agent) {}

  private requireRelayMemberId(): string {
    if (!this.agent.relayMemberId) {
      throw new Error(`Agent "${this.agent.friendlyName}" has agentType 'relay' but no relayMemberId configured.`);
    }
    return this.agent.relayMemberId;
  }

  private requireRelayContext() {
    const ctx = getRelayContext();
    if (!ctx) {
      throw new Error('This machine is not running in spoke mode -- no relay connection configured (see src/cli/spoke.ts).');
    }
    return ctx;
  }

  async execCommand(command: string, timeoutMs = 30000, maxTotalMs?: number, onPidCaptured?: (pid: number) => void, abortSignal?: AbortSignal): Promise<SSHExecResult> {
    void onPidCaptured; // PID capture for relayed commands surfaces via execute_command.long_running_update (relay-executor.ts), not this synchronous return path
    void abortSignal; // TODO(apra-fleet-jfn follow-on): cancellation over relay has no wire-protocol kind yet; not silently ignored, just not built
    const targetMemberId = this.requireRelayMemberId();
    const { deps, registry } = this.requireRelayContext();

    const timeout = maxTotalMs ?? timeoutMs;
    const result = await submitAndAwaitResult(
      deps,
      registry,
      'execute_command.request',
      targetMemberId,
      { memberId: targetMemberId, command, timeoutMs, maxTotalMs },
      DEFAULT_EXEC_TTL_MS,
      timeout,
    ) as ExecuteCommandResultPayload;

    if (result.status === 'ok') {
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
    }
    throw new Error(`Relayed command failed (${result.status}): ${result.error ?? result.status}`);
  }

  async transferFiles(): Promise<TransferResult> {
    throw new Error('File transfer over relay is not yet supported (apra-fleet-jfn follow-on; see src/services/file-transfer-relay.ts).');
  }

  async receiveFiles(): Promise<TransferResult> {
    throw new Error('File transfer over relay is not yet supported (apra-fleet-jfn follow-on; see src/services/file-transfer-relay.ts).');
  }

  async deleteFiles(): Promise<void> {
    throw new Error('File deletion over relay is not yet supported (apra-fleet-jfn follow-on).');
  }

  async testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.execCommand('echo apra-fleet-relay-ping', 10000);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
    }
  }

  close(): void {
    // No-op: the shared hub connection's lifecycle belongs to spoke.ts's
    // main loop, not to any single Agent's strategy instance.
  }
}
