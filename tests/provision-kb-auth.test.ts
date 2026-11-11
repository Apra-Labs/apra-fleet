/**
 * provision_kb_auth: the kb kind of provision_auth, through the tool. The store,
 * the live secret scripts and the orchestrator's KB config are real (in the test
 * data dir); the member side is a fake transport that records every command and
 * staged file and answers like a member install would.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { credentialDelete, credentialSet, credentialUpdate, prepareLiveSecret, saveLiveSecret } from '../src/services/credential-store.js';
import { resetLiveTokenCache } from '../src/services/live-secret-cache.js';
import { __setProvisionKbDeps, type ProvisionKbDeps } from '../src/services/provision-kb.js';
import { KB_CONFIG_PATH } from '../src/services/knowledge/kb-config.js';
import { provisionKbAuth, provisionKbAuthSchema, ProvisionKbAuthToolError, refreshAtFor } from '../src/tools/provision-kb-auth.js';
import { addAgent, getAgent, updateAgent } from '../src/services/registry.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import { backupAndResetRegistry, makeTestAgent, makeTestLocalAgent, restoreRegistry } from './test-helpers.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const TOKEN = `kbtok-CANARY-${RUN}`;
const STATIC_VALUE = `kbstatic-CANARY-${RUN}`;
const REMOTE = 'https://kb.example.test/';
const STAGED = '/home/u/.apra-fleet-kb-token-x';

let tmp: string;
let names: string[];
let kbConfigBackup: string | null;

/** One recorded member command, with a PowerShell -EncodedCommand decoded. */
interface Sent { host?: string; raw: string; text: string }
let sent: Sent[];
let staged: Array<{ host?: string; content: string }>;
let removedStaged: string[];
/** Per-step answers; a test overrides one to fail it. */
let answers: { version: string; marker: number; push: SSHExecResult; kbSetup: SSHExecResult; kbCheck: SSHExecResult };
let readyHook: (a: Agent) => Agent;

function decode(cmd: string): string {
  const m = /^powershell -EncodedCommand (\S+)$/.exec(cmd);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
}

function answer(text: string): SSHExecResult {
  if (text.includes('--version')) return { code: 0, stdout: `apra-fleet ${answers.version}\n`, stderr: '' };
  if (text.includes('member-install.json')) return { code: answers.marker, stdout: '', stderr: '' };
  if (text.includes("'secret'")) return answers.push;
  if (text.includes("'kb-setup'") && text.includes("'--check'")) return answers.kbCheck;
  if (text.includes("'kb-setup'")) return answers.kbSetup;
  throw new Error(`unexpected member command: ${text}`);
}

const fakeDeps: ProvisionKbDeps = {
  exec: async (agent, command) => {
    const text = decode(command);
    sent.push({ host: agent.host, raw: command, text });
    return answer(text);
  },
  resolveHome: async (agent) => (agent.os === 'windows' && agent.shell !== 'gitbash' ? 'C:\\Users\\u' : '/home/u'),
  stage: async (agent, content) => { staged.push({ host: agent.host, content }); return STAGED; },
  removeStaged: async (_agent, p) => { removedStaged.push(p); },
  ensureReady: async (agent) => readyHook(agent),
};

interface Live { name: string; runs: () => number }

