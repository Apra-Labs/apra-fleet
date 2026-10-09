import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CodeIntelligenceProvider } from './code-intelligence.js';
import { freshnessNote } from './code-intelligence-freshness.js';
import { maybeScheduleReindex, GITNEXUS_PACKAGE_SPEC } from './code-intelligence-reindex.js';
import { isTestPath } from './code-intelligence-tests.js';
import { codeIndexReadiness, ensureGitNexusIndexReady, indexChangedDuringCallError } from './code-intelligence-readiness.js';
import { indexGeneration, readGitNexusIndexState } from './code-index-state.js';
import { logError } from '../utils/log-helpers.js';
import { missingOnServerPathMessage, npxUnavailableReason } from '../utils/find-on-path.js';

let sharedClient: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

// Index generation (indexGeneration: meta lastCommit|indexedAt) each repo had
// when the CURRENT gitnexus child last answered for it. The child is
// long-lived and keeps its own handle on a repo's index; when an analyze
// replaces that index on disk, the old handle can read a half-old,
// half-new graph and resolve a name to an unrelated symbol. A changed
// generation therefore recycles the child before the next call.
const servedGeneration = new Map<string, string>();

// Structured, actionable "offline" result. Same shape as a normal MCP tool
// result (content array of text plus isError) so callers never receive an
// unhandled throw or a silent empty result -- mirrors the F3.1 error shape.
const OFFLINE_MESSAGE =
  "Code intelligence is offline: the gitnexus service could not be reached. " +
  "Start or reinstall it by running 'npx gitnexus analyze --index-only' in the repo " +
  "(or /pm index), then retry.";

function offlineResult(detail?: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const text = detail ? `${OFFLINE_MESSAGE} (${detail})` : OFFLINE_MESSAGE;
  return { content: [{ type: 'text', text }], isError: true };
}

// Reset the shared connection state so the next call reconnects from scratch.
function resetConnection(): void {
  sharedClient = null;
  connectionPromise = null;
  servedGeneration.clear();
}

/** Drop the current child (closing it) so the next call starts a fresh one. */
function recycleConnection(): void {
  const old = sharedClient;
  resetConnection();
  if (old) {
    try {
      const closing = (old as { close?: () => Promise<void> }).close?.();
      if (closing && typeof closing.catch === 'function') closing.catch(() => { /* already gone */ });
    } catch { /* already gone */ }
  }
}

async function getGitNexusClient(): Promise<Client> {
  if (sharedClient) return sharedClient;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    // Fail with the cause, not a bare "spawn npx ENOENT": a service-managed
    // server only has the PATH its service definition recorded at install.
    const npxReason = npxUnavailableReason();
    if (npxReason) throw new Error(npxReason); // callGitNexus resets the connection
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', GITNEXUS_PACKAGE_SPEC, 'mcp'],
      stderr: 'pipe',
    });

    const client = new Client(
      { name: 'apra-fleet', version: '1.0.0' },
      { capabilities: {} },
    );

    // Transport death reset: if the child process dies (close) or the
    // transport/client errors after a successful connect, drop the cached
    // client and promise so the next call reconnects. Guard on identity so a
    // late handler for a client that was already replaced does not clobber a
    // newer connection.
    const onDeath = (): void => {
      if (sharedClient === client) {
        resetConnection();
      }
    };
    transport.onclose = onDeath;
    transport.onerror = onDeath;
    client.onclose = onDeath;
    client.onerror = onDeath;

    try {
      await client.connect(transport);
    } catch (err) {
      // Failure reset: clear the poisoned promise (sharedClient stays null) so
      // the NEXT call attempts a brand-new connection instead of awaiting a
      // rejected promise forever. Rethrow so the current caller sees failure.
      connectionPromise = null;
      throw err;
    }

    sharedClient = client;
    return client;
  })();

  return connectionPromise;
}

