import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import { getStrategy } from '../services/strategy.js';
import { getMemberHomeDir } from '../services/member-home.js';
import { getProvider } from '../providers/index.js';
import type { WorkspaceTrustTransport } from '../providers/provider.js';
import { getAgentShell } from './agent-helpers.js';
import { logLine, logWarn } from './log-helpers.js';

/**
 * Out-of-band file channel for ensureWorkspaceTrusted (GitHub #499): places
 * `content` at `~/<relPath>` on the member WITHOUT embedding it in a command
 * line, by composing two primitives the codebase already has --
 * getMemberHomeDir (os.homedir() for a local member, the cached probe for a
 * remote one) and AgentStrategy.transferFiles (fs copy locally, SFTP over
 * SSH). The content is staged in a private temp dir on this host only long
 * enough for the transfer.
 *
 * Returns undefined for a relay member: RelayStrategy.transferFiles lands in
 * the receiving spoke's received-files sandbox, not its home, so the adapter
 * must use exec-based (chunked) delivery there instead.
 */
export function workspaceTrustTransportFor(agent: Agent, strat: AgentStrategy): WorkspaceTrustTransport | undefined {
  if (agent.agentType === 'relay') return undefined;
  return {
    writeHomeFile: async (relPath: string, content: string): Promise<void> => {
      const probed = await getMemberHomeDir(agent);
      if (!probed) throw new Error('member home directory could not be resolved');
      const home = sftpHomePath(probed, agent.os);
      const relDir = path.dirname(relPath).replace(/\\/g, '/');
      const targetDir = relDir && relDir !== '.' ? `${home}/${relDir}` : home;
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-trust-'));
      const local = path.join(staging, path.basename(relPath));
      try {
        fs.writeFileSync(local, content, { encoding: 'utf8' });
        const result = await strat.transferFiles([local], targetDir);
        if (result.failed.length > 0) {
          throw new Error(`transfer of ~/${relPath} failed: ${result.failed[0].error}`);
        }
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    },
    readHomeFile: async (relPath: string): Promise<{ found: boolean; content?: string } | undefined> => {
      if (agent.agentType !== 'local') return undefined;
      const probed = await getMemberHomeDir(agent);
      if (!probed) return undefined;
      const home = sftpHomePath(probed, agent.os);
      const filePath = path.join(home, relPath);
      if (fs.existsSync(filePath)) {
        return { found: true, content: fs.readFileSync(filePath, 'utf8') };
      }
      return { found: false };
    },
  };
}

/**
 * A gitbash Windows member's probed home is an MSYS path (/c/Users/name). The
 * SFTP server on that host is Win32-OpenSSH, which does NOT understand MSYS
 * paths -- it would treat it as an absolute path and create C:\c\Users\name.
 * Rewrite the drive prefix to the Windows form (C:/Users/name) before handing
 * it to transferFiles; every other spelling passes through unchanged.
 */
export function sftpHomePath(home: string, agentOs: Agent['os']): string {
  if (agentOs !== 'windows') return home;
  const m = home.match(/^\/([A-Za-z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : home;
}

/**
 * Idempotently seeds Claude workspace trust for `agent`'s work folder
 * (apra-fleet-eft.40.2). Wires the ensureWorkspaceTrusted(workFolder) provider-adapter
 * hook (apra-fleet-eft.40.1) into every call site that can leave a member's work folder
 * untrusted: register_member and update_member (once, at registration/update time) and
 * compose_permissions (on EVERY run, so an already-registered member -- e.g. one
 * created before this fix shipped -- is self-healed on its next compose).
 *
 * Best-effort and non-fatal: any failure (unreachable member, exec error, malformed
 * remote file) is caught and logged, never thrown -- a trust-seed hiccup must not
 * block registration, update, or permission composition. Non-Claude providers no-op
 * inside the adapter itself (see providers/*.ts), so this is cheap to call
 * unconditionally for every provider.
 *
 * @param agent The agent whose `workFolder` should be trusted, as resolved on the
 *   member (same path compose_permissions/deliverConfigFile already uses).
 * @param strategy Optional pre-resolved strategy (callers that already have one, e.g.
 *   compose_permissions, should pass it instead of paying for a second lookup).
 * @param tag Log tag identifying the call site (e.g. 'register_member').
 */
const isHomeAnchored = (p: string) => p.startsWith('~/') || p.startsWith('~\\');

export async function seedWorkspaceTrust(agent: Agent, strategy?: AgentStrategy, tag = 'workspace-trust'): Promise<void> {
  try {
    const provider = getProvider(agent.llmProvider);
    const strat = strategy ?? getStrategy(agent);
    // AGY's config path needs the member's project id, which a member may not
    // have yet (it is provisioned by compose_permissions/execute_prompt); agy
    // seeds no trust anyway, so treat "no path yet" as not home-anchored.
    let configPaths: string[];
    try {
      configPaths = provider.permissionConfigPaths(agent);
    } catch {
      configPaths = [];
    }
    const memberHomeDir = configPaths.some(isHomeAnchored)
      ? await getMemberHomeDir(agent)
      : null;
    const result = await provider.ensureWorkspaceTrusted(
      agent.workFolder,
      (command: string, timeoutMs?: number) => strat.execCommand(command, timeoutMs),
      agent.os,
      // The member's REGISTERED shell, not just its OS: a gitbash Windows
      // member needs POSIX trust-seeding strings (apra-fleet-7dir.2.8).
      getAgentShell(agent),
      // File channel so a large merged ~/.claude.json never rides a Windows
      // command line (GitHub #499); the adapter falls back to exec delivery.
      workspaceTrustTransportFor(agent, strat),
      memberHomeDir,
    );
    logLine(tag, `workspace trust for "${agent.friendlyName}": ${result.detail}`, agent);
  } catch (e: any) {
    logWarn(tag, `ensureWorkspaceTrusted failed for "${agent.friendlyName}" (non-fatal): ${e?.message ?? e}`, agent);
  }
}
