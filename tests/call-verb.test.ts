import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `apra-fleet call` against a REAL local http server (real createHttpTransport +
// registerAllTools) with the isolated test registry holding one registered
// member. The CLI verb runs in-process via runCall with the real client
// (connectFleetMember); only server discovery (server.json probe) is injected.

import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { addAgent } from '../src/services/registry.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { localWorkspaceId } from '../src/services/token-issuer.js';
import { MEMBER_ALLOWED_TOOLS, MEMBER_MAINTAINER_TOOLS } from '../src/services/member-tool-allowlist.js';
import { runCall } from '../src/cli/call.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
// @ts-expect-error plain .mjs workspace package
import { connectFleetMember } from '../packages/apra-fleet-client/src/client/server-resolution.mjs';

let handle: HttpTransportHandle;
let memberId: string;
let tmp: string;

beforeEach(async () => {
  backupAndResetRegistry();
  const agent = makeTestAgent({ friendlyName: 'call-verb-member', workFolder: '/tmp/call-verb-work' });
  addAgent(agent);
  memberId = agent.id;
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'call-verb-'));
});

afterEach(async () => {
  try { await handle.close(); } catch { /* ignore */ }
  fleetEvents.removeAllListeners();
  restoreRegistry();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function argsFile(content: string): string {
  const p = path.join(tmp, 'args.json');
  fs.writeFileSync(p, content);
  return p;
}

async function run(argv: string[], dataDir: string | undefined = process.env.APRA_FLEET_DATA_DIR) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCall(argv, {
    io: { out: t => out.push(t), err: t => err.push(t) },
    connect: (id, opts) => connectFleetMember(id, {
      // The verb's real connect adds origin=engine; mirror it (and the grant).
      origin: 'engine',
      ...(opts?.kbMaintainer ? { kbMaintainer: true } : {}),
      env: { APRA_FLEET_DATA_DIR: dataDir },
      checkRunningInstance: async () => ({ running: true, url: `http://127.0.0.1:${handle.port}/mcp`, pid: process.pid }),
    }),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('apra-fleet call', () => {
  it('releases the server session: no registry entry or open session is left after a call', async () => {
    const r = await run(['--member', memberId, 'version', '--args-file', argsFile('{}')]);
    expect(r.code).toBe(0);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
    const l = await run(['--member', memberId, '--list-tools']);
    expect(l.code).toBe(0);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
  });

  it('a pre-registered channel-capable member session survives a short-lived call', async () => {
    const fakeServer = {} as never;
    sessionRegistry.register({
      member_id: memberId, workspace_id: localWorkspaceId(), role: 'doer', work_folder: '/tmp/call-verb-work',
      server: fakeServer, sessionId: 'live-sid', status: 'online', channelCapable: true,
    });
    const r = await run(['--member', memberId, 'version', '--args-file', argsFile('{}')]);
    expect(r.code).toBe(0);
    const entry = sessionRegistry.get(localWorkspaceId(), memberId);
    expect(entry?.sessionId).toBe('live-sid');
    expect(entry?.channelCapable).toBe(true);
    sessionRegistry.unregister(localWorkspaceId(), memberId);
  });

  it('--rm-args-file deletes the args file after reading it', async () => {
    const f = argsFile('{}');
    const r = await run(['--member', memberId, 'version', '--args-file', f, '--rm-args-file']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('version call succeeds as a MEMBER session', async () => {
    const r = await run(['--member', memberId, 'version', '--args-file', argsFile('{}')]);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/\d+\.\d+/);
  });

  it('the call runs in a MEMBER session: a tool outside the allowlist is refused', async () => {
    const r = await run(['--member', memberId, 'execute_command', '--args-file', argsFile(`{"member_id":"${memberId}","command":"echo hi"}`)]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.err).error.message).toMatch(/not found|unknown tool/i);
  });

  it('an unregistered uuid fails as a typed 403 with non-zero exit', async () => {
    const r = await run(['--member', '00000000-0000-4000-8000-000000000000', 'version', '--args-file', argsFile('{}')]);
    expect(r.code).not.toBe(0);
    const e = JSON.parse(r.err).error;
    expect(e.code).toBe('E-MEMBER-FORBIDDEN');
    expect(e.status).toBe(403);
  });

  it("run from another install's data dir (another user) it fails as a typed 401 with non-zero exit", async () => {
    const otherDataDir = path.join(tmp, 'other-install-data');
    fs.mkdirSync(otherDataDir, { recursive: true });
    fs.writeFileSync(path.join(otherDataDir, 'member-access.key'), 'c'.repeat(64) + '\n');
    const r = await run(['--member', memberId, 'version', '--args-file', argsFile('{}')], otherDataDir);
    expect(r.code).not.toBe(0);
    const e = JSON.parse(r.err).error;
    expect(e.code).toBe('E-MEMBER-SECRET');
    expect(e.status).toBe(401);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
  });

  it('invalid args return the tool schema validation error', async () => {
    const r = await run(['--member', memberId, 'kb_query', '--args-file', argsFile('{"query": 42}')]);
    expect(r.code).not.toBe(0);
    const e = JSON.parse(r.err).error;
    expect(e.code).toBe('E-TOOL');
    expect(e.message).toMatch(/validation|invalid|expected string/i);
  });

  it('--list-tools returns exactly the member allowlist', async () => {
    const r = await run(['--member', memberId, '--list-tools']);
    expect(r.code).toBe(0);
    const names = (JSON.parse(r.out) as { tools: Array<{ name: string }> }).tools.map(t => t.name).sort();
    expect(names).toEqual([...MEMBER_ALLOWED_TOOLS].sort());
  });

  it('--kb-maintainer opens the session with the kb_maintainer grant: the list adds kb_promote and kb_resolve_contradiction', async () => {
    const r = await run(['--member', memberId, '--kb-maintainer', '--list-tools']);
    expect(r.code).toBe(0);
    const names = (JSON.parse(r.out) as { tools: Array<{ name: string }> }).tools.map(t => t.name).sort();
    expect(names).toEqual([...MEMBER_ALLOWED_TOOLS, ...MEMBER_MAINTAINER_TOOLS].sort());
    expect(names).not.toContain('kb_setup');
    expect(names).not.toContain('kb_export');
  });

  it('accepts no inline JSON args: an inline JSON positional or --args flag is a usage error', async () => {
    const a = await run(['--member', memberId, 'version', '{}']);
    expect(a.code).not.toBe(0);
    expect(JSON.parse(a.err).error.code).toBe('E-USAGE');
    const b = await run(['--member', memberId, 'version', '--args', '{}']);
    expect(b.code).not.toBe(0);
    expect(JSON.parse(b.err).error.code).toBe('E-USAGE');
  });

  it('a no-argument tool needs no --args-file (args default to {})', async () => {
    for (const tool of ['version', 'session_stats']) {
      const r = await run(['--member', memberId, tool]);
      expect(r.code, `${tool}: ${r.err}`).toBe(0);
      expect(JSON.parse(r.out).isError).toBeFalsy();
    }
  });

  it('a tool with required arguments still needs --args-file (E-USAGE names them)', async () => {
    const r = await run(['--member', memberId, 'kb_capture']);
    expect(r.code).not.toBe(0);
    const e = JSON.parse(r.err).error;
    expect(e.code).toBe('E-USAGE');
    expect(e.message).toMatch(/--args-file <path> is required \(kb_capture requires: .*title/);
  });

  it('--rm-args-file without --args-file is a usage error', async () => {
    const r = await run(['--member', memberId, 'version', '--rm-args-file']);
    expect(JSON.parse(r.err).error.code).toBe('E-USAGE');
  });

  it('a non-object or unreadable args file is an E-ARGS-FILE error', async () => {
    const a = await run(['--member', memberId, 'version', '--args-file', argsFile('[1]')]);
    expect(JSON.parse(a.err).error.code).toBe('E-ARGS-FILE');
    const b = await run(['--member', memberId, 'version', '--args-file', path.join(tmp, 'missing.json')]);
    expect(JSON.parse(b.err).error.code).toBe('E-ARGS-FILE');
  });
});
