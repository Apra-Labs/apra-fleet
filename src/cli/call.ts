/**
 * `apra-fleet call` -- generic member-session tool call.
 *
 *   apra-fleet call --member <uuid> [--kb-maintainer] <tool> [--args-file <path>]
 *   apra-fleet call --member <uuid> [--kb-maintainer] --list-tools
 *
 * Opens a MEMBER session (?member=<uuid>) against the LOCAL server through
 * apra-fleet-client, so the server's own input schema validates the arguments
 * and the member tool allowlist applies. Arguments are ALWAYS read from a JSON
 * file -- there is deliberately no inline-JSON flag. Without --args-file the
 * arguments are {}, allowed only for a tool whose input schema requires none. The session is opened with
 * origin=engine, so its kb_/code_ calls are excluded from session_stats. Failures are printed as a
 * structured JSON error on stderr and the exit code is non-zero.
 *
 * --kb-maintainer adds the engine's kb_maintainer grant (kb_maintainer=1): the
 * session is also served kb_promote, kb_resolve_contradiction and
 * kb_reconcile_prefilter, and may pass kb_import an explicit path. Remote
 * memberCall passes it only when calling as a repository's kb_maintainer.
 */
import fs from 'node:fs';
import { clientExpectedVersion } from '../version.js';

const USAGE = `apra-fleet call -- call a tool as a registered member session

Usage:
  apra-fleet call --member <uuid> [--kb-maintainer] <tool> [--args-file <path>]
  apra-fleet call --member <uuid> [--kb-maintainer] --list-tools

  --member <uuid>       Registered member id (an unregistered id fails with HTTP 403)
  --args-file <path>    JSON file holding the tool arguments (a JSON object); omit it
                        for a tool with no required arguments (they default to {})
  --rm-args-file        Delete the args file once read (used by remote memberCall)
  --kb-maintainer       Open the session with the kb_maintainer grant (adds kb_promote
                        and kb_resolve_contradiction; used by memberCall for the
                        repository's kb_maintainer)
  --list-tools          Print the member session's tools/list
  --help, -h            Show this help`;

export interface CallIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CallDeps {
  io?: CallIo;
  readFile?: (p: string) => string;
  removeFile?: (p: string) => void;
  /** Connect a member session; defaults to the client's connectFleetMember. */
  connect?: (memberId: string, opts: { kbMaintainer: boolean }) => Promise<{
    transport: { stop?: () => void };
    /** Releases the server-side session (HTTP DELETE); preferred over transport.stop(). */
    close?: () => Promise<void>;
    mcpClient: {
      callTool(name: string, args: unknown): Promise<unknown>;
      listTools(): Promise<unknown>;
    };
  }>;
}

interface Parsed {
  member?: string;
  tool?: string;
  argsFile?: string;
  rmArgsFile: boolean;
  kbMaintainer: boolean;
  listTools: boolean;
  help: boolean;
}