/** A live secret whose script prints TOKEN-<run> with the given expiry per run. */
function live(label: string, opts: { policy?: 'deny'; members?: string; basicOffset?: boolean } = {}): Live {
  const name = `${label}_${RUN}`;
  names.push(name);
  const counter = path.join(tmp, `${label}.runs`);
  const js = path.join(tmp, `${label}.js`);
  fs.writeFileSync(js, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(counter)}, 'x');
    const run = fs.readFileSync(${JSON.stringify(counter)}, 'utf8').length;
    // basicOffset: the same instant written as 05:30 at +0530, as date +%Y-%m-%dT%H:%M:%S%z prints it.
    const expires = ${opts.basicOffset ? "'2099-01-' + String(run).padStart(2, '0') + 'T05:30:00+0530'" : 'new Date(Date.UTC(2099, 0, run)).toISOString()'};
    process.stdout.write(JSON.stringify({ token: ${JSON.stringify(TOKEN)} + '-' + run, expires_at: expires }));
  `);
  saveLiveSecret(prepareLiveSecret(name, { program: process.execPath, args: [js], env: [] }));
  if (opts.policy || opts.members) credentialUpdate(name, { ...(opts.policy ? { network_policy: opts.policy } : {}), ...(opts.members ? { members: opts.members } : {}) });
  return { name, runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0) };
}

function staticSecret(label: string, ttl?: number): string {
  const name = `${label}_${RUN}`;
  names.push(name);
  credentialSet(name, STATIC_VALUE, true, 'allow', '*', ttl);
  return name;
}

const expiryOf = (run: number) => new Date(Date.UTC(2099, 0, run)).toISOString();

function addRemote(over: Partial<Agent> = {}): Agent {
  const a = makeTestAgent({ friendlyName: `kb-remote-${Math.random().toString(36).slice(2, 8)}`, host: 'old.example.test', os: 'linux', ...over });
  addAgent(a);
  return a;
}

async function refused(p: Promise<unknown>): Promise<ProvisionKbAuthToolError> {
  const err = await p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e);
  expect(err).toBeInstanceOf(ProvisionKbAuthToolError);
  // The typed code an error registry records it by.
  expect((err as ProvisionKbAuthToolError).code).toBe('E-PROVISION-AUTH');
  return err as ProvisionKbAuthToolError;
}

function writeKbConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(config));
}

const pushes = () => sent.filter((s) => s.text.includes("'secret'"));
const setups = () => sent.filter((s) => s.text.includes("'kb-setup'"));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-kb-'));
  names = [];
  sent = [];
  staged = [];
  removedStaged = [];
  answers = {
    version: '0.4.5',
    marker: 0,
    push: { code: 0, stdout: 'Secret stored\n', stderr: '' },
    kbSetup: { code: 0, stdout: '{"kbSetup":"written","previous":"missing","verification":"verified"}\n', stderr: '' },
    kbCheck: { code: 0, stdout: '{"check":"missing"}\n', stderr: '' },
  };
  readyHook = (a) => a;
  kbConfigBackup = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf8') : null;
  backupAndResetRegistry();
  resetLiveTokenCache();
  __setProvisionKbDeps(fakeDeps);
});

afterEach(() => {
  __setProvisionKbDeps(null);
  for (const n of names) {
    try { credentialDelete(n); } catch { /* already removed */ }
  }
  if (kbConfigBackup === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, kbConfigBackup);
  restoreRegistry();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('provision_kb_auth, remote member: the token never reaches a command line', () => {
  const shapes: Array<[string, Partial<Agent>]> = [
    ['linux', { os: 'linux' }],
    ['windows powershell', { os: 'windows' }],
    ['windows gitbash', { os: 'windows', shell: 'gitbash' }],
  ];
  for (const [label, shape] of shapes) {
    it(`${label}: the value goes only to the staged file, which the push reads and removes in the same command`, async () => {
      const s = live('argv');
      const m = addRemote(shape);
      const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
      expect(r.structuredContent.ok).toBe(true);
      expect(staged).toEqual([{ host: m.host, content: `${TOKEN}-1` }]);
      for (const c of sent) {
        expect(c.raw).not.toContain(TOKEN);
        expect(c.text).not.toContain(TOKEN);
      }
      expect(pushes()).toHaveLength(1);
      const push = pushes()[0].text;
      if (shape.os === 'windows' && shape.shell !== 'gitbash') {
        expect(pushes()[0].raw).toMatch(/^powershell -EncodedCommand /);
        expect(push).toContain(`Get-Content -Raw -LiteralPath '${STAGED}' | & 'C:\\Users\\u\\.apra-fleet\\bin\\apra-fleet.exe' 'secret' '--set' '${s.name}' '--persist'`);
        expect(push).toMatch(/finally \{ Remove-Item -Force -LiteralPath '[^']+' /);
      } else {
        expect(push).toContain(`'/home/u/.apra-fleet/bin/apra-fleet${shape.os === 'windows' ? '.exe' : ''}' 'secret' '--set' '${s.name}' '--persist'`);
        expect(push).toContain(`f='${STAGED}'; trap 'rm -f "$f"' EXIT;`);
        expect(push).toContain(`< "$f"`);
      }
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  }

  it('a failed SSH exec of the push removes the staged file from the orchestrator side', async () => {
    const s = live('sshfail');
    const m = addRemote();
    const failing: ProvisionKbDeps = { ...fakeDeps, exec: async (a, c) => { if (decode(c).includes("'secret'")) throw new Error(`ssh dropped ${TOKEN}`); return fakeDeps.exec(a, c, 0); } };
    __setProvisionKbDeps(failing);
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('delivery-failed');
    expect(removedStaged).toEqual([STAGED]);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('provision_kb_auth, remote member: expiry', () => {
  it('a live token\'s expiry is passed as --expires-at, and a re-mint passes the new one', async () => {
    const s = live('exp');
    const m = addRemote();
    const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(r.structuredContent.expiresAt).toBe(expiryOf(1));
    expect(pushes()[0].text).toContain(`'--expires-at' '${expiryOf(1)}' '--allow' '--members' '*' '-y'`);
    await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE, reason: 'rejected' });
    expect(pushes()[1].text).toContain(`'--expires-at' '${expiryOf(2)}' '--allow' '--members' '*' '-y'`);
  });

  it('a static secret with no expiry pushes none, so an expiry stored by an earlier push is cleared', async () => {
    const name = staticSecret('noexp');
    const m = addRemote();
    const r = await provisionKbAuth({ member_id: m.id, secret: name, remote: REMOTE });
    expect(r.structuredContent.expiresAt).toBeNull();
    expect(r.structuredContent.refreshAt).toBeNull();
    expect(pushes()[0].text).toContain("'--expires-at' 'none' '--allow' '--members' '*' '-y'");
    expect(staged[0].content).toBe(STATIC_VALUE);
  });

  it('refreshAt is the expiry minus T = min(0.1 x lifetime from now, 600 s) by default, and is in the result', async () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    expect(refreshAtFor('2030-01-01T01:00:00Z', now)).toBe('2030-01-01T00:54:00.000Z');
    expect(refreshAtFor('2030-01-01T10:00:00Z', now)).toBe('2030-01-01T09:50:00.000Z');
    const s = live('refresh');
    const m = addRemote();
    const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    const refreshAt = Date.parse(r.structuredContent.refreshAt as string);
    const expiresAt = Date.parse(r.structuredContent.expiresAt as string);
    expect(refreshAt).toBeLessThan(expiresAt);
    expect(expiresAt - refreshAt).toBeLessThanOrEqual(600_000);
  });
});

describe('provision_kb_auth, remote member: keep_member_kb', () => {
  const checkAnswer = (found: string): SSHExecResult => ({ code: 0, stdout: `{"check":"${found}"}\n`, stderr: '' });
  const checks = () => sent.filter((c) => c.text.includes("'--check'"));

  it.each([
    ['other-remote', 'member-kb-other-remote'],
    ['not-http', 'member-kb-local-store'],
    ['unreadable', 'member-kb-unreadable'],
  ])('a member KB config that is %s is refused as %s, before any mint or push', async (found, reason) => {
    const s = live(`keep_${found.replace('-', '_')}`);
    const m = addRemote();
    answers.kbCheck = checkAnswer(found);
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE, keep_member_kb: true }));
    expect(err.structuredContent.reason).toBe(reason);
    expect(checks()[0].text).toContain(`'kb-setup' '--remote' '${REMOTE}' '--token-ref' '${s.name}' '--check'`);
    expect(s.runs()).toBe(0);
    expect(staged).toHaveLength(0);
    expect(pushes()).toHaveLength(0);
  });

  it.each(['missing', 'match', 'other-token'])('a member KB config that is %s is provisioned', async (found) => {
    const s = live(`keepok_${found.replace('-', '_')}`);
    const m = addRemote();
    answers.kbCheck = checkAnswer(found);
    const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE, keep_member_kb: true });
    expect(r.structuredContent.ok).toBe(true);
    expect(pushes()).toHaveLength(1);
  });

  it('an install without --check is refused as too old; without keep_member_kb nothing is checked', async () => {
    const s = live('keepold');
    const m = addRemote();
    answers.kbCheck = { code: 1, stdout: '{"error":"usage"}\n', stderr: 'Usage: apra-fleet kb-setup ...' };
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE, keep_member_kb: true }));
    expect(err.structuredContent.reason).toBe('install-too-old');
    sent = [];
    await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(checks()).toHaveLength(0);
  });
});

describe('provision_kb_auth, remote member: the install', () => {
  it('an older install is refused with the update_member remedy, before any mint or push', async () => {
    const s = live('old');
    const m = addRemote();
    answers.version = '0.4.4';
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('install-too-old');
    expect(err.message).toContain('update_member {member_id, fleet_install: "auto"}');
    expect(s.runs()).toBe(0);
    expect(staged).toHaveLength(0);
    expect(pushes()).toHaveLength(0);
  });

  it('a full install (no member-install marker) is refused, before any mint or push', async () => {
    const s = live('full');
    const m = addRemote();
    answers.marker = 1;
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('not-member-install');
    expect(err.message).toContain('fleet_install: "replace-full"');
    expect(s.runs()).toBe(0);
    expect(staged).toHaveLength(0);
  });

  it('a build with the right version but without --expires-at is reported as too old, not as a delivery failure', async () => {
    const s = live('prestep');
    const m = addRemote();
    answers.push = { code: 1, stdout: '', stderr: 'Error: Unknown option "--expires-at". Run \'apra-fleet secret --help\' for usage.\n' };
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('install-too-old');
    expect(setups()).toHaveLength(0);
  });
});

describe('provision_kb_auth, remote member: kb-setup and verification', () => {
  it('kb-setup gets the remote and the secret name, quoted for the member shell', async () => {
    const s = live('setup');
    const odd = "https://kb.example.test/a'b;$(x)";
    await provisionKbAuth({ member_id: addRemote({ os: 'windows' }).id, secret: s.name, remote: odd });
    expect(setups()[0].text).toContain(`& 'C:\\Users\\u\\.apra-fleet\\bin\\apra-fleet.exe' 'kb-setup' '--remote' 'https://kb.example.test/a''b;$(x)' '--token-ref' '${s.name}'`);
    await provisionKbAuth({ member_id: addRemote({ os: 'linux' }).id, secret: s.name, remote: odd });
    expect(setups()[1].text).toContain(`'/home/u/.apra-fleet/bin/apra-fleet' 'kb-setup' '--remote' 'https://kb.example.test/a'\\''b;$(x)' '--token-ref' '${s.name}'`);
  });

  it('a kb-setup failure after the push fails the call and says the pushed secret stays on the member', async () => {
    const s = live('setupfail');
    const m = addRemote();
    answers.kbSetup = { code: 1, stdout: '{"error":"refused"}\n', stderr: 'Error: kb_setup: token refers to secret ... deny' };
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('kb-setup-failed');
    expect(err.message).toContain('stored on the member and stays there');
    expect(err.message).not.toContain('deny');
    expect(pushes()).toHaveLength(1);
  });

  it('the member\'s KB call result is the verification: rejected is reported, not thrown', async () => {
    const s = live('verify');
    const m = addRemote();
    answers.kbSetup = { code: 0, stdout: '{"kbSetup":"unchanged","verification":"rejected"}\n', stderr: '' };
    const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(r.structuredContent.ok).toBe(false);
    expect(r.structuredContent.verification).toEqual({ status: 'failed', reason: 'rejected', detail: 'the receiving server refused the value' });
    expect(r.text).toMatch(/^\[WARN\]/);
  });
});

