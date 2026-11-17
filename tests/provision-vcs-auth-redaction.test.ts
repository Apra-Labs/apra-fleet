/**
 * provision_vcs_auth must never return or log a token form on a failure path:
 * deploy throws, deploy returns success:false, or verification fails. The
 * distinctive token is embedded in every form a credential-helper error can
 * echo it (raw, URL-encoded, base64 user:token, single/double-quote escaped,
 * PowerShell "At line:1" echo, Authorization header).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { githubProvider } from '../src/services/vcs/github.js';
import { bitbucketProvider } from '../src/services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../src/services/vcs/azure-devops.js';
import { redactKnownSecrets } from '../src/utils/redact-known-secrets.js';
import { LinuxCommands } from '../src/os/linux.js';
import { MacOSCommands } from '../src/os/macos.js';
import { WindowsCommands } from '../src/os/windows.js';
import { WindowsGitBashCommands } from '../src/os/windows-gitbash.js';
import type { SSHExecResult } from '../src/types.js';

const logged: string[] = [];
vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: (_t: string, m: string) => { logged.push(String(m)); },
  logWarn: (_t: string, m: string) => { logged.push(String(m)); },
  logError: (_t: string, m: string) => { logged.push(String(m)); },
}));

vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: async () => ({ fallback: '[FAIL] OOB cancelled in test.' }),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const TOKEN = 'Zq9+tok/en=Xy"7\'k_distinct';
const USER = 'x-bitbucket-api-token-auth';

function forms(): string[] {
  return [
    TOKEN,
    encodeURIComponent(TOKEN),
    Buffer.from(`${USER}:${TOKEN}`).toString('base64'),
    TOKEN.replace(/'/g, "'\\''"),
    TOKEN.replace(/"/g, '\\"'),
    TOKEN.replace(/["$`]/g, '`$&'),
  ];
}

/** An error message echoing the token the way a failed helper write does. */
function leakyMessage(): string {
  return [
    `fatal: could not write helper with password=${TOKEN}`,
    `url: https://${USER}:${encodeURIComponent(TOKEN)}@bitbucket.org/x`,
    `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}`,
    `sq: '${TOKEN.replace(/'/g, "'\\''")}'  dq: "${TOKEN.replace(/"/g, '\\"')}"`,
    'At line:1 char:1',
    `+ Set-Content "password=${TOKEN.replace(/["$`]/g, '`$&')}"`,
    '+ ~~~~~~~~~~~',
  ].join('\n');
}

function expectNoForms(s: string | null | undefined): void {
  const t = s ?? '';
  for (const f of forms()) expect(t).not.toContain(f);
}

const CASES = [
  { name: 'github PAT', provider: githubProvider, input: { provider: 'github' as const, github_mode: 'pat' as const, token: TOKEN } },
  { name: 'bitbucket api_token', provider: bitbucketProvider, input: { provider: 'bitbucket' as const, api_token: TOKEN, workspace: 'ws' } },
  { name: 'azure-devops pat', provider: azureDevOpsProvider, input: { provider: 'azure-devops' as const, pat: TOKEN, org_url: 'https://dev.azure.com/myorg' } },
];