function parse(argv: string[]): Parsed | { error: string } {
  const out: Parsed = { listTools: false, rmArgsFile: false, kbMaintainer: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--list-tools') out.listTools = true;
    else if (a === '--rm-args-file') out.rmArgsFile = true;
    else if (a === '--kb-maintainer') out.kbMaintainer = true;
    else if (a === '--member' || a === '--args-file') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} requires a value` };
      if (a === '--member') out.member = v; else out.argsFile = v;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else if (out.tool === undefined) out.tool = a;
    else return { error: `unexpected argument ${a}` };
  }
  return out;
}

function fail(io: CallIo, code: string, message: string, extra: Record<string, unknown> = {}): number {
  io.err(JSON.stringify({ error: { code, message, ...extra } }));
  return 1;
}

/** The required argument names of `tool` in a tools/list answer ([] when the
 *  tool is not listed: the server then reports the unknown tool itself). */
function requiredArgs(list: unknown, tool: string): string[] {
  const tools = (list as { tools?: Array<{ name?: string; inputSchema?: { required?: unknown } }> } | null)?.tools;
  const t = Array.isArray(tools) ? tools.find(x => x?.name === tool) : undefined;
  const req = t?.inputSchema?.required;
  return Array.isArray(req) ? req.map(String) : [];
}

/**
 * The client deps `apra-fleet call` connects its member session with:
 * origin=engine (the engine acting as the member, so its kb_/code_ calls are
 * not counted in session_stats), the kb_maintainer grant when asked, and this
 * binary's own version as `expectedVersion` -- on a member install the client
 * has no other source, and without it an auto-start of a stopped server
 * refuses with AUTOSTART_VERSION_UNKNOWN.
 */
export function memberCallConnectDeps(opts: { kbMaintainer: boolean }): {
  origin: 'engine'; kbMaintainer?: true; expectedVersion?: string;
} {
  const expectedVersion = clientExpectedVersion();
  return {
    origin: 'engine',
    ...(opts.kbMaintainer ? { kbMaintainer: true as const } : {}),
    ...(expectedVersion ? { expectedVersion } : {}),
  };
}

/** Returns the process exit code. */
export async function runCall(argv: string[], deps: CallDeps = {}): Promise<number> {
  const io: CallIo = deps.io ?? { out: t => console.log(t), err: t => console.error(t) };
  const parsed = parse(argv);
  if ('error' in parsed) return fail(io, 'E-USAGE', parsed.error);
  if (parsed.help) { io.out(USAGE); return 0; }
  if (!parsed.member) return fail(io, 'E-USAGE', '--member <uuid> is required');
  if (parsed.listTools) {
    if (parsed.tool || parsed.argsFile) return fail(io, 'E-USAGE', '--list-tools takes no tool name or --args-file');
  } else {
    if (!parsed.tool) return fail(io, 'E-USAGE', 'a tool name is required (or use --list-tools)');
    if (parsed.rmArgsFile && !parsed.argsFile) return fail(io, 'E-USAGE', '--rm-args-file requires --args-file <path>');
  }

  // No --args-file: the arguments default to {} -- checked against the tool's
  // input schema once connected (a tool with required arguments still needs a file).
  let args: unknown = parsed.listTools ? undefined : {};
  if (!parsed.listTools && parsed.argsFile) {
    try {
      args = JSON.parse((deps.readFile ?? (p => fs.readFileSync(p, 'utf8')))(parsed.argsFile!));
    } catch (e) {
      return fail(io, 'E-ARGS-FILE', `cannot read JSON from ${parsed.argsFile}: ${(e as Error).message}`);
    } finally {
      if (parsed.rmArgsFile) {
        try { (deps.removeFile ?? (p => fs.rmSync(p, { force: true })))(parsed.argsFile!); } catch { /* ignore */ }
      }
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return fail(io, 'E-ARGS-FILE', `${parsed.argsFile} must contain a JSON object`);
    }
  }

  const connect = deps.connect ?? (async (id: string, opts: { kbMaintainer: boolean }) => {
    const m = await import('@apralabs/apra-fleet-client/server-resolution');
    return m.connectFleetMember(id, memberCallConnectDeps(opts));
  });

  let session;
  try {
    session = await connect(parsed.member, { kbMaintainer: parsed.kbMaintainer });
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    if (err.status === 403) {
      return fail(io, 'E-MEMBER-FORBIDDEN', `server refused member ${parsed.member}: not a registered member (HTTP 403)`, { status: 403 });
    }
    if (err.status === 401) {
      return fail(io, 'E-MEMBER-SECRET', `server refused the member session for ${parsed.member}: the member access secret (member-access.key in this install's data dir) was missing or did not match (HTTP 401). Run this as the install's own user, with the same APRA_FLEET_DATA_DIR as its server.`, { status: 401 });
    }
    return fail(io, err.code ?? 'E-CONNECT', err.message);
  }

  try {
    if (parsed.listTools) {
      io.out(JSON.stringify(await session.mcpClient.listTools()));
      return 0;
    }
    if (!parsed.argsFile) {
      const required = requiredArgs(await session.mcpClient.listTools(), parsed.tool!);
      if (required.length) {
        return fail(io, 'E-USAGE', `--args-file <path> is required (${parsed.tool} requires: ${required.join(', ')})`, { tool: parsed.tool });
      }
    }
    const result = await session.mcpClient.callTool(parsed.tool!, args) as { isError?: boolean; content?: Array<{ text?: string }> };
    if (result && result.isError) {
      const text = (result.content ?? []).map(c => c.text ?? '').join('\n');
      return fail(io, 'E-TOOL', text || 'tool returned an error', { tool: parsed.tool });
    }
    io.out(JSON.stringify(result));
    return 0;
  } catch (e) {
    return fail(io, 'E-CALL', (e as Error).message, { tool: parsed.tool });
  } finally {
    try {
      if (session.close) await session.close(); else session.transport.stop?.();
    } catch { /* ignore */ }
  }
}

export function runCallCli(argv: string[]): void {
  runCall(argv).then(code => process.exit(code), e => { console.error(String(e)); process.exit(1); });
}
