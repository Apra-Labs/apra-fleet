/**
 * apra-fleet-3swo.7.17 -- proves vcs_credential_exec's inside-caller-quotes
 * token substitution mode (apra-fleet-3swo.7.16) escapes correctly on both
 * shell dialects, that the pre-existing bare {{vcs_token}} mode is
 * unchanged, and that no plaintext credential escapes into any field of the
 * result or into a log line.
 *
 * This is deliberately the ONLY new test file for this streak (see
 * tests/structured-tool-responses.test.ts's "check 5" describe block, which
 * already owns the bare-mode leak-proof suite the impl bead's own commit
 * added) -- the escaping-matrix assertions below sit next to it rather than
 * in a second file, per this bead's acceptance criteria.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import {
  escapeShellArg,
  escapeShellArgInner,
  escapePowerShellArg,
  escapePowerShellArgInner,
} from '../src/utils/shell-escape.js';
import {
  vcsCredentialExec,
  VCS_TOKEN_PLACEHOLDER,
  VCS_TOKEN_INLINE_PLACEHOLDER,
} from '../src/tools/vcs-credential-exec.js';
import type { SSHExecResult } from '../src/types.js';

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

/**
 * Stub the member-side credential helper. Every OS/shell variant's
 * gitCredentialHelperRead command (linux.ts, windows.ts, windows-gitbash.ts)
 * names the deployed helper file with the '.fleet-git-credential' substring,
 * so matching on that substring -- the same approach
 * structured-tool-responses.test.ts's "check 5" suite uses -- distinguishes
 * the server-side credential read (never returned to a caller) from the
 * real dispatched command, regardless of dialect.
 */
function stubCredentialHelper(token: string, dispatchResult: Partial<SSHExecResult> = {}): void {
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('.fleet-git-credential')) {
      return { stdout: `protocol=https\nhost=github.com\nusername=x\npassword=${token}\n`, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0, ...dispatchResult };
  });
}

/** The dispatched (non credential-read) command sent to execCommand. */
function dispatchedCommand(): string {
  const call = mockExecCommand.mock.calls.find(([cmd]) => !(cmd as string).includes('.fleet-git-credential'));
  if (!call) throw new Error('no dispatched command was captured by the mock');
  return call[0] as string;
}

