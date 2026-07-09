/**
 * RelayStrategy (apra-fleet-jfn): the AgentStrategy implementation for an
 * agent whose commands run on a DIFFERENT machine reached via the hub
 * relay (Agent.agentType === 'relay', Agent.relayMemberId identifying the
 * hub member), rather than via SSH (RemoteStrategy) or a local child
 * process (LocalStrategy). Uses relay-request.ts's
 * submitAndAwaitResult() against THIS machine's own outbound hub
 * connection (relay-context.ts), addressed to `agent.relayMemberId`.
 *
 * transferFiles (apra-fleet-8yn) sends each local file via
 * file-transfer-relay.ts's sendFileOverRelay -- the push (send) direction,
 * proven end-to-end in tests/hub-service/file-transfer-e2e.test.ts.
 * receiveFiles/deleteFiles still throw "not yet supported over relay":
 * there is no pull-direction wire-protocol kind designed yet (
 * file-transfer-relay.ts is push-only), and deletion has no relay kind at
 * all -- honest gaps, not fabricated success.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Agent, SSHExecResult, TransferResult } from '../types.js';
import type { AgentStrategy } from './strategy.js';
import { submitAndAwaitResult } from './relay-request.js';
import { getRelayContext } from './relay-context.js';
import { sendFileOverRelay, type FileTransferDeps } from './file-transfer-relay.js';

const DEFAULT_FILE_TRANSFER_TIMEOUT_MS = 60000;

interface FileTransferResultPayload {
  status: 'ok' | 'corrupt' | 'incomplete' | 'error';
  error?: string;
}

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

  async transferFiles(localPaths: string[], destinationPath?: string, abortSignal?: AbortSignal): Promise<TransferResult> {
    const targetMemberId = this.requireRelayMemberId();
    const ctx = this.requireRelayContext();
    const fileTransferDeps: FileTransferDeps = {
      workspaceId: ctx.deps.workspaceId,
      originMemberId: ctx.deps.originMemberId,
      submitEnvelope: (envelope) => ctx.deps.submitEnvelope(envelope as unknown as Record<string, unknown>),
      now: ctx.deps.now,
      generateEnvelopeId: () => crypto.randomUUID(),
    };

    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const localPath of localPaths) {
      if (abortSignal?.aborted) throw new Error('Aborted by client');
      const fileName = path.basename(localPath);
      // destPath is interpreted by the RECEIVING spoke's sandboxedWriteFile
      // (src/cli/spoke.ts), relative to ITS OWN received-files sandbox --
      // not this machine's workFolder concept, which has no meaning on a
      // relay-addressed agent.
      const destPath = destinationPath ? `${destinationPath.replace(/[/\\]+$/, '')}/${fileName}` : fileName;
      try {
        const data = fs.readFileSync(localPath);
        const result = await sendFileOverRelay(
          fileTransferDeps, ctx.registry, data, targetMemberId, destPath, DEFAULT_FILE_TRANSFER_TIMEOUT_MS,
        ) as FileTransferResultPayload;
        if (result.status !== 'ok') throw new Error(result.error ?? result.status);
        success.push(fileName);
      } catch (err) {
        failed.push({ path: fileName, error: (err as Error).message });
      }
    }
    return { success, failed };
  }

  async receiveFiles(): Promise<TransferResult> {
    throw new Error('File transfer over relay is not yet supported (apra-fleet-jfn follow-on; see src/services/file-transfer-relay.ts). No pull-direction wire-protocol kind exists yet -- sendFileOverRelay is push-only.');
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
