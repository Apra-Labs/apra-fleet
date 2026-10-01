// Member bible view: MEMBER-session KB reads come from an in-memory SQLite view
// of the member's own checkout bible, (self)/.fleet/kb-canonical.json.
//
// Why a view and not the per-repo DB: several members of ONE repository share
// one per-repo kb.sqlite (KB identity is the origin remote), but their
// checkouts can sit on different branches whose bibles differ. Each member
// must see the CONFIRMED set its own checkout carries.
//
// How:
//   - The bible is loaded into a SqliteProvider over DatabaseSync(':memory:')
//     -- the SAME provider class the per-repo DB uses, so ranking, prime() and
//     relatedClaims() behave identically. Entries go through the shared
//     bible-import loader (import mode: bible confidence preserved, directives
//     quarantined as pending proposals), exactly as kb_import would.
//   - One view per bible file path, so members on different branches (different
//     checkouts, different paths) get different views.
//   - Each read does ONE fs.stat. When mtimeMs or size differs from the values
//     recorded at the last load, the view is rebuilt. The file is never hashed.
//   - The cache is process memory only: a server restart starts empty and the
//     first read rebuilds. No file, table or column is added anywhere.
//   - A missing bible is an empty view. A malformed bible throws KbBibleError
//     (E-BIBLE-MALFORMED) every time it is read; it is never cached as empty.
//   - An anchor whose folder is on another host (remoteUrl + memberId set) is
//     served the same way: one cheap stat command over the member transport
//     (mtime + size), and the bible text is fetched only when that changed.
//     Cached per (member, folder). If the member cannot be reached the read
//     fails loudly (E-MEMBER-VIEW-REMOTE); it never falls back to the per-repo DB.

import fs from 'node:fs';
import path from 'node:path';
import { SqliteProvider } from './sqlite-provider.js';
import { readBibleEntries, parseBibleText, importBibleEntries } from './bible-import.js';
import { getAgent } from '../registry.js';
import { getStrategy } from '../strategy.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../../utils/agent-helpers.js';
import { wrapPowerShellEncoded } from '../../os/windows.js';
import type { Agent } from '../../types.js';
import type { KbAnchor } from './kb-self.js';

export type KbMemberViewErrorCode = 'E-MEMBER-VIEW-REMOTE';

export class KbMemberViewError extends Error {
  readonly code: KbMemberViewErrorCode;
  readonly folder: string;
  readonly remediation: string;
  constructor(code: KbMemberViewErrorCode, folder: string, problem: string, remediation: string) {
    super(`${code}: ${problem} Remediation: ${remediation}`);
    this.name = 'KbMemberViewError';
    this.code = code;
    this.folder = folder;
    this.remediation = remediation;
  }
}

/** The bible file a member view is built from. */
export function memberBiblePath(folder: string): string {
  return path.join(folder, '.fleet', 'kb-canonical.json');
}

interface ViewSlot {
  /** -1 / -1 when the bible was missing at load time. */
  mtimeMs: number;
  size: number;
  provider: Promise<SqliteProvider>;
}

const _views = new Map<string, ViewSlot>();
const _loadCounts = new Map<string, number>();

function statOrMissing(biblePath: string): { mtimeMs: number; size: number } {
  try {
    const st = fs.statSync(biblePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mtimeMs: -1, size: -1 };
    throw err;
  }
}

async function buildView(biblePath: string, repoRoot: string, missing: boolean): Promise<SqliteProvider> {
  _loadCounts.set(biblePath, (_loadCounts.get(biblePath) ?? 0) + 1);
  // Parse BEFORE opening the database, so a malformed bible costs nothing.
  const entries = missing ? [] : readBibleEntries(biblePath, 'member bible view');
  // repoRoot anchors relative source_files exactly as the per-repo provider
  // does, so the capture basis check and prime()'s freshness check judge the
  // bible against the member's own checkout.
  const provider = new SqliteProvider(':memory:', repoRoot);
  await provider.init();
  if (entries.length > 0) await importBibleEntries(provider, entries);
  return provider;
}

function remoteFail(folder: string, problem: string): KbMemberViewError {
  return new KbMemberViewError(
    'E-MEMBER-VIEW-REMOTE',
    folder,
    problem,
    'Check the member is reachable (member_detail / update_member), then retry; the member must have its checkout bible at <work folder>/.fleet/kb-canonical.json.',
  );
}

function remoteBiblePath(agent: Agent, folder: string): string {
  const win = getAgentOS(agent) === 'windows' && !isPosixShell('windows', getAgentShell(agent));
  return win ? `${folder.replace(/[\\/]+$/, '')}\\.fleet\\kb-canonical.json` : `${folder.replace(/\/+$/, '')}/.fleet/kb-canonical.json`;
}

const REMOTE_TIMEOUT_MS = 20_000;

