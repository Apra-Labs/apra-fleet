import { z } from 'zod';
import { existsSync, readFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { formatAgentHost, getAgentOS, getAgentShell, groupByCategory } from '../utils/agent-helpers.js';
import { serverVersion } from '../version.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { getStallDetector } from '../services/stall/index.js';
import { fmtElapsed } from '../services/stall/time-utils.js';
import { awsProvider } from '../services/cloud/aws.js';
import { estimateCost, hourlyRate, formatUptimeDuration, uptimeHoursFromLaunch, costWarning } from '../services/cloud/cost.js';
import { parseGpuUtilization } from '../utils/gpu-parser.js';
import { getUpdateNotice } from '../services/update-check.js';
import { getActiveLogFile } from '../utils/log-helpers.js';
import { USAGE_LOG_PATH, ROTATED_USAGE_LOG_PATH } from './code-intelligence-telemetry.js';
import { codeIndexReadiness } from './code-intelligence-readiness.js';
import { kbStats } from './kb-stats.js';
import { checkVersionMismatch, type VersionMismatch } from '../services/version-check.js';
import { SqliteProvider } from '../services/knowledge/sqlite-provider.js';
import { listKbScopes, knowledgeRootDir, GLOBAL_KB_SCOPE, type KbScopeLocation } from '../services/knowledge/kb-scopes.js';
import { resolveProjectSlug } from '../services/knowledge/project-slug.js';
import { readKbConfigFromDisk } from '../services/knowledge/kb-config.js';

export const fleetStatusSchema = z.object({
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
  // The fleet server is one long-lived process serving every project, so its
  // own working directory says nothing about which repo the caller means.
  // Repo-specific sections (code-intel index health, KB bible drift) are only
  // computed when the caller names the repo explicitly.
  repo_path: z.string().optional().describe("Absolute path to a repo checkout. When given, fleet_status also reports that repo's code-intelligence index health and the canonical-bible drift of its KB scope. Omit it for the fleet-wide view: KB health for every project scope, no per-repo sections. The server's own working directory is never used."),
});

interface CloudInfo {
  state: string;
  instanceType?: string;
  launchTime?: string;
  gpuUtil?: number;
}

interface AgentStatusRow {
  icon: string;
  name: string;
  host: string;
  status: 'online' | 'OFFLINE';
  busy: string;
  session: string;
  lastActivity: string;
  lastLlmActivityAt?: string;
  llmProvider?: string;
  branch?: string;
  cloudInfo?: CloudInfo;
  tokenUsage?: { input: number; output: number };
  category: string | null;
  tags?: string[];
}

/**
 * Build the busy label for a member confirmed running via SSH process check.
 * Uses the stall detector entry to show elapsed time since last log activity,
 * or 'unknown' if the stall threshold has already fired.
 */
function busyLabel(agentId: string): string {
  const entry = getStallDetector().getEntry(agentId);
  if (!entry) return 'BUSY';
  if (entry.stallReported) return 'unknown';
  if (!entry.provisional) {
    return `BUSY(${fmtElapsed(Date.now() - entry.lastActivityAt)})`;
  }
  return 'BUSY';
}

function formatTimeAgo(isoDate?: string): string {
  if (!isoDate) return 'never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function checkAgent(agent: ReturnType<typeof getAllAgents>[number]): Promise<AgentStatusRow> {
  const hostLabel = formatAgentHost(agent);

  const row: AgentStatusRow = {
    icon: agent.icon ?? DEFAULT_ICON,
    name: agent.friendlyName,
    host: hostLabel,
    status: 'OFFLINE',
    busy: '-',
    session: agent.sessionId ? agent.sessionId.substring(0, 8) + '...' : '(none)',
    lastActivity: formatTimeAgo(agent.lastUsed),
    lastLlmActivityAt: agent.lastLlmActivityAt,
    llmProvider: agent.llmProvider,
    branch: agent.lastBranch,
    tokenUsage: agent.tokenUsage,
    category: agent.category?.trim() || null,
    tags: agent.tags && agent.tags.length > 0 ? agent.tags : undefined,
  };

  const strategy = getStrategy(agent);

  // For cloud members: fetch instance details in parallel with SSH connection test
  if (agent.cloud) {
    const [detailsResult, connResult] = await Promise.allSettled([
      awsProvider.getInstanceDetails(agent.cloud),
      Promise.race([
        strategy.testConnection(),
        new Promise<{ ok: false; latencyMs: number; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 10000)
        ),
      ]),
    ]);

    // Process cloud details
    if (detailsResult.status === 'fulfilled') {
      const details = detailsResult.value;
      row.cloudInfo = {
        state: details.state,
        instanceType: details.instanceType,
        launchTime: details.launchTime,
      };

      // If cloud is not running/pending, mark as off and skip SSH entirely
      if (details.state !== 'running' && details.state !== 'pending') {
        row.status = 'OFFLINE';
        row.busy = 'OFF(cloud)';
        return row;
      }
    }

    // Process SSH connection result
    if (connResult.status === 'fulfilled' && connResult.value.ok) {
      row.status = 'online';

      const provider = getProvider(agent.llmProvider);

      if (agent.llmProvider === 'none' || !provider.processName) {
        row.busy = 'idle';
      } else {
        const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));

        // Run fleet process check and GPU utilization in parallel
        const [busyResult, gpuResult] = await Promise.allSettled([
          strategy.execCommand(cmds.fleetProcessCheck(agent.workFolder, agent.sessionId, provider.processName), 10000),
          strategy.execCommand(cmds.gpuUtilization(), 10000),
        ]);

        if (busyResult.status === 'fulfilled') {
          const output = busyResult.value.stdout.trim().toLowerCase();
          if (output.includes('fleet-busy')) {
            row.busy = busyLabel(agent.id);
          } else if (output.includes('other-busy')) {
            row.busy = 'idle*';
          } else {
            row.busy = 'idle';
          }
        } else {
          row.busy = 'unknown';
        }

        if (gpuResult.status === 'fulfilled' && row.cloudInfo) {
          const gpuNum = parseGpuUtilization(gpuResult.value.stdout);
          if (gpuNum !== undefined) {
            row.cloudInfo.gpuUtil = gpuNum;
          }
        }
      }
    }

    return row;
  }

  // Non-cloud members: original logic
  try {
    const conn = await Promise.race([
      strategy.testConnection(),
      new Promise<{ ok: false; latencyMs: number; error: string }>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 10000)
      ),
    ]);

    if (conn.ok) {
      row.status = 'online';

      const provider = getProvider(agent.llmProvider);
      if (agent.llmProvider === 'none' || !provider.processName) {
        row.busy = 'idle';
      } else {
        try {
          const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
          const busyCheck = await strategy.execCommand(
            cmds.fleetProcessCheck(agent.workFolder, agent.sessionId, provider.processName),
            10000,
          );
          const output = busyCheck.stdout.trim().toLowerCase();
          if (output.includes('fleet-busy')) {
            row.busy = 'BUSY';
          } else if (output.includes('other-busy')) {
            row.busy = 'idle*';
          } else {
            row.busy = 'idle';
          }
        } catch {
          row.busy = 'unknown';
        }
      }
    }
  } catch {
    row.status = 'OFFLINE';
  }

  return row;
}