// Freshness metadata (F2.2): when a call carries a `repo` param and the index
// exists, compare meta.json's lastCommit against the repo's current
// `git rev-parse HEAD`. Never throws -- any failure reading meta.json or
// running git degrades to "no note" so a stale/missing index or unavailable
// git never blocks or fails the call.
//
// P3 (design D3): when divergence is detected, this is also the trigger point
// for a background reindex -- "already per-call, already knows repo +
// divergence; no new watchers, no cron". maybeScheduleReindex() is
// synchronous and non-blocking (it spawns the child detached/unref'd and
// returns immediately), so calling it here adds no tool-call latency. Any
// error from it is swallowed and logged -- it must never affect the note or
// the tool result.
function computeFreshnessNote(repo: string): string | null {
  try {
    const metaPath = join(repo, '.gitnexus', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { lastCommit?: string };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();

    const diverged = freshnessNote(meta.lastCommit, head) !== null;
    let reindexScheduled = false;
    if (diverged) {
      try {
        reindexScheduled = maybeScheduleReindex(repo);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logError('code-intelligence-gitnexus', `maybeScheduleReindex threw for ${repo}: ${detail}`);
        reindexScheduled = false;
      }
    }

    return freshnessNote(meta.lastCommit, head, reindexScheduled);
  } catch {
    return null;
  }
}

// Append the freshness note to an MCP tool response as an additional text
// content block, preserving the existing content array shape. If the result
// does not look like a content-array response, return it unchanged rather
// than risk corrupting an unexpected shape.
function appendFreshnessNote(result: unknown, note: string): unknown {
  if (
    result &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const { content, ...rest } = result as { content: unknown[] } & Record<string, unknown>;
    return { ...rest, content: [...content, { type: 'text', text: note }] };
  }
  return result;
}

// Single guarded entry point for every provider method. A thrown
// connection/dead-client error is converted into a structured actionable
// result and the shared state is reset so the next call reconnects.
//
// Pre-flight (F3.1): when the call carries a non-empty `repo` param, verify
// the repo's index is ready (codeIndexReadiness, code-intelligence-readiness.ts
// -- the one readiness check) BEFORE ever touching the child process; a
// not-ready index throws E-CODE-INDEX-NOT-READY. A missing or interrupted
// (died mid-write) index first gets a background build started
// (ensureGitNexusIndexReady), so a dead index heals itself instead of failing
// every call until someone reindexes by hand. Every code_* tool call carries the calling
// session's resolved (self) folder as `repo` (resolveCodeSelf in
// code-intelligence.ts); a direct provider call without one is forwarded
// untouched.
//
// Consistency fence: the index generation is read before the call; a child
// that last answered this repo from an older generation is recycled first.
// AFTER the call, readiness and the generation are checked again: if an
// analyze started, finished, or left the metadata inconsistent while the
// call ran, the answer may come from a half-rewritten index and is DISCARDED
// with E-CODE-INDEX-NOT-READY rather than returned.
async function callGitNexus(name: string, params: Record<string, unknown>): Promise<unknown> {
  const repo = params.repo;
  const hasRepo = typeof repo === 'string' && repo.length > 0;
  let generation = '';
  if (hasRepo) {
    ensureGitNexusIndexReady(repo as string);
    generation = indexGeneration(readGitNexusIndexState(repo as string));
    const seen = servedGeneration.get(repo as string);
    if (seen !== undefined && seen !== generation) recycleConnection();
  }

  let result: unknown;
  try {
    const client = await getGitNexusClient();
    result = await client.callTool({ name, arguments: params });
  } catch (err) {
    resetConnection();
    let detail = err instanceof Error ? err.message : String(err);
    if (/\bENOENT\b/.test(detail) && /npx/.test(detail)) detail = `${detail}: ${missingOnServerPathMessage('npx')}`;
    return offlineResult(detail);
  }

  if (!hasRepo) return result;
  const after = codeIndexReadiness('gitnexus', repo as string);
  const generationAfter = indexGeneration(readGitNexusIndexState(repo as string));
  if (!after.ready || generationAfter !== generation) {
    // The child may hold a handle on the index that just changed.
    recycleConnection();
    throw indexChangedDuringCallError(repo as string, after);
  }
  servedGeneration.set(repo as string, generation);
  const note = computeFreshnessNote(repo as string);
  return note ? appendFreshnessNote(result, note) : result;
}

// ---------------------------------------------------------------------------
// Resolution check (code_impact / code_context): gitnexus resolves the
// requested name to a symbol and reports the one it used (impact: `target`,
// context: `symbol`). An answer about a DIFFERENT symbol than the one asked
// for -- e.g. a stale or half-rewritten index mapping a name to an unrelated
// node -- must never read as a confident answer about the requested one, so
// it is flagged (resolution_mismatch, confidence LOW) and an impact risk
// level is moved to unverified_risk with risk 'UNKNOWN'.
// ---------------------------------------------------------------------------

export interface ResolvedSymbol {
  name?: string;
  id?: string;
  filePath?: string;
}

export interface ResolutionMismatch {
  requested: string;
  resolved: ResolvedSymbol;
}

const QUALIFIER_SEPS = ['.', '::', '#', ':', '/'];

/** True when `qualified` is `simple` or a qualified form ending in it. */
function endsWithSymbol(qualified: string, simple: string): boolean {
  if (qualified === '' || simple === '') return false;
  return qualified === simple || QUALIFIER_SEPS.some((sep) => qualified.endsWith(sep + simple));
}

/**
 * Drop the disambiguation tags gitnexus appends to an id AFTER the qualified
 * name, so the symbol segment can be compared with a plain name:
 * '#<arity>' (every Method, Constructor and class-nested Function), followed
 * by optional collision tags ('~type1,type2', '$const'), '~shape:<...>'
 * parameter-shape tags, '~T1,T2' class template arguments and '~c:<hash>'
 * constraints. Several of these contain a single ':' themselves, so they must
 * go before the id is split. Only the last path segment is scanned for a '~'
 * tag (a '~' in a directory name is not a tag), and a '~' right after '.' or
 * ':' starts a C++ destructor name ('Foo.~Foo'), not a tag.
 */
function stripIdTags(id: string): string {
  const arity = id.search(/#\d/);
  const head = arity >= 0 ? id.slice(0, arity) : id;
  for (let i = head.lastIndexOf('/') + 1; i < head.length; i++) {
    if (head[i] !== '~') continue;
    const prev = i > 0 ? head[i - 1] : '';
    if (prev === '.' || prev === ':') continue;
    return head.slice(0, i);
  }
  return head;
}

/**
 * Split a gitnexus id/uid ("Function:src/a.ts:Svc.run", "a.mjs:fn",
 * "Function:src/a.rs:ns::fn") at its last SINGLE ':' (a '::' is part of the
 * symbol) into the file part before it and the symbol segment after it.
 * Returns null when the id has no single ':' -- nothing to cross-check.
 */
function splitSymbolId(rawId: string): { file: string; symbol: string } | null {
  const id = stripIdTags(rawId);
  const singles: number[] = [];
  for (let i = 0; i < id.length; i++) {
    if (id[i] !== ':') continue;
    if (id[i + 1] === ':') { i++; continue; }
    singles.push(i);
  }
  if (singles.length === 0) return null;
  const last = singles[singles.length - 1];
  const prev = singles.length > 1 ? singles[singles.length - 2] + 1 : 0;
  return { file: id.slice(prev, last), symbol: id.slice(last + 1) };
}

function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

/**
 * True when `resolved` is the symbol `requested` names: equal to its name,
 * id (uid) or file path, or a qualified form ending in the name
 * (Class.method, ns::fn, Class#method, file.ts:fn, dir/file.ts). A response
 * that resolved nothing (no name and no id) has nothing to contradict.
 *
 * A matching name alone is not proof: a corrupt index can return the
 * requested name on a node whose id names an unrelated symbol (name
 * 'runUninstall', id 'beads-children.mjs:claimBeadsBatched'). So when an id
 * is present its symbol segment must agree with the name (or, with no name,
 * with the request), and a file part that looks like a path must agree with
 * filePath; any disagreement is a mismatch even if the name matches.
 */
export function resolvesToRequested(requested: string, resolved: ResolvedSymbol): boolean {
  const req = requested.trim();
  const name = resolved.name ?? '';
  const id = resolved.id ?? '';
  if (req === '' || (name === '' && id === '')) return true;

  const parts = id !== '' ? splitSymbolId(id) : null;
  if (parts) {
    // The id's own symbol must be the symbol the response names.
    if (name !== '' && !endsWithSymbol(parts.symbol, name)) return false;
    // A path-like file part must be the file the response names.
    const filePath = resolved.filePath ?? '';
    if (filePath !== '' && /[./]/.test(parts.file) && !sameFile(parts.file, filePath)) return false;
  }

  if (req === name || req === id || req === resolved.filePath) return true;
  if (name !== '') return endsWithSymbol(req, name);
  // No name: compare the request with the id's symbol segment.
  return parts !== null && (endsWithSymbol(req, parts.symbol) || endsWithSymbol(parts.symbol, req));
}

function resolvedFrom(value: unknown): ResolvedSymbol | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);
  const out: ResolvedSymbol = { name: str(v.name), id: str(v.id) ?? str(v.uid), filePath: str(v.filePath) };
  return out.name || out.id ? out : null;
}