/** Command that prints "<mtime> <size>" for the bible, or MISSING. */
function statCommand(agent: Agent, p: string): string {
  if (getAgentOS(agent) === 'windows' && !isPosixShell('windows', getAgentShell(agent))) {
    const q = p.replace(/'/g, "''");
    return wrapPowerShellEncoded(`if (Test-Path -LiteralPath '${q}') { $i = Get-Item -LiteralPath '${q}'; [Console]::Out.Write("$($i.LastWriteTimeUtc.Ticks) $($i.Length)") } else { [Console]::Out.Write('MISSING') }`);
  }
  const q = `'${p.replace(/'/g, `'\\''`)}'`;
  return `if [ -f ${q} ]; then (stat -c '%Y %s' ${q} 2>/dev/null || stat -f '%m %z' ${q}); else printf MISSING; fi`;
}

function catCommand(agent: Agent, p: string): string {
  if (getAgentOS(agent) === 'windows' && !isPosixShell('windows', getAgentShell(agent))) {
    const q = p.replace(/'/g, "''");
    return wrapPowerShellEncoded(`[Console]::Out.Write([System.IO.File]::ReadAllText('${q}'))`);
  }
  return `cat '${p.replace(/'/g, `'\\''`)}'`;
}

async function getRemoteMemberBibleView(anchor: KbAnchor): Promise<SqliteProvider> {
  const agent = anchor.memberId ? getAgent(anchor.memberId) : undefined;
  if (!agent) {
    throw remoteFail(anchor.folder, `The member for work folder '${anchor.folder}' is not registered, so its checkout bible cannot be fetched.`);
  }
  const strategy = getStrategy(agent);
  const biblePath = remoteBiblePath(agent, anchor.folder);
  const key = `remote:${agent.id}:${biblePath}`;
  const run = async (cmd: string): Promise<string> => {
    let r;
    try {
      r = await strategy.execCommand(cmd, REMOTE_TIMEOUT_MS);
    } catch (err) {
      throw remoteFail(anchor.folder, `Could not reach member '${agent.friendlyName}' to read its checkout bible: ${err instanceof Error ? err.message : String(err)}.`);
    }
    if (r.code !== 0) {
      throw remoteFail(anchor.folder, `Reading the bible on member '${agent.friendlyName}' failed (exit ${r.code}): ${r.stderr.trim()}.`);
    }
    return r.stdout;
  };
  const statOut = (await run(statCommand(agent, biblePath))).split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? '';
  let mtimeMs = -1;
  let size = -1;
  if (statOut !== 'MISSING') {
    const m = /^(\d+) (\d+)$/.exec(statOut);
    if (!m) throw remoteFail(anchor.folder, `Unexpected stat output from member '${agent.friendlyName}': '${statOut.slice(0, 80)}'.`);
    mtimeMs = Number(m[1]);
    size = Number(m[2]);
  }
  const current = _views.get(key);
  if (current && current.mtimeMs === mtimeMs && current.size === size) return current.provider;
  const build = async (): Promise<SqliteProvider> => {
    _loadCounts.set(key, (_loadCounts.get(key) ?? 0) + 1);
    const entries = mtimeMs === -1 ? [] : parseBibleText(await run(catCommand(agent, biblePath)), biblePath, 'member bible view');
    // The member's checkout is on another host: nothing here can verify its
    // source files, so import unanchored, then bind the remote folder so
    // freshness issues no verdict (see SqliteProvider.bindRepoPath).
    const provider = new SqliteProvider(':memory:');
    await provider.init();
    if (entries.length > 0) await importBibleEntries(provider, entries);
    provider.bindRepoPath(anchor.folder);
    return provider;
  };
  const slot: ViewSlot = { mtimeMs, size, provider: build() };
  _views.set(key, slot);
  slot.provider.catch(() => {
    if (_views.get(key) === slot) _views.delete(key);
  });
  return slot.provider;
}

/**
 * The in-memory view of the anchor's checkout bible. Rebuilt when the file's
 * mtime or size changed since the last load; otherwise the cached view.
 */
export async function getMemberBibleView(anchor: KbAnchor): Promise<SqliteProvider> {
  if (anchor.remoteUrl !== undefined) return getRemoteMemberBibleView(anchor);
  const biblePath = memberBiblePath(anchor.folder);
  const { mtimeMs, size } = statOrMissing(biblePath);
  const current = _views.get(biblePath);
  if (current && current.mtimeMs === mtimeMs && current.size === size) {
    return current.provider;
  }
  // The replaced view is not closed: a concurrent reader may still hold it
  // mid-call. Dropping the reference lets it be collected.
  const slot: ViewSlot = { mtimeMs, size, provider: buildView(biblePath, anchor.folder, mtimeMs === -1) };
  _views.set(biblePath, slot);
  // Never cache a failed build (a malformed bible must fail on every read, and
  // a fixed bible must load without a restart).
  slot.provider.catch(() => {
    if (_views.get(biblePath) === slot) _views.delete(biblePath);
  });
  return slot.provider;
}

/** Number of times the view for this bible path has been (re)built. For tests. */
export function memberBibleViewLoadCount(biblePath: string): number {
  return _loadCounts.get(biblePath) ?? 0;
}

/** Drop every cached view (what a server restart does). */
export function resetMemberBibleViews(): void {
  _views.clear();
  _loadCounts.clear();
}
