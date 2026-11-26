/**
 * send_files / receive_files failures reach the MCP caller as isError: true with
 * structuredContent {error: 'transfer-failed', reason, detail}; a full success
 * stays a plain text result (no isError, no structuredContent). Asserted at the
 * MCP layer: the handlers registered by registerAllTools (tool-registry wrapTool),
 * with the transfer strategy mocked. HOME/USERPROFILE point at a temp sandbox and
 * the registry is the isolated test registry.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ transferFiles: vi.fn(), receiveFiles: vi.fn() }));

vi.mock('../src/services/strategy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/strategy.js')>()),
  getStrategy: () => ({ transferFiles: h.transferFiles, receiveFiles: h.receiveFiles }),
}));

import { registerAllTools } from '../src/services/tool-registry.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

type Handler = (input: any, extra?: any) => Promise<any>;
const handlers = new Map<string, Handler>();

const savedEnv: Record<string, string | undefined> = {};
let sandbox: string;
let workFolder: string;
let memberId: string;

beforeAll(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-transfer-iserror-'));
  for (const k of ['HOME', 'USERPROFILE']) savedEnv[k] = process.env[k];
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  const fake: any = new Proxy({}, {
    get: (_t, prop) => (prop === 'tool'
      ? (name: string, ...rest: unknown[]) => { handlers.set(name, rest[rest.length - 1] as Handler); }
      : () => undefined),
  });
  await registerAllTools(fake);
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  backupAndResetRegistry();
  workFolder = path.join(sandbox, 'work');
  fs.mkdirSync(workFolder, { recursive: true });
  const agent = makeTestLocalAgent({ workFolder });
  addAgent(agent);
  memberId = agent.id;
  h.transferFiles.mockReset();
  h.receiveFiles.mockReset();
});
afterEach(() => restoreRegistry());

const send = (extra: Record<string, unknown> = {}) =>
  handlers.get('send_files')!({ member_id: memberId, local_paths: [path.join(sandbox, 'a.txt')], ...extra });
const receive = (extra: Record<string, unknown> = {}) =>
  handlers.get('receive_files')!({ member_id: memberId, remote_paths: ['a.txt'], local_dest_dir: path.join(sandbox, 'dl'), ...extra });
const text = (r: any) => (r.content ?? []).map((c: any) => String(c.text ?? '')).join(' ');

function expectTransferFailure(r: any, reason: string) {
  expect(r.isError).toBe(true);
  expect(r.structuredContent.error).toBe('transfer-failed');
  expect(r.structuredContent.reason).toBe(reason);
  expect(typeof r.structuredContent.detail).toBe('string');
  expect(r.structuredContent.detail.length).toBeGreaterThan(0);
}

describe('send_files MCP result', () => {
  it('all files failed -> isError, reason failed, text unchanged', async () => {
    h.transferFiles.mockResolvedValue({ success: [], failed: [{ path: 'a.txt', error: 'EACCES' }] });
    const r = await send();
    expectTransferFailure(r, 'failed');
    expect(text(r)).toContain('[FAIL] Failed to upload 1 file(s)');
    expect(text(r)).toContain('a.txt: EACCES');
  });

  it('some files failed -> isError, reason partial', async () => {
    h.transferFiles.mockResolvedValue({ success: ['b.txt'], failed: [{ path: 'a.txt', error: 'EACCES' }] });
    const r = await send({ local_paths: [path.join(sandbox, 'a.txt'), path.join(sandbox, 'b.txt')] });
    expectTransferFailure(r, 'partial');
    expect(text(r)).toContain('[OK] Successfully uploaded 1 file(s)');
    expect(text(r)).toContain('[FAIL] Failed to upload 1 file(s)');
  });

  it('the transfer throws -> isError, reason failed', async () => {
    h.transferFiles.mockRejectedValue(new Error('boom'));
    const r = await send();
    expectTransferFailure(r, 'failed');
    expect(text(r)).toContain('boom');
  });

  it('dest_subdir outside the work folder -> isError, reason path-blocked, nothing transferred', async () => {
    const r = await send({ dest_subdir: '../outside' });
    expectTransferFailure(r, 'path-blocked');
    expect(text(r)).toContain('outside member work_folder');
    expect(h.transferFiles).not.toHaveBeenCalled();
  });

  it('basename collision -> isError, reason invalid-input', async () => {
    const r = await send({ local_paths: [path.join(sandbox, 'x', 'a.txt'), path.join(sandbox, 'y', 'a.txt')] });
    expectTransferFailure(r, 'invalid-input');
    expect(h.transferFiles).not.toHaveBeenCalled();
  });

  it('unknown member -> isError, reason member-unavailable', async () => {
    const r = await send({ member_id: '00000000-0000-0000-0000-000000000000' });
    expectTransferFailure(r, 'member-unavailable');
  });

  it('full success -> plain text, no isError, no structuredContent', async () => {
    h.transferFiles.mockResolvedValue({ success: ['a.txt'], failed: [] });
    const r = await send();
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toBeUndefined();
    expect(text(r)).toContain('[OK] Successfully uploaded 1 file(s)');
  });
});

describe('receive_files MCP result', () => {
  it('download failed -> isError, reason failed, text unchanged', async () => {
    h.receiveFiles.mockResolvedValue({ success: [], failed: [{ path: 'a.txt', error: 'ENOENT' }] });
    const r = await receive();
    expectTransferFailure(r, 'failed');
    expect(text(r)).toContain('Failed to download 1 file(s)');
  });

  it('some files failed -> isError, reason partial', async () => {
    h.receiveFiles.mockResolvedValue({ success: ['b.txt'], failed: [{ path: 'a.txt', error: 'ENOENT' }] });
    const r = await receive({ remote_paths: ['a.txt', 'b.txt'] });
    expectTransferFailure(r, 'partial');
  });

  it('the download throws -> isError, reason failed', async () => {
    h.receiveFiles.mockRejectedValue(new Error('network down'));
    const r = await receive();
    expectTransferFailure(r, 'failed');
    expect(text(r)).toContain('network down');
  });

  it('remote_path outside the work folder -> isError, reason path-blocked, nothing transferred', async () => {
    const r = await receive({ remote_paths: ['../../etc/passwd'] });
    expectTransferFailure(r, 'path-blocked');
    expect(text(r)).toContain('outside member work_folder');
    expect(h.receiveFiles).not.toHaveBeenCalled();
  });

  it('full success -> plain text, no isError, no structuredContent', async () => {
    h.receiveFiles.mockResolvedValue({ success: ['a.txt'], failed: [] });
    const r = await receive();
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toBeUndefined();
    expect(text(r)).toContain('Successfully downloaded 1 file(s)');
  });
});