describe('vcs_credential_exec: inline token substitution (apra-fleet-3swo.7.17)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreRegistry();
    consoleErrorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------
  // Criterion 1 -- anti-drift invariant
  // ---------------------------------------------------------------------
  describe('anti-drift invariant: the wrapping helper is defined in terms of its own inner transform', () => {
    const TABLE = [
      'plaintoken',
      "it's",
      "it''s",
      'say "hi"',
      'a b c',
      '',
    ];

    it.each(TABLE)('escapeShellArg(%j) === wrapped escapeShellArgInner', (s) => {
      expect(escapeShellArg(s)).toBe("'" + escapeShellArgInner(s) + "'");
    });

    it.each(TABLE)('escapePowerShellArg(%j) === wrapped escapePowerShellArgInner', (s) => {
      expect(escapePowerShellArg(s)).toBe("'" + escapePowerShellArgInner(s) + "'");
    });
  });

  // ---------------------------------------------------------------------
  // Criteria 2/3/4 -- inline substitution, per shell dialect
  // ---------------------------------------------------------------------
  describe('inline substitution dialect selection', () => {
    it('POSIX member: escapes the inline token for a single-quoted interior, introducing no wrapping quotes of its own', async () => {
      const token = "posix'tok";
      const member = makeTestAgent({ friendlyName: 'posix-inline', os: 'linux' });
      addAgent(member);
      stubCredentialHelper(token);

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: "curl -H 'Authorization: Bearer {{vcs_token_inline}}' https://api.example.com",
      });

      expect(result.structuredContent.reason).toBe('ok');
      const dispatched = dispatchedCommand();
      const expectedInline = escapeShellArgInner(token); // "posix'\''tok"
      expect(dispatched).toBe(`curl -H 'Authorization: Bearer ${expectedInline}' https://api.example.com`);
    });

    it('PowerShell member: escapes the inline token for a single-quoted interior using the doubled-quote form', async () => {
      const token = "psh'tok";
      const member = makeTestAgent({ friendlyName: 'psh-inline', os: 'windows' });
      addAgent(member);
      stubCredentialHelper(token);

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: "curl -H 'Authorization: Bearer {{vcs_token_inline}}' https://api.example.com",
      });

      expect(result.structuredContent.reason).toBe('ok');
      const dispatched = dispatchedCommand();
      const expectedInline = escapePowerShellArgInner(token); // "psh''tok"
      expect(dispatched).toBe(`curl -H 'Authorization: Bearer ${expectedInline}' https://api.example.com`);
    });

    it('a WINDOWS member registered as gitbash gets the POSIX inline form, not the PowerShell one', async () => {
      const token = "gb'tok";
      const member = makeTestAgent({ friendlyName: 'gitbash-inline', os: 'windows', shell: 'gitbash' });
      addAgent(member);
      stubCredentialHelper(token);

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: "curl -H 'Authorization: Bearer {{vcs_token_inline}}' https://api.example.com",
      });

      expect(result.structuredContent.reason).toBe('ok');
      const dispatched = dispatchedCommand();
      const expectedInline = escapeShellArgInner(token); // "gb'\''tok"
      expect(dispatched).toBe(`curl -H 'Authorization: Bearer ${expectedInline}' https://api.example.com`);
      // Not the PowerShell doubled form -- proves the choice came from
      // isPosixShell(os, shell), not from the raw `os` field alone.
      expect(dispatched).not.toContain(escapePowerShellArgInner(token));
    });
  });

  // ---------------------------------------------------------------------
  // Criterion 5 -- bare mode unchanged
  // ---------------------------------------------------------------------
  describe('bare mode ({{vcs_token}}) is unchanged by the new inline mode', () => {
    it('substitutes the fully-quoted form, preserves the result shape and reason on success', async () => {
      const token = "bare'tok FIXTURE";
      const member = makeTestAgent({ friendlyName: 'bare-mode', os: 'linux' });
      addAgent(member);
      stubCredentialHelper(token, { stdout: `echoed ${token}`, stderr: '' });

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: 'curl -H Authorization:Bearer-{{vcs_token}} https://api.example.com',
      });

      expect(result.structuredContent.reason).toBe('ok');
      expect(result.structuredContent.ok).toBe(true);
      expect(result.structuredContent.exitCode).toBe(0);

      const dispatched = dispatchedCommand();
      const expectedBare = escapeShellArg(token); // "'bare'\''tok FIXTURE'"
      expect(dispatched).toBe(`curl -H Authorization:Bearer-${expectedBare} https://api.example.com`);

      // The pre-existing redaction-on-echo behaviour still holds too.
      expect(result.structuredContent.stdout).toContain('[REDACTED:vcs_token]');
      expect(result.structuredContent.stdout).not.toContain(token);
    });
  });

  // ---------------------------------------------------------------------
  // Criterion 6 -- refusal names both placeholders
  // ---------------------------------------------------------------------
  it('refuses a command with neither placeholder, and the message names both accepted placeholders', async () => {
    const member = makeTestAgent({ friendlyName: 'no-placeholder' });
    addAgent(member);
    stubCredentialHelper('unused-token');

    const result = await vcsCredentialExec({ member_id: member.id, command: 'git status' });

    expect(result.structuredContent.reason).toBe('placeholder_missing');
    expect(result.structuredContent.ok).toBe(false);
    expect(result.text).toContain(VCS_TOKEN_PLACEHOLDER);
    expect(result.text).toContain(VCS_TOKEN_INLINE_PLACEHOLDER);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Criterion 7 -- both placeholders in one command
  // ---------------------------------------------------------------------
  it('substitutes both placeholders, each with its own escaping mode, in a single call', async () => {
    const token = "both'tok";
    const member = makeTestAgent({ friendlyName: 'both-placeholders', os: 'linux' });
    addAgent(member);
    stubCredentialHelper(token);

    const result = await vcsCredentialExec({
      member_id: member.id,
      command: "curl {{vcs_token}} -H 'Authorization: Bearer {{vcs_token_inline}}'",
    });

    expect(result.structuredContent.reason).toBe('ok');
    const dispatched = dispatchedCommand();
    const expectedBare = escapeShellArg(token);
    const expectedInline = escapeShellArgInner(token);
    expect(dispatched).toBe(`curl ${expectedBare} -H 'Authorization: Bearer ${expectedInline}'`);
  });

  // ---------------------------------------------------------------------
  // Criterion 8 -- no leak, on the result AND on captured logs
  // ---------------------------------------------------------------------
  describe('no plaintext leak', () => {
    it('the token never appears in structuredContent, text, or a captured log line, for either mode', async () => {
      const token = 'SENTINEL_NOLEAK_TOKEN_4242';
      const member = makeTestAgent({ friendlyName: 'no-leak', os: 'linux' });
      addAgent(member);
      stubCredentialHelper(token, { stdout: `sent ${token}`, stderr: `retry ${token}` });

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: "curl {{vcs_token}} -H 'Authorization: Bearer {{vcs_token_inline}}'",
      });

      expect(result.structuredContent.reason).toBe('ok');
      expect(JSON.stringify(result.structuredContent)).not.toContain(token);
      expect(result.text).not.toContain(token);

      for (const call of consoleErrorSpy.mock.calls) {
        const line = call.map((arg) => String(arg)).join(' ');
        expect(line).not.toContain(token);
      }
      // Sanity: something WAS logged for this call (a vacuous "no logs
      // captured" run would make the loop above meaningless), and it names
      // the placeholder rather than nothing at all.
      const loggedTheCall = consoleErrorSpy.mock.calls.some((c) => String(c[0]).includes('vcs_credential_exec'));
      expect(loggedTheCall).toBe(true);
    });
  });
});