// ---------------------------------------------------------------------------
// Code intelligence health (F3.3)
//
// Read-only, fast, no MCP child spawn, no network. Reports whether the
// current working repo has a gitnexus index, its stats, and whether the
// indexed commit matches current git HEAD. Never throws -- every failure
// (missing/unparseable meta.json, git unavailable, unknown lastCommit)
// degrades to a graceful "unavailable" state instead of failing fleet_status.
// ---------------------------------------------------------------------------
export interface TopSymbol {
  target: string;
  count: number;
}

export interface CodeIntelligenceHealth {
  present: boolean;
  // false when no repo was named: the index is per-repo (<repo>/.gitnexus)
  // and the server has no repo of its own, so presence was not checked at all
  // -- distinct from present:false after a real check. Absent means computed.
  computable?: boolean;
  reason?: string;
  // The repo this health describes (only set when computed).
  repoPath?: string;
  nodes?: number;
  edges?: number;
  files?: number;
  indexedAt?: string;
  lastCommit?: string;
  headStatus?: 'matching' | 'behind' | 'unavailable';
  commitsBehind?: number;
  topSymbols?: TopSymbol[];
}

interface GitNexusMeta {
  lastCommit?: string;
  indexedAt?: string;
  stats?: { files?: number; nodes?: number; edges?: number };
}