describe('provision_vcs_auth redaction of known credential values', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.restoreAllMocks();
    logged.length = 0;
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });
  afterEach(() => restoreRegistry());

  function member() {
    const m = makeTestAgent({ friendlyName: `red-${Math.random().toString(36).slice(2, 8)}` });
    addAgent(m);
    return m;
  }

  for (const c of CASES) {
    describe(c.name, () => {
      it('deploy throws with the token in every form -> nothing leaks, **** appears', async () => {
        vi.spyOn(c.provider, 'deploy').mockRejectedValue(new Error(leakyMessage()));
        const m = member();
        const r = await provisionVcsAuth({ member_id: m.id, ...c.input });
        expect(r.structuredContent.reason).toBe('deploy_threw');
        expectNoForms(r.text);
        expectNoForms(r.structuredContent.message);
        expectNoForms(logged.join('\n'));
        expect(r.text).toContain('****');
        expect(r.structuredContent.message).toContain('****');
      });

      it('deploy returns success:false with the token in its message -> redacted', async () => {
        vi.spyOn(c.provider, 'deploy').mockResolvedValue({ success: false, message: leakyMessage() });
        const m = member();
        const r = await provisionVcsAuth({ member_id: m.id, ...c.input });
        expect(r.structuredContent.reason).toBe('deploy_failed');
        expectNoForms(r.text);
        expectNoForms(r.structuredContent.message);
        expectNoForms(logged.join('\n'));
        expect(r.structuredContent.message).toContain('****');
      });

      it('verification failure with Authorization: Bearer TOKEN -> header value redacted', async () => {
        vi.spyOn(c.provider, 'deploy').mockResolvedValue({ success: true, message: 'deployed' });
        vi.spyOn(c.provider, 'testConnectivity').mockResolvedValue({
          success: false,
          message: `REST failed: Authorization: Bearer ${TOKEN} rejected (token ${TOKEN})`,
        });
        const m = member();
        const r = await provisionVcsAuth({ member_id: m.id, ...c.input });
        expect(r.structuredContent.reason).toBe('deployed_unverified');
        expectNoForms(r.text);
        expect(r.text).toContain('Authorization: Bearer ****');
        expectNoForms(logged.join('\n'));
      });
    });
  }

  it('redactKnownSecrets masks an Authorization header whose value is not a known secret', () => {
    expect(redactKnownSecrets('curl -H "Authorization: Bearer abcdef123456"', [])).toContain('Bearer ****');
    expect(redactKnownSecrets('Authorization: Basic dXNlcjpwYXNz', [])).toContain('Basic ****');
  });

  // The redactor must mask the token in the exact escaped form each OS command
  // builder writes it in, so an echo of that command (a failed helper write,
  // a PowerShell "At line:1" echo) never leaks it. The token carries every
  // character those escapers rewrite; the alnum segments between them are
  // what must not survive.
  describe('escaped forms the real command builders emit', () => {
    const SPECIAL = 'Ab12\'Cd34"Ef56$Gh78\\Ij90!Kl12&Mn34|Op56^Qr78%St90`Uv12<Wx34>Yz56';
    const SEGMENTS = ['Cd34', 'Ef56', 'Gh78', 'Ij90', 'Kl12', 'Mn34', 'Op56', 'Qr78', 'St90', 'Uv12', 'Wx34', 'Yz56'];
    const builders = [
      { os: 'linux', cmds: new LinuxCommands() },
      { os: 'macos', cmds: new MacOSCommands() },
      { os: 'windows (powershell)', cmds: new WindowsCommands() },
      { os: 'windows (git bash)', cmds: new WindowsGitBashCommands() },
    ];
    for (const b of builders) {
      it(`${b.os}: gitCredentialHelperWrite and ghAuthLogin echo -> no token segment survives`, () => {
        const sent = [
          b.cmds.gitCredentialHelperWrite('bitbucket.org', USER, SPECIAL, 'bitbucket'),
          b.cmds.ghAuthLogin(SPECIAL, 'github.com'),
          b.cmds.httpGetStatusWithBearer('https://api.bitbucket.org/2.0/repositories/ws/r', SPECIAL),
        ];
        for (const cmd of sent) {
          const out = redactKnownSecrets(`fatal: command failed:\n${cmd}`, [SPECIAL], [USER]);
          for (const seg of SEGMENTS) expect(out, `segment ${seg} leaked from: ${out}`).not.toContain(seg);
        }
      });
    }
  });

  it('redactKnownSecrets leaves unrelated text intact and ignores very short secrets', () => {
    expect(redactKnownSecrets('nothing to see', [TOKEN, 'ab'])).toBe('nothing to see');
  });
});