/**
 * Flag a code_impact ('impact', resolved symbol in payload.target) or
 * code_context ('context', payload.symbol) result whose resolved symbol is not
 * the requested one. Returns the result unchanged when it matches, is an
 * error, or is not the JSON shape gitnexus returns.
 */
export function flagResolutionMismatch(result: unknown, requested: unknown, kind: 'impact' | 'context'): unknown {
  if (typeof requested !== 'string' || isErrorResult(result)) return result;
  if (!result || typeof result !== 'object' || !('content' in result)) return result;
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return result;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || typeof first.text !== 'string') return result;
  const sep = '\n\n---\n';
  const cut = first.text.indexOf(sep);
  const jsonPart = cut >= 0 ? first.text.slice(0, cut) : first.text;
  const suffix = cut >= 0 ? first.text.slice(cut) : '';
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonPart) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    payload = parsed as Record<string, unknown>;
  } catch { return result; }

  const resolved = resolvedFrom(kind === 'impact' ? payload.target : payload.symbol);
  if (!resolved || resolvesToRequested(requested, resolved)) return result;

  const mismatch: ResolutionMismatch = { requested, resolved };
  const what = `${resolved.name ?? resolved.id}${resolved.filePath ? ` (${resolved.filePath})` : ''}` +
    (resolved.name && resolved.id ? `, id ${resolved.id}` : '');
  const warning = `[code-intelligence] RESOLUTION MISMATCH: '${requested}' resolved to a different symbol, ${what}. ` +
    'This answer is about that symbol, not the one requested; confidence is LOW. ' +
    'Check the name (or pass file_path), and run code_status -- an index rebuilt or left inconsistent can map a name to an unrelated symbol.';
  const patched: Record<string, unknown> = { ...payload, resolution_mismatch: mismatch, confidence: 'LOW' };
  if (kind === 'impact' && 'risk' in payload) {
    patched.unverified_risk = payload.risk;
    patched.risk = 'UNKNOWN';
  }
  const rest = result as Record<string, unknown>;
  return {
    ...rest,
    content: [
      { ...first, text: JSON.stringify(patched, null, 2) + suffix },
      ...content.slice(1),
      { type: 'text', text: warning },
    ],
    resolution_mismatch: mismatch,
    confidence: 'LOW',
  };
}