describe('provision_kb_auth: policy is applied on the orchestrator before anything reaches a member', () => {
  it('deny is refused with no mint, no probe and no push', async () => {
    const s = live('deny', { policy: 'deny' });
    const m = addRemote();
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('policy-deny');
    expect(s.runs()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(staged).toHaveLength(0);
  });

  it('a member the secret is not shared with is refused with no mint, no probe and no push', async () => {
    const s = live('notshared', { members: 'someone-else' });
    const m = addRemote();
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('member-not-allowed');
    expect(s.runs()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('provision_kb_auth: a cloud member started by prepare', () => {
  it('every member command after the start goes to the new host', async () => {
    const s = live('cloud');
    const m = addRemote({ host: 'old.example.test' });
    readyHook = (a) => { updateAgent(a.id, { host: 'new.example.test' }); return getAgent(a.id)!; };
    const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(r.structuredContent.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((c) => c.host)).toEqual(sent.map(() => 'new.example.test'));
    expect(staged.map((x) => x.host)).toEqual(['new.example.test']);
  });

  it('a member that cannot be started is refused before any mint', async () => {
    const s = live('cloudfail');
    const m = addRemote();
    readyHook = () => { throw new Error('EC2 instance is terminated'); };
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('member-unreachable');
    expect(s.runs()).toBe(0);
  });
});

describe('provision_kb_auth: reason rejected', () => {
  it('drops the cached token and pushes a newly minted one; without it the cached one is pushed again', async () => {
    const s = live('rej');
    const m = addRemote();
    await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(staged.map((x) => x.content)).toEqual([`${TOKEN}-1`, `${TOKEN}-1`]);
    await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE, reason: 'rejected' });
    expect(staged.map((x) => x.content)).toEqual([`${TOKEN}-1`, `${TOKEN}-1`, `${TOKEN}-2`]);
    expect(s.runs()).toBe(2);
  });

  it('the tool schema accepts rejected and nothing else', () => {
    expect(provisionKbAuthSchema.safeParse({ secret: 'a', remote: REMOTE, reason: 'rejected' }).success).toBe(true);
    expect(provisionKbAuthSchema.safeParse({ secret: 'a', remote: REMOTE, reason: 'expired' }).success).toBe(false);
  });
});

describe('provision_kb_auth, local member: the shared KB config is checked, never changed', () => {
  function addLocal(): Agent {
    const a = makeTestLocalAgent({ friendlyName: `kb-local-${RUN}`, workFolder: tmp });
    addAgent(a);
    return a;
  }

  it('a config naming this remote and secret: verified, nothing pushed, config bytes unchanged', async () => {
    const s = live('localok');
    const m = addLocal();
    writeKbConfig({ provider: 'http', url: 'https://kb.example.test', token_ref: `{{secret.${s.name}}}` });
    const before = fs.readFileSync(KB_CONFIG_PATH, 'utf8');
    const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(r.structuredContent).toMatchObject({ ok: true, kind: 'kb', secret: s.name, expiresAt: expiryOf(1), member: { id: m.id, name: m.friendlyName } });
    expect(sent).toHaveLength(0);
    expect(staged).toHaveLength(0);
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf8')).toBe(before);
  });

  it('no KB config: refused with the kb_setup remedy, before any mint', async () => {
    const s = live('localnone');
    const m = addLocal();
    fs.rmSync(KB_CONFIG_PATH, { force: true });
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('kb-not-configured');
    expect(err.message).toContain('run kb_setup on the orchestrator');
    expect(s.runs()).toBe(0);
    expect(fs.existsSync(KB_CONFIG_PATH)).toBe(false);
  });

  it('a config naming a different remote: refused, before any mint, and the config is left as it was', async () => {
    const s = live('localother');
    const m = addLocal();
    writeKbConfig({ provider: 'http', url: 'https://other.example.test', token_ref: `{{secret.${s.name}}}` });
    const before = fs.readFileSync(KB_CONFIG_PATH, 'utf8');
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('kb-other-remote');
    expect(s.runs()).toBe(0);
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf8')).toBe(before);
  });

  it('the right remote with another secret is refused too', async () => {
    const s = live('localtok');
    const m = addLocal();
    writeKbConfig({ provider: 'http', url: REMOTE, token_ref: '{{secret.SOMETHING_ELSE}}' });
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('kb-not-configured');
  });
});

describe('provision_kb_auth: review fixes', () => {
  it('a helper expiry in basic offset form (+0530) is pushed as the same instant in UTC, which the member accepts', async () => {
    const s = live('offset', { basicOffset: true });
    const m = addRemote();
    await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(pushes()[0].text).toContain(`'--expires-at' '${expiryOf(1)}' '--allow'`);
  });

  it('a relay member is refused before any mint, with a fixed reason', async () => {
    const s = live('relay');
    const m = addRemote({ agentType: 'relay' });
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('relay-unsupported');
    expect(s.runs()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a staged-file write that fails has a reason naming SFTP, a lost connection and disk or permission errors', async () => {
    const s = live('nosftp');
    const m = addRemote();
    __setProvisionKbDeps({ ...fakeDeps, stage: async () => { throw new Error('sftp subsystem request failed'); } });
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('secret-file-unavailable');
    expect(err.message).toContain('SFTP unavailable, connection lost, or a disk or permission error');
    expect(err.message).not.toContain('subsystem request failed');
  });

  it('a push that exits non-zero also removes the staged file from the orchestrator side', async () => {
    const s = live('pushfail');
    const m = addRemote();
    answers.push = { code: 1, stdout: '', stderr: 'boom' };
    await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(removedStaged).toEqual([STAGED]);
  });

  it('a member that knows --expires-at but not kb-setup is reported as too old', async () => {
    const s = live('nokbsetup');
    const m = addRemote();
    answers.kbSetup = { code: 1, stdout: "Error: unknown option 'kb-setup'\n", stderr: '' };
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent.reason).toBe('install-too-old');
  });

  it('a kb-setup failure carries the expiry of the copy left on the member', async () => {
    const s = live('setupexp');
    const m = addRemote();
    answers.kbSetup = { code: 1, stdout: '{"error":"refused"}\n', stderr: '' };
    const err = await refused(provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE }));
    expect(err.structuredContent).toMatchObject({ reason: 'kb-setup-failed', expiresAt: expiryOf(1) });
  });

  it('a config kb-setup replaced is named in the result, also when verification failed', async () => {
    const s = live('replaced');
    const m = addRemote();
    answers.kbSetup = { code: 0, stdout: '{"kbSetup":"written","previous":"other-remote","verification":"rejected"}\n', stderr: '' };
    const r = await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE });
    expect(r.structuredContent.memberChange).toEqual({ reason: 'kb-config-replaced-remote', detail: expect.stringContaining('named another remote') });
    expect(r.text).toContain('named another remote');
    answers.kbSetup = { code: 0, stdout: '{"kbSetup":"unchanged","verification":"verified"}\n', stderr: '' };
    expect((await provisionKbAuth({ member_id: m.id, secret: s.name, remote: REMOTE })).structuredContent.memberChange).toBeNull();
  });
});