function readGitNexusMeta(repoDir: string): GitNexusMeta | null {
  const metaPath = join(repoDir, '.gitnexus', 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as GitNexusMeta;
  } catch {
    return null;
  }
}

function currentHead(repoDir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function commitsBehindCount(repoDir: string, lastCommit: string, head: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${lastCommit}..${head}`], {
      cwd: repoDir, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const count = Number.parseInt(out, 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Top symbols read (T4.2, design D8 read spec). Single pass over usage.jsonl
// AND usage.jsonl.1 (if present), 30-day window, aggregate count by target,
// top 5. Degraded-safe: no usage file, an unreadable file, or any other
// error -> undefined (field/segment omitted entirely from fleet_status).
// Unparseable individual lines are skipped rather than failing the pass.
// ---------------------------------------------------------------------------
const TOP_SYMBOLS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TOP_SYMBOLS_LIMIT = 5;

function readUsageLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

export function computeTopSymbols(
  now: number = Date.now(),
  usagePath: string = USAGE_LOG_PATH,
  rotatedUsagePath: string = ROTATED_USAGE_LOG_PATH,
): TopSymbol[] | undefined {
  try {
    const lines = [...readUsageLines(usagePath), ...readUsageLines(rotatedUsagePath)];
    if (lines.length === 0) return undefined;

    const cutoff = now - TOP_SYMBOLS_WINDOW_MS;
    const counts = new Map<string, number>();
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { ts?: unknown; target?: unknown };
        if (typeof record.ts !== 'string' || typeof record.target !== 'string') continue;
        const ts = new Date(record.ts).getTime();
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        counts.set(record.target, (counts.get(record.target) ?? 0) + 1);
      } catch {
        // Unparseable line -- skip it, keep going.
      }
    }

    if (counts.size === 0) return undefined;

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_SYMBOLS_LIMIT)
      .map(([target, count]) => ({ target, count }));
  } catch {
    return undefined;
  }
}

export function codeIntelligenceHealth(repoDir: string): CodeIntelligenceHealth {
  const meta = readGitNexusMeta(repoDir);
  if (!meta) return { present: false };
  // Same predicate as the code_* pre-flight: a placeholder meta.json, an
  // incremental-in-progress index or a held analyze lock is not an index.
  if (!codeIndexReadiness('gitnexus', repoDir).ready) return { present: false };

  const health: CodeIntelligenceHealth = {
    present: true,
    nodes: meta.stats?.nodes,
    edges: meta.stats?.edges,
    files: meta.stats?.files,
    indexedAt: meta.indexedAt,
    lastCommit: meta.lastCommit,
  };

  if (!meta.lastCommit) {
    health.headStatus = 'unavailable';
    return health;
  }

  const head = currentHead(repoDir);
  if (!head) {
    health.headStatus = 'unavailable';
    return health;
  }

  if (head === meta.lastCommit) {
    health.headStatus = 'matching';
    return health;
  }

  const behind = commitsBehindCount(repoDir, meta.lastCommit, head);
  if (behind === null) {
    health.headStatus = 'unavailable';
    return health;
  }

  health.headStatus = 'behind';
  health.commitsBehind = behind;
  return health;
}

/**
 * Render the trailing head-comparison fragment used by the compact
 * fleet_status line, e.g. "matching HEAD", "5 commits behind HEAD", or
 * "indexed a1b2c3d4, HEAD comparison unavailable".
 */
function headComparisonLabel(health: CodeIntelligenceHealth): string {
  if (health.headStatus === 'matching') return 'matching HEAD';
  if (health.headStatus === 'behind') return `${health.commitsBehind} commits behind HEAD`;
  const shortSha = health.lastCommit ? health.lastCommit.slice(0, 8) : 'unknown';
  return `indexed ${shortSha}, HEAD comparison unavailable`;
}

/** Render the trailing "top symbols (30d): a (12), b (9), ..." fragment, or "" when absent. */
function topSymbolsFragment(topSymbols?: TopSymbol[]): string {
  if (!topSymbols || topSymbols.length === 0) return '';
  const rendered = topSymbols.map((s) => `${s.target} (${s.count})`).join(', ');
  return ` | top symbols (30d): ${rendered}`;
}

/** Render the one-line compact fleet_status code intelligence summary. */
export const CODE_INTEL_NO_REPO_REASON = 'per-repo index; pass repo_path to fleet_status (or repo to code_map) to check a repo';

export function codeIntelligenceCompactLine(health: CodeIntelligenceHealth): string {
  if (health.computable === false) {
    return `code-intel: ${health.reason ?? CODE_INTEL_NO_REPO_REASON}` + topSymbolsFragment(health.topSymbols);
  }
  if (!health.present) {
    return "code-intel: no index (run 'npx gitnexus analyze --index-only' or /pm index)" + topSymbolsFragment(health.topSymbols);
  }
  const nodes = health.nodes ?? 0;
  const edges = health.edges ?? 0;
  const files = health.files ?? 0;
  const indexedAt = health.indexedAt ?? 'unknown';
  return `code-intel: index present | ${nodes} nodes / ${edges} edges / ${files} files | indexed ${indexedAt} | ${headComparisonLabel(health)}${topSymbolsFragment(health.topSymbols)}`;
}

// ---------------------------------------------------------------------------
// KB health (T2.2, F5/F6, D4/D5 amended). Degraded-safe: wrap ALL I/O in
// try/catch, never throw, never block status (code-intelligence health
// precedent, KB 4e11460c).
//
// The fleet server is ONE long-lived process serving every project a user
// works on, and its process cwd is arbitrary (a detached launch sits in
// C:\Windows\System32). So this section never derives a project from
// process.cwd(): it enumerates every KB scope on disk (kb-scopes.ts) and
// reports each one labeled by its project slug, plus the shared global KB.
// Previously it called kbStats({}) with no repo, which fell back to the
// server's cwd -- reporting the empty `default` scope ("kb: 0 entries") for a
// detached server, or silently just one project when launched inside a
// checkout.
// ---------------------------------------------------------------------------
// my-beads-db-0cd.18: mirrors kb-stats.ts's own bible union verbatim
// -- over a remote HTTP project provider, bible drift is not computable at all,
// so there is no `drift` field to default to 0 for. Keeping this a union (not
// widening `computable`/`reason` onto the first branch) is what makes an
// unconditional `bible.drift` read a compile error instead of `undefined`.
export type KbHealthBible =
  | { present: boolean; entries: number; drift: number }
  | { computable: false; reason: string };

/** Per-scope KB numbers (the kb_stats shape). */
export interface KbScopeStats {
  totals: { by_confidence: Record<string, number>; by_type: Record<string, number>; total: number };
  stale: number;
  flagged: number;
  superseded: number;
  retrieval: { entries_retrieved: number; total_uses: number; hit_rate: number | null };
  promote_ratio: number | null;
  bible: KbHealthBible;
}

export interface KbScopeHealth extends KbScopeStats {
  /** Project slug (the scope directory name under FLEET_DIR/knowledge), or `global`. */
  scope: string;
}

export interface KbScopeError {
  scope: string;
  error: string;
}

export interface KbHealth {
  /** Which provider the KB config selects for project scopes. With `http`, the local scopes below are the offline fallback copies. */
  projectProvider: 'sqlite' | 'http';
  /** Every project scope found on disk (including `default`, the non-git scope), sorted by slug. */
  scopes: KbScopeHealth[];
  /** The single shared cross-project KB, or null when it does not exist yet. */
  global: KbScopeHealth | null;
  /** Scopes whose database could not be read. */
  errors: KbScopeError[];
  /** Sum of totals.total over scopes + global. */
  totalEntries: number;
}

// Bible drift needs a repo checkout (.fleet/kb-canonical.json). A scope does
// not record one and the server's cwd is not a repo, so drift is reported
// only for the scope of an explicitly supplied repo_path.
export const KB_BIBLE_NO_REPO_REASON = 'bible drift needs a repo checkout; pass repo_path to fleet_status';
export const KB_BIBLE_GLOBAL_REASON = 'bible drift is not tracked for the global KB';
// Expected "not computed" states; rendering them on every compact line would
// be noise. The HTTP-provider reason is NOT here: it is a real signal.
const SILENT_BIBLE_REASONS = new Set([KB_BIBLE_NO_REPO_REASON, KB_BIBLE_GLOBAL_REASON]);

async function readScopeStats(loc: KbScopeLocation): Promise<Omit<KbScopeStats, 'bible'>> {
  const provider = new SqliteProvider(loc.dbPath);
  try {
    await provider.init();
    const { totals, stale, flagged, superseded, retrieval, promote_ratio } = await provider.stats();
    return { totals, stale, flagged, superseded, retrieval, promote_ratio };
  } finally {
    try { provider.close(); } catch { /* best effort */ }
  }
}

async function bibleForRepo(repoPath: string): Promise<KbHealthBible | null> {
  try {
    const parsed = JSON.parse(await kbStats({}, { folder: repoPath })) as { bible?: KbHealthBible };
    return parsed.bible ?? null;
  } catch {
    return null;
  }
}

function configuredProjectProvider(): 'sqlite' | 'http' {
  try {
    return readKbConfigFromDisk().provider === 'http' ? 'http' : 'sqlite';
  } catch {
    // kb-providers degrades a broken config to the local SqliteProvider.
    return 'sqlite';
  }
}

export interface KbHealthOptions {
  /** Knowledge root to enumerate; defaults to FLEET_DIR/knowledge. */
  knowledgeDir?: string;
  /** Validated repo checkout; its scope (only) gets a bible drift number. */
  repoPath?: string;
}

/**
 * Enumerate every KB scope on disk and shape per-scope health for
 * fleet_status. Independent of process.cwd(). Never throws -- a scope that
 * cannot be read is listed under `errors`; any unexpected failure yields null
 * so the caller omits the KB section entirely.
 */
export async function kbHealthSummary(opts: KbHealthOptions = {}): Promise<KbHealth | null> {
  try {
    const locations = listKbScopes(opts.knowledgeDir ?? knowledgeRootDir());
    let repoSlug: string | null = null;
    if (opts.repoPath) {
      try { repoSlug = resolveProjectSlug(opts.repoPath); } catch { repoSlug = null; }
    }

    const scopes: KbScopeHealth[] = [];
    const errors: KbScopeError[] = [];
    let global: KbScopeHealth | null = null;

    for (const loc of locations) {
      let stats: Omit<KbScopeStats, 'bible'>;
      try {
        stats = await readScopeStats(loc);
      } catch (err) {
        errors.push({ scope: loc.slug, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (loc.slug === GLOBAL_KB_SCOPE) {
        global = { scope: loc.slug, ...stats, bible: { computable: false, reason: KB_BIBLE_GLOBAL_REASON } };
        continue;
      }
      let bible: KbHealthBible = { computable: false, reason: KB_BIBLE_NO_REPO_REASON };
      if (opts.repoPath && repoSlug === loc.slug) {
        bible = (await bibleForRepo(opts.repoPath)) ?? bible;
      }
      scopes.push({ scope: loc.slug, ...stats, bible });
    }

    const totalEntries = scopes.reduce((n, s) => n + s.totals.total, 0) + (global?.totals.total ?? 0);
    return { projectProvider: configuredProjectProvider(), scopes, global, errors, totalEntries };
  } catch {
    return null;
  }
}

// D5 (AMENDED): with F6a auto-commit in place inside kb_export, nonzero drift
// is an ANOMALY signal (a failed auto-commit), not a routine reminder -- the
// wording says so explicitly. Omitted entirely when drift is not positive
// (nothing anomalous to report) or not computed for an expected reason.
function bibleDriftFragment(bible: KbHealthBible): string {
  if (!('drift' in bible)) return SILENT_BIBLE_REASONS.has(bible.reason) ? '' : ` | bible: ${bible.reason}`;
  if (bible.drift <= 0) return '';
  return ` | bible: ${bible.drift} promotions behind (auto-commit may have failed -- run apra-fleet kb commit)`;
}

/** Render one compact KB health line for a single scope, labeled `kb[<scope>]` when a label is given. */
export function kbHealthCompactLine(health: KbScopeStats, label?: string): string {
  const hitRatePct = health.retrieval.hit_rate === null ? 'n/a' : `${Math.round(health.retrieval.hit_rate * 100)}%`;
  const promotePct = health.promote_ratio === null ? 'n/a' : `${Math.round(health.promote_ratio * 100)}%`;
  const confirmed = health.totals.by_confidence.CONFIRMED ?? 0;
  const prefix = label ? `kb[${label}]` : 'kb';
  return `${prefix}: ${health.totals.total} entries (confirmed:${confirmed} stale:${health.stale} flagged:${health.flagged}) | hit-rate:${hitRatePct} | promote-ratio:${promotePct}${bibleDriftFragment(health.bible)}`;
}

/**
 * Render the compact multi-scope KB section: one summary line, then one
 * indented line per non-empty scope (projects first, then global). Empty
 * scopes are collapsed into a single trailing line so an unused `default`
 * scope never reads as "the KB is empty".
 */
export function kbHealthCompactLines(health: KbHealth): string {
  if (health.scopes.length === 0 && !health.global && health.errors.length === 0) {
    return 'kb: no knowledge bases found yet (none captured on this server)';
  }
  const nonEmpty = health.scopes.filter(s => s.totals.total > 0);
  const empty = health.scopes.filter(s => s.totals.total === 0).map(s => s.scope);
  const globalNonEmpty = health.global && health.global.totals.total > 0 ? health.global : null;
  if (health.global && !globalNonEmpty) empty.push(health.global.scope);

  const remoteNote = health.projectProvider === 'http' ? ' | project KBs served by remote http provider; local fallback copies shown' : '';
  const lines: string[] = [];
  lines.push(`kb: ${health.totalEntries} entries across ${nonEmpty.length} project scope(s)${globalNonEmpty ? ' + global' : ''}${remoteNote}`);
  for (const s of nonEmpty) lines.push(`  ${kbHealthCompactLine(s, s.scope)}`);
  if (globalNonEmpty) lines.push(`  ${kbHealthCompactLine(globalNonEmpty, globalNonEmpty.scope)}`);
  for (const e of health.errors) lines.push(`  kb[${e.scope}]: unreadable (${e.error})`);
  if (empty.length > 0) lines.push(`  kb: empty scope(s): ${empty.join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Server version handshake (T2.4, F7, D6). Compares the compiled-in
// serverVersion against a fresh on-disk read (src/services/version-check.ts)
// of the code this process was launched from -- catches the "rebuilt dist
// but forgot to restart the MCP client" scenario. Degraded-safe: disk read
// failure -> omit silently; no auto-restart, surface only.
// ---------------------------------------------------------------------------
export function versionMismatchCompactLine(mismatch: VersionMismatch): string {
  return `server running ${mismatch.running}, disk has ${mismatch.disk} -- restart your MCP client`;
}

export type FleetStatusInput = z.infer<typeof fleetStatusSchema>;

export async function fleetStatus(input?: FleetStatusInput): Promise<string> {
  const format = input?.format ?? 'compact';
  const agents = getAllAgents();

  if (agents.length === 0) {
    if (format === 'json') {
      return JSON.stringify({ version: serverVersion, summary: { total: 0, online: 0, offline: 0 }, members: [] });
    }
    return 'No members registered. Use register_member to add one.';
  }

  // Query all members in parallel
  const results = await Promise.allSettled(agents.map(a => checkAgent(a)));

  const rows: AgentStatusRow[] = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const agent = agents[i];
    const hostLabel = formatAgentHost(agent);
    return {
      icon: agent.icon ?? DEFAULT_ICON,
      name: agent.friendlyName,
      host: hostLabel,
      status: 'OFFLINE' as const,
      busy: '-',
      session: agent.sessionId ? agent.sessionId.substring(0, 8) + '...' : '(none)',
      lastActivity: formatTimeAgo(agent.lastUsed),
      category: agent.category?.trim() || null,
      tags: agent.tags && agent.tags.length > 0 ? agent.tags : undefined,
    };
  });

  // Count cloud-stopped members as offline for the summary
  const online = rows.filter(r => r.status === 'online').length;

  // Update statusline with connectivity state from this check.
  // For busy/unknown members the stall detector owns the statusline (it writes
  // busy(mm:ss) or unknown on each 30s poll); we only override offline and idle
  // so we don't clobber the richer stall-detector state.
  const statusOverrides = new Map<string, string>();
  for (let i = 0; i < agents.length; i++) {
    const row = rows[i];
    if (row.status === 'OFFLINE') {
      statusOverrides.set(agents[i].id, 'offline');
    } else if (row.busy === 'idle' || row.busy === 'idle*') {
      // SSH confirmed no fleet process running — clear any stale busy/unknown
      statusOverrides.set(agents[i].id, 'idle');
    }
    // BUSY / BUSY(mm:ss) / unknown (stall fired but process still alive):
    // stall detector already wrote the authoritative value — don't override
  }
  writeStatusline(statusOverrides);

  const updateNotice = getUpdateNotice();
  const logFile = getActiveLogFile();
  // The server's process.cwd() is never consulted: it is one process serving
  // every project, launched from an arbitrary directory. Repo-specific
  // sections are computed only for an explicitly named, existing repo_path.
  const requestedRepo = input?.repo_path;
  let repoPath: string | undefined;
  if (requestedRepo) {
    try {
      if (statSync(requestedRepo).isDirectory()) repoPath = requestedRepo;
    } catch {
      repoPath = undefined;
    }
  }

  let codeIntelligence: CodeIntelligenceHealth;
  try {
    if (repoPath) {
      codeIntelligence = { ...codeIntelligenceHealth(repoPath), repoPath };
    } else {
      codeIntelligence = {
        present: false,
        computable: false,
        reason: requestedRepo ? `repo_path not found: ${requestedRepo}` : CODE_INTEL_NO_REPO_REASON,
      };
    }
  } catch {
    // Defensive: codeIntelligenceHealth() already degrades gracefully
    // internally, but fleet_status must never fail because of this section.
    codeIntelligence = { present: false };
  }

  // T4.2: usage-telemetry top symbols (30d), independent of index presence --
  // recordUsage() fires on every code_* call regardless of whether the repo
  // has an index. Defensive on top of computeTopSymbols()'s own try/catch;
  // any failure here just omits the field, never fails fleet_status.
  try {
    const topSymbols = computeTopSymbols();
    if (topSymbols) codeIntelligence.topSymbols = topSymbols;
  } catch {
    // omit -- see comment above
  }

  // T2.2 (F5/F6, D4/D5 amended): KB health -- degraded-safe, mirrors the
  // code-intelligence section above. kbHealthSummary() already catches
  // internally; the outer try/catch here is defensive belt-and-suspenders
  // (same rationale as the codeIntelligence call above), so fleet_status
  // NEVER fails because of the KB.
  let kbHealth: KbHealth | null = null;
  try {
    kbHealth = await kbHealthSummary({ repoPath });
  } catch {
    kbHealth = null;
  }

  // T2.4 (F7, D6): version handshake -- degraded-safe, same belt-and-
  // suspenders shape as the two sections above. checkVersionMismatch()
  // already catches internally; the outer try/catch is defensive.
  let versionMismatch: VersionMismatch | null = null;
  try {
    versionMismatch = checkVersionMismatch(serverVersion);
  } catch {
    versionMismatch = null;
  }

  if (format === 'json') {
    const payload: Record<string, unknown> = {
      version: serverVersion,
      summary: { total: rows.length, online, offline: rows.length - online },
      members: rows,
      codeIntelligence,
    };
    if (kbHealth) payload.kbHealth = kbHealth;
    if (versionMismatch) payload.versionMismatch = versionMismatch;
    if (logFile) payload.logFile = logFile;
    if (updateNotice) {
      const m = updateNotice.match(/apra-fleet (v[\d.]+) is available \(installed: (v[\d.]+)/);
      if (m) payload.updateAvailable = { latest: m[1], installed: m[2] };
    }
    return JSON.stringify(payload);
  }

  // Group rows by category (category is already attached to each row)
  const combined = rows.map((row, i) => ({ row, agent: agents[i] }));
  const { grouped, sortedKeys } = groupByCategory(combined, ({ row }) => row.category);

  // Compact: 1 summary line + 1 line per member, multiple fields per line
  let t = updateNotice ? `${updateNotice}\n` : '';
  t += `Fleet ${serverVersion}: ${online}/${rows.length} online`;
  if (logFile) t += ` | log=${logFile}`;
  for (const category of sortedKeys) {
    const members = grouped.get(category)!;
    const chips = members.map(({ row: r }) => {
      const st = r.status === 'online' ? r.busy : (r.busy === 'OFF(cloud)' ? 'OFF(cloud)' : 'OFF');
      return `${r.icon} ${r.name}(${st})`;
    }).join(', ');
    t += ` | [${category}]: ${chips}`;
  }
  t += '\n';

  // Detail lines grouped by category
  for (const category of sortedKeys) {
    const members = grouped.get(category)!;
    t += `\n[${category}]\n`;
    for (const { row: r } of members) {
      const branchStr = r.branch ? ` | branch=${r.branch}` : '';
      const tokenStr = r.llmProvider === 'none'
        ? ' | compute only'
        : (r.tokenUsage && (r.tokenUsage.input > 0 || r.tokenUsage.output > 0))
          ? ` | tokens=in:${r.tokenUsage.input} out:${r.tokenUsage.output}` : '';
      const tagsStr = (r.tags && r.tags.length > 0) ? ` | tags=[${r.tags.join(', ')}]` : '';
      let line = `  ${r.icon} ${r.name}: ${r.host} | session=${r.session} | ${r.lastActivity}${branchStr}${tokenStr}${tagsStr}`;
      if (r.cloudInfo) {
        const ci = r.cloudInfo;
        const uptimeHrs = uptimeHoursFromLaunch(ci.launchTime);
        const uptime = ci.launchTime ? formatUptimeDuration(uptimeHrs) : '-';
        const cost = estimateCost(ci.instanceType, uptimeHrs);
        const rate = hourlyRate(ci.instanceType);
        const warn = costWarning(ci.instanceType, uptimeHrs);
        const gpuStr = ci.gpuUtil !== undefined ? ` GPU:${ci.gpuUtil}%` : '';
        const typeStr = ci.instanceType ? ` ${ci.instanceType}` : '';
        const warnStr = warn ? ' ⚠' : '';
        line += ` | [cloud:${ci.state}${typeStr} ${uptime} ${cost} @${rate}${gpuStr}${warnStr}]`;
      }
      t += line + '\n';
    }
  }
  t += codeIntelligenceCompactLine(codeIntelligence) + '\n';
  if (kbHealth) t += kbHealthCompactLines(kbHealth) + '\n';
  if (versionMismatch) t += versionMismatchCompactLine(versionMismatch) + '\n';
  return t;
}