// ---------------------------------------------------------------------------
// Rung-2 compose support (T2.1 code_map, T2.2 code_flow): gitnexus 1.6.7 has
// no direct communities/map or flows/processes tool (see
// docs/code-intelligence-child-surface.md). Both compose over the generic
// `cypher` tool, which returns `{ markdown, row_count }` -- a Markdown table,
// not JSON rows -- so the response must be parsed here rather than passed
// through untouched like graph/impact/query/context above. Do NOT parse
// ladybugdb directly; always route through callGitNexus('cypher', ...).
// ---------------------------------------------------------------------------

export type MarkdownTableRow = Record<string, string>;

// Small, pure, exported so both T2.1 (code_map) and T2.2 (code_flow) can reuse
// it and it can be unit tested directly without mocking the MCP client.
export function parseMarkdownTable(markdown: string): MarkdownTableRow[] {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return [];

  const splitRow = (line: string): string[] =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const headers = splitRow(lines[0]);
  // lines[1] is the "| --- | --- |" separator row -- data starts at index 2.
  const rows: MarkdownTableRow[] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const row: MarkdownTableRow = {};
    headers.forEach((header, idx) => {
      row[header] = cells[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

// gitnexus heuristicLabels for processes encode "Entry -> Terminal" using a
// Unicode arrow (confirmed in the T1.1 spike sample: "RemoveMember -> MaskSecrets").
// Community keywords can also carry non-ASCII punctuation. Sanitize before this
// text is written anywhere in an ASCII-only project (repo convention).
const UNICODE_ARROW_PATTERN = /[→⇒⟶⟹➔➜↦]/g;

export function asciiSanitizeLabel(label: string): string {
  if (typeof label !== 'string') return label;
  return label
    .replace(UNICODE_ARROW_PATTERN, '->')
    .replace(/[^\x00-\x7F]/g, '?');
}

function isErrorResult(result: unknown): boolean {
  return !!(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true);
}

// The child's `cypher` tool result is an MCP content array whose text is
// `JSON.stringify({ markdown, row_count }, null, 2)` followed by a
// "\n\n---\n**Next:**..." hint suffix (see gitnexus dist/mcp/server.js). Strip
// the hint before parsing so `JSON.parse` sees only the payload.
function extractCypherPayload(result: unknown): { markdown: string; row_count: number } | null {
  if (!result || typeof result !== 'object' || !('content' in result)) return null;
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as { text?: unknown } | undefined;
  if (!first || typeof first.text !== 'string') return null;

  const jsonPart = first.text.split('\n\n---\n')[0];
  try {
    const parsed = JSON.parse(jsonPart) as { markdown?: unknown; row_count?: unknown };
    if (typeof parsed.markdown === 'string') {
      return {
        markdown: parsed.markdown,
        row_count: typeof parsed.row_count === 'number' ? parsed.row_count : 0,
      };
    }
  } catch {
    // Not the expected shape -- caller falls back to the raw result.
  }
  return null;
}

function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function mapCommunitiesResult(result: unknown): unknown {
  if (isErrorResult(result)) return result;
  const payload = extractCypherPayload(result);
  if (!payload) return result;

  const communities = parseMarkdownTable(payload.markdown).map((row) => ({
    label: asciiSanitizeLabel(row.label ?? ''),
    symbols: Number(row.symbols) || 0,
    cohesion: row.cohesion !== undefined && row.cohesion !== '' ? Number(row.cohesion) : undefined,
    keywords: row.keywords !== undefined ? asciiSanitizeLabel(row.keywords) : undefined,
  }));

  return textResult({ communities, row_count: payload.row_count });
}

// Bounds the number of matched processes for which a second (steps) query is
// issued, so a broad/unfiltered flow() call cannot fan out unbounded cypher
// calls against the child.
const MAX_FLOW_STEP_LOOKUPS = 5;

const FLOW_STEP_QUERY =
  'MATCH (s)-[r:CodeRelation {type: "STEP_IN_PROCESS"}]->(p:Process) WHERE p.heuristicLabel = $label ' +
  'RETURN s.name AS step, s.filePath AS filePath, r.step AS stepOrder ORDER BY r.step';

async function mapFlowResult(listResult: unknown, repo: string | undefined): Promise<unknown> {
  if (isErrorResult(listResult)) return listResult;
  const payload = extractCypherPayload(listResult);
  if (!payload) return listResult;

  const rows = parseMarkdownTable(payload.markdown);
  const processes: Array<{ label: string; processType: string; stepCount: number; steps: Array<{ step: string; filePath: string; order: number }> }> = [];

  for (const row of rows.slice(0, MAX_FLOW_STEP_LOOKUPS)) {
    const rawLabel = row.label ?? '';
    const stepsResult = await callGitNexus('cypher', {
      query: FLOW_STEP_QUERY,
      params: { label: rawLabel },
      ...(repo ? { repo } : {}),
    });
    const stepsPayload = extractCypherPayload(stepsResult);
    const steps = stepsPayload
      ? parseMarkdownTable(stepsPayload.markdown).map((s) => ({
          step: asciiSanitizeLabel(s.step ?? ''),
          filePath: s.filePath ?? '',
          order: Number(s.stepOrder) || 0,
        }))
      : [];

    processes.push({
      label: asciiSanitizeLabel(rawLabel),
      processType: row.processType ?? '',
      stepCount: Number(row.stepCount) || 0,
      steps,
    });
  }

  return textResult({ processes, row_count: payload.row_count });
}

// ---------------------------------------------------------------------------
// Rung-1/2 compose support (T4.4 code_tests): the upstream traversal itself
// is a direct `impact` capability (confirmed in
// docs/code-intelligence-child-surface.md, Decisions table, "Upstream
// traversal depth 2" row); code_tests composes it with the isTestPath filter
// over byDepth filePaths. Do NOT parse ladybugdb directly.
// ---------------------------------------------------------------------------

interface ImpactByDepthItem {
  name?: string;
  filePath?: string;
  [key: string]: unknown;
}

interface ImpactPayload {
  byDepth?: Record<string, ImpactByDepthItem[]>;
  [key: string]: unknown;
}

// The child's `impact` tool result is an MCP content array whose text is
// JSON (per the confirmed shape in docs/code-intelligence-child-surface.md).
// Some child tools (cypher) append a "\n\n---\n**Next:**..." hint suffix
// after the JSON payload; strip it defensively here too in case impact does
// the same, mirroring extractCypherPayload's approach.
function extractImpactPayload(result: unknown): ImpactPayload | null {
  if (!result || typeof result !== 'object' || !('content' in result)) return null;
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as { text?: unknown } | undefined;
  if (!first || typeof first.text !== 'string') return null;

  const jsonPart = first.text.split('\n\n---\n')[0];
  try {
    const parsed = JSON.parse(jsonPart) as ImpactPayload;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Not the expected shape -- caller falls back to the raw result.
  }
  return null;
}

function mapTestsResult(result: unknown): unknown {
  if (isErrorResult(result)) return result;
  const payload = extractImpactPayload(result);
  if (!payload) return result;

  const byDepth = payload.byDepth ?? {};
  const candidates = [...(byDepth['1'] ?? []), ...(byDepth['2'] ?? [])];
  const tests = candidates
    .filter((item) => typeof item.filePath === 'string' && isTestPath(item.filePath))
    .map((item) => ({ name: item.name ?? '', filePath: item.filePath ?? '' }));

  return textResult({ tests, count: tests.length });
}

// ---------------------------------------------------------------------------
// graph() retarget (yashr-5t9): gitnexus 1.6.7 has NO child tool named
// `call_graph` -- the previous mapping callGitNexus('call_graph', ...) always
// returned the child's "Unknown tool: call_graph" isError result, so code_graph
// was silently broken. Live-verified 2026-07 exactly as the fleet spawns the
// child (npx -y gitnexus mcp over stdio): listTools() returns 13 tools and
// `call_graph` is absent; a variable-length CALLS traversal via `cypher`
// returns the { markdown, row_count } shape (confirmed against this repo's
// .gitnexus index). See docs/code-intelligence-child-surface.md.
//
// Chosen approach: compose two depth-bounded `cypher` traversals over CALLS
// edges (callers + callees), rung 2 -- same pattern as map()/flow(). This
// returns a GENUINE multi-hop call graph, which keeps code_graph meaningfully
// distinct from code_context: `context` (mapped to child 'context') is the
// depth-1 360-degree view of a single symbol (direct in/out calls, accesses,
// KB enrichment), whereas code_graph is the transitive caller/callee graph out
// to GRAPH_MAX_DEPTH hops -- something context does not provide. The `symbol`
// arg of codeGraphSchema maps to the Cypher `$symbol` param. Routed through
// callGitNexus so it inherits the pre-flight index check, resilience, and
// freshness wiring. Reuses parseMarkdownTable/asciiSanitizeLabel/
// extractCypherPayload. Do NOT parse ladybugdb directly.
//
// NOTE on freshness: like map()/flow(), graph() reshapes the child's cypher
// output into its own envelope, so the per-call freshness note that
// callGitNexus appends to a passthrough result is not carried through here --
// this is the same accepted trade-off the other composed tools make.

// Depth 2 gives direct callers/callees plus one transitive hop. Inlined into
// the query string because Cypher variable-length bounds cannot be
// parameterized.
const GRAPH_MAX_DEPTH = 2;
const GRAPH_ROW_LIMIT = 100;

// Callers: symbols that transitively CALL the target (incoming CALLS edges).
const GRAPH_CALLERS_QUERY =
  'MATCH p = (caller)-[:CodeRelation*1..' + GRAPH_MAX_DEPTH + ' {type: "CALLS"}]->(target) ' +
  'WHERE target.name = $symbol ' +
  'RETURN DISTINCT caller.name AS name, caller.filePath AS filePath, length(p) AS depth ' +
  'ORDER BY depth, name LIMIT ' + GRAPH_ROW_LIMIT;

// Callees: symbols the target transitively CALLS (outgoing CALLS edges).
const GRAPH_CALLEES_QUERY =
  'MATCH p = (source)-[:CodeRelation*1..' + GRAPH_MAX_DEPTH + ' {type: "CALLS"}]->(callee) ' +
  'WHERE source.name = $symbol ' +
  'RETURN DISTINCT callee.name AS name, callee.filePath AS filePath, length(p) AS depth ' +
  'ORDER BY depth, name LIMIT ' + GRAPH_ROW_LIMIT;

interface CallGraphNode {
  name: string;
  filePath: string;
  depth: number;
}

function mapGraphRows(result: unknown): CallGraphNode[] {
  const payload = extractCypherPayload(result);
  if (!payload) return [];
  return parseMarkdownTable(payload.markdown).map((row) => ({
    name: asciiSanitizeLabel(row.name ?? ''),
    filePath: row.filePath ?? '',
    depth: Number(row.depth) || 0,
  }));
}

export class GitNexusProvider implements CodeIntelligenceProvider {
  async graph(params: Record<string, unknown>): Promise<unknown> {
    const symbol = params.symbol;
    const repoArg = typeof params.repo === 'string' ? { repo: params.repo } : {};

    const callersResult = await callGitNexus('cypher', {
      query: GRAPH_CALLERS_QUERY,
      params: { symbol },
      ...repoArg,
    });
    // Surface offline / missing-index / unknown-error results unchanged, and
    // short-circuit the second call so a broken index does not fan out twice.
    if (isErrorResult(callersResult)) return callersResult;

    const calleesResult = await callGitNexus('cypher', {
      query: GRAPH_CALLEES_QUERY,
      params: { symbol },
      ...repoArg,
    });
    if (isErrorResult(calleesResult)) return calleesResult;

    return textResult({
      symbol: asciiSanitizeLabel(typeof symbol === 'string' ? symbol : String(symbol ?? '')),
      maxDepth: GRAPH_MAX_DEPTH,
      callers: mapGraphRows(callersResult),
      callees: mapGraphRows(calleesResult),
    });
  }

  async impact(params: Record<string, unknown>): Promise<unknown> {
    return flagResolutionMismatch(await callGitNexus('impact', params), params.target, 'impact');
  }

  async query(params: Record<string, unknown>): Promise<unknown> {
    return callGitNexus('query', params);
  }

  async context(params: Record<string, unknown>): Promise<unknown> {
    return flagResolutionMismatch(await callGitNexus('context', params), params.name, 'context');
  }

  // T2.1: architectural map via Community nodes (rung 2 -- compose over cypher;
  // no direct communities/map tool exists on gitnexus 1.6.7). See Decisions
  // table in docs/code-intelligence-child-surface.md.
  async map(params: Record<string, unknown>): Promise<unknown> {
    const top = typeof params.top === 'number' && params.top > 0 ? params.top : 20;
    const repo = params.repo;
    const result = await callGitNexus('cypher', {
      query:
        'MATCH (c:Community) RETURN c.heuristicLabel AS label, c.symbolCount AS symbols, ' +
        'c.cohesion AS cohesion, c.keywords AS keywords ORDER BY symbols DESC LIMIT $top',
      params: { top },
      ...(typeof repo === 'string' ? { repo } : {}),
    });
    return mapCommunitiesResult(result);
  }

  // T2.2: process flows via Process/STEP_IN_PROCESS nodes (rung 2 -- compose
  // over cypher; no direct flows/processes tool, and code_query's `processes`
  // array is free-text only, not from/to/name filterable). See Decisions table
  // in docs/code-intelligence-child-surface.md. from/to are matched against the
  // "Entry -> Terminal" heuristicLabel text (CONTAINS) since there is no
  // structured endpoint field to filter on directly.
  async flow(params: Record<string, unknown>): Promise<unknown> {
    const repo = typeof params.repo === 'string' ? params.repo : undefined;
    const conditions: string[] = [];
    const cypherParams: Record<string, unknown> = {};

    if (typeof params.name === 'string' && params.name.length > 0) {
      conditions.push('p.heuristicLabel CONTAINS $name');
      cypherParams.name = params.name;
    }
    if (typeof params.from === 'string' && params.from.length > 0) {
      conditions.push('p.heuristicLabel CONTAINS $from');
      cypherParams.from = params.from;
    }
    if (typeof params.to === 'string' && params.to.length > 0) {
      conditions.push('p.heuristicLabel CONTAINS $to');
      cypherParams.to = params.to;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} ` : '';
    const listResult = await callGitNexus('cypher', {
      query:
        `MATCH (p:Process) ${whereClause}RETURN p.heuristicLabel AS label, ` +
        'p.processType AS processType, p.stepCount AS stepCount ORDER BY stepCount DESC LIMIT 20',
      params: cypherParams,
      ...(repo ? { repo } : {}),
    });
    return mapFlowResult(listResult, repo);
  }

  // T4.4: test-to-symbol mapping via the `impact` upstream traversal (rung
  // 1/2 -- direct tool, composed filter; see Decisions table in
  // docs/code-intelligence-child-surface.md, "Upstream traversal depth 2"
  // row). Depth is fixed at 2 per design D9. includeTests: true so test
  // files are not filtered out by the child before isTestPath ever sees
  // them.
  async tests(params: Record<string, unknown>): Promise<unknown> {
    const repo = params.repo;
    const result = await callGitNexus('impact', {
      target: params.symbol,
      direction: 'upstream',
      maxDepth: 2,
      includeTests: true,
      ...(typeof repo === 'string' ? { repo } : {}),
    });
    return mapTestsResult(result);
  }
}
