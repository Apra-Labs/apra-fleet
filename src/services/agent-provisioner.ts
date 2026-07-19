/**
 * Provisions role-agent definition files (planner.md, doer.md, reviewer.md,
 * _shared/, schemas/, ...) onto remote fleet members.
 *
 * install() writes these files into the operator's own home directory, so a
 * local member (which shares the operator's home) always has them. A remote
 * member has its own home dir and never receives them unless we push them --
 * this module hash-diffs the canonical set against what's on the remote box
 * and pushes only what's missing or stale.
 */
import { createHash } from 'node:crypto';
import type { Agent, LlmProvider } from '../types.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { getStrategy } from './strategy.js';
import { uploadContentToHome } from './sftp.js';
import { loadAgentAssets } from '../cli/install.js';
import { getAgentsDirRelative } from '../cli/config.js';
import { transformAgentForOpenCode } from '../cli/agent-transform.js';

export interface CanonicalAgentFile {
  relPath: string;
  content: string;
  sha256: string;
}

export interface ProvisionResult {
  pushed: string[];
  skippedReason?: string;
  warning?: string;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').toLowerCase();
}

/**
 * Load the canonical agent asset set for a provider, applying the same
 * install-time transform (opencode frontmatter rewrite) before hashing so the
 * hash matches what actually gets written to the remote box.
 */
export function loadCanonicalAgentSet(provider: LlmProvider): CanonicalAgentFile[] {
  const assets = loadAgentAssets();
  return assets.map(({ relPath, content }) => {
    const transformed = provider === 'opencode'
      ? transformAgentForOpenCode(content, relPath)
      : content;
    return { relPath, content: transformed, sha256: sha256Hex(transformed) };
  });
}

/** Home-relative agents dir for a provider, or null when the provider has no agent files (codex, copilot). */
export function remoteAgentsDir(provider: LlmProvider): string | null {
  return getAgentsDirRelative(provider) ?? null;
}

const HASH_LINE_RE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;

/**
 * One round trip: list "<sha256>  ./<relpath>" for every file under `dir` on
 * the remote box. Returns hashes=null with failed=true if the probe itself
 * failed (non-zero exit, transport error, or unparseable output) -- callers
 * must NOT blind-push in that case. An empty/missing remote dir is a
 * successful probe that yields an empty map.
 */
export async function probeRemoteAgentHashes(
  agent: Agent,
  dir: string
): Promise<{ hashes: Map<string, string> | null; failed: boolean }> {
  const cmds = getOsCommands(getAgentOS(agent));
  const strategy = getStrategy(agent);

  let result;
  try {
    result = await strategy.execCommand(cmds.hashFilesRecursive(dir), 15000);
  } catch {
    return { hashes: null, failed: true };
  }

  if (result.code !== 0) {
    return { hashes: null, failed: true };
  }

  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return { hashes: new Map(), failed: false };
  }

  const hashes = new Map<string, string>();
  let matched = 0;
  let total = 0;
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    total++;
    const m = HASH_LINE_RE.exec(line);
    if (!m) continue;
    matched++;
    let relPath = m[2].trim().replace(/\\/g, '/');
    if (relPath.startsWith('./')) relPath = relPath.slice(2);
    hashes.set(relPath, m[1].toLowerCase());
  }

  // Non-empty output but nothing parsed as a valid hash line -- garbled, don't trust it.
  if (total > 0 && matched === 0) {
    return { hashes: null, failed: true };
  }

  return { hashes, failed: false };
}

/** Files that are missing on the remote or whose content hash differs. Extra remote files are left alone. */
export function diffAgentSet(canonical: CanonicalAgentFile[], remote: Map<string, string>): CanonicalAgentFile[] {
  return canonical.filter(f => remote.get(f.relPath) !== f.sha256);
}

/**
 * Ensure a remote member has an up-to-date copy of the canonical agent set.
 * Never throws -- all failure modes surface as `warning` so callers can log
 * and continue (registration/update must not fail because provisioning did).
 */
export async function provisionAgents(agent: Agent): Promise<ProvisionResult> {
  try {
    if (agent.agentType === 'local') {
      return { pushed: [], skippedReason: 'local member shares operator home' };
    }

    const provider = agent.llmProvider ?? 'claude';
    const dir = remoteAgentsDir(provider);
    if (!dir) {
      return { pushed: [], skippedReason: `${provider} does not use role-agent files` };
    }

    const { hashes, failed } = await probeRemoteAgentHashes(agent, dir);
    if (failed || hashes === null) {
      return { pushed: [], warning: 'Could not verify remote agent files -- skipped provisioning (probe failed)' };
    }

    const canonical = loadCanonicalAgentSet(provider);
    const stale = diffAgentSet(canonical, hashes);
    if (stale.length === 0) {
      return { pushed: [] };
    }

    const { success, failed: uploadFailed } = await uploadContentToHome(
      agent,
      stale.map(f => ({ relPath: f.relPath, content: f.content })),
      dir
    );

    const result: ProvisionResult = { pushed: success };
    if (uploadFailed.length > 0) {
      result.warning = `Failed to provision ${uploadFailed.length} agent file(s): ${uploadFailed.map(f => f.path).join(', ')}`;
    }
    return result;
  } catch (err: any) {
    return { pushed: [], warning: `Agent provisioning failed: ${err?.message ?? String(err)}` };
  }
}
