/**
 * `apra-fleet call` -- generic member-session tool call.
 *
 *   apra-fleet call --member <uuid> <tool> --args-file <path>
 *   apra-fleet call --member <uuid> --list-tools
 *
 * Opens a MEMBER session (?member=<uuid>) against the LOCAL server through
 * apra-fleet-client, so the server's own input schema validates the arguments
 * and the member tool allowlist applies. Arguments are ALWAYS read from a JSON
 * file -- there is deliberately no inline-JSON flag. The session is opened with
 * origin=engine, so its kb_/code_ calls are excluded from session_stats. Failures are printed as a
 * structured JSON error on stderr and the exit code is non-zero.
 */
import fs from 'node:fs';

const USAGE = `apra-fleet call -- call a tool as a registered member session

Usage:
  apra-fleet call --member <uuid> <tool> --args-file <path>
  apra-fleet call --member <uuid> --list-tools

  --member <uuid>       Registered member id (an unregistered id fails with HTTP 403)
  --args-file <path>    JSON file holding the tool arguments (a JSON object)
  --rm-args-file        Delete the args file once read (used by remote memberCall)
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
  connect?: (memberId: string) => Promise<{
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
  listTools: boolean;
  help: boolean;
}

function parse(argv: string[]): Parsed | { error: string } {
  const out: Parsed = { listTools: false, rmArgsFile: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--list-tools') out.listTools = true;
    else if (a === '--rm-args-file') out.rmArgsFile = true;
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
    if (!parsed.argsFile) return fail(io, 'E-USAGE', '--args-file <path> is required');
  }

  let args: unknown = undefined;
  if (!parsed.listTools) {
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

  const connect = deps.connect ?? (async (id: string) => {
    const m = await import('@apralabs/apra-fleet-client/server-resolution');
    // origin=engine: this verb is the engine acting as the member (remote
    // memberCall), so its kb_/code_ calls are not counted in session_stats.
    return m.connectFleetMember(id, { origin: 'engine' });
  });

  let session;
  try {
    session = await connect(parsed.member);
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    if (err.status === 403) {
      return fail(io, 'E-MEMBER-FORBIDDEN', `server refused member ${parsed.member}: not a registered member (HTTP 403)`, { status: 403 });
    }
    return fail(io, err.code ?? 'E-CONNECT', err.message);
  }

  try {
    if (parsed.listTools) {
      io.out(JSON.stringify(await session.mcpClient.listTools()));
      return 0;
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
