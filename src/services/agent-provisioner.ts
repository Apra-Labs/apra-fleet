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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, LlmProvider } from '../types.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { getStrategy } from './strategy.js';
import { uploadContentToHome } from './sftp.js';
import { loadAgentAssets } from '../cli/install.js';
import { getAgentsDirRelative } from '../cli/config.js';
import { getProvider } from '../providers/index.js';
import { memberMcpToolGrants } from '../cli/agent-transform.js';

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
 * Loads the canonical set of agent files from vendor/apra-pm/agents, applying provider-specific transforms
 * (e.g. OpenCode/AGY frontmatter/rules) if necessary. Standardizes on LF line endings so the computed
 * hash matches what actually gets written to the remote box.
 */
export function loadCanonicalAgentSet(provider: LlmProvider): CanonicalAgentFile[] {
  const assets = loadAgentAssets();
  const adapter = getProvider(provider);
  return assets.map(({ relPath, content }) => {
    // Normalize CRLF -> LF before hashing/uploading so a CRLF checkout (Windows)
    // and an LF binary (SEA asset) produce identical hashes for the same file.
    const normalized = content.replace(/\r\n/g, '\n');
    const transformed = adapter.transformAgent(normalized, relPath);
    return { relPath, content: transformed, sha256: sha256Hex(transformed) };
  });
}

/** Home-relative agents dir for a provider, or null when the provider has no agent files (codex, copilot, none). */
export function remoteAgentsDir(provider: LlmProvider): string | null {
  // 'none' (apra-fleet-us9.14, no-LLM executor members) postdates this
  // provisioner's provider map: such members run no agent CLI at all, so
  // there is nothing to provision and no dir to probe.
  if (provider === 'none') return null;
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
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
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

/** Role files whose restrictive `tools:` list does not grant every member MCP
 *  tool (exported for tests). A file with no tools list or a wildcard one
 *  inherits every tool and is fine. */
export function rolesMissingMemberToolGrant(files: Array<{ relPath: string; content: string }>): string[] {
  const grants = memberMcpToolGrants();
  const out: string[] = [];
  for (const f of files) {
    if (!f.relPath.endsWith('.md')) continue;
    const fm = f.content.replace(/\r\n/g, '\n').match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!fm) continue;
    const line = fm[1].split('\n').find(l => /^tools:\s*(.+)/.test(l));
    if (!line) continue;
    const tools = line.replace(/^tools:\s*/, '').trim().replace(/^\[/, '').replace(/\]$/, '')
      .split(',').map(t => t.trim()).filter(Boolean);
    if (tools.includes('*')) continue;
    if (grants.some(g => !tools.includes(g))) out.push(f.relPath);
  }
  return out;
}

/** `healed` names local role files this check rewrote from the canonical set. */
export type RoleAgentToolCheck = { ok: true; healed?: string[] } | { ok: false; detail: string };

/**
 * Member-init check through the CLI's real resolution path: a sprint role is
 * dispatched as `claude --agent <role>`, and the role file's `tools:` list
 * then filters the whole session, so a connected member MCP server is not
 * enough -- the role files the member's CLI loads must grant the kb_* /
 * code_* tools. Claude only (no other provider applies an MCP allowlist from
 * these files). Remote: re-provisions stale role files first (the same push
 * execute_prompt does before every dispatch), then requires the member's
 * copies to match the canonical set. Local: the role files live in the
 * orchestrator's own home, written by `apra-fleet install`; a file whose tools
 * list hides the member tools is rewritten from the canonical set (self-heal)
 * and only one that stays bad is reported.
 */
export async function checkRoleAgentMemberTools(agent: Agent, homeDir: string = os.homedir()): Promise<RoleAgentToolCheck> {
  if ((agent.llmProvider ?? 'claude') !== 'claude') return { ok: true };
  const canonical = loadCanonicalAgentSet('claude');
  const badCanonical = rolesMissingMemberToolGrant(canonical);
  if (badCanonical.length > 0) {
    return { ok: false, detail: `role definitions do not grant the member kb_*/code_* tools: ${badCanonical.join(', ')}` };
  }
  const rel = remoteAgentsDir('claude');
  if (!rel) return { ok: true };
  if (agent.agentType === 'local') {
    const dir = path.join(homeDir, rel);
    const findBad = (): string[] => {
      const bad: string[] = [];
      for (const f of canonical) {
        if (!f.relPath.endsWith('.md')) continue;
        let installed: string;
        try { installed = fs.readFileSync(path.join(dir, f.relPath), 'utf-8'); } catch { continue; }
        if (rolesMissingMemberToolGrant([{ relPath: f.relPath, content: installed }]).length > 0) bad.push(f.relPath);
      }
      return bad;
    };
    const bad = findBad();
    if (bad.length === 0) return { ok: true };
    // Self-heal: rewrite only the offending role files from the canonical set
    // (the same content `apra-fleet install` writes), then re-check.
    const writeErrors: string[] = [];
    for (const relPath of bad) {
      const f = canonical.find(c => c.relPath === relPath);
      if (!f) continue;
      try { fs.writeFileSync(path.join(dir, relPath), f.content, 'utf-8'); } catch (err: unknown) {
        writeErrors.push(`${relPath} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const still = findBad();
    if (still.length === 0) return { ok: true, healed: bad };
    return {
      ok: false,
      detail: `installed role files in ${dir} hide the member kb_*/code_* tools from --agent sessions and could not be rewritten: ${still.join(', ')}${writeErrors.length ? ` (${writeErrors.join('; ')})` : ''}`,
    };
  }
  const pushed = await provisionAgents(agent);
  if (pushed.warning) return { ok: false, detail: pushed.warning };
  const { hashes, failed } = await probeRemoteAgentHashes(agent, rel);
  if (failed || hashes === null) return { ok: false, detail: 'could not read the member role files back after provisioning' };
  const stale = diffAgentSet(canonical, hashes).map(f => f.relPath).filter(p => p.endsWith('.md'));
  return stale.length === 0
    ? { ok: true }
    : { ok: false, detail: `member role files differ from the canonical set (their tools lists may hide kb_*/code_*): ${stale.join(', ')}` };
}
