/**
 * apra-fleet-qeq1.5.1 -- proves the {{vcs_username}} / {{vcs_username_inline}}
 * pair added to vcs_credential_exec (apra-fleet-qeq1.1) substitutes the
 * basic-auth username under the correct shell dialect, that the plaintext
 * username never reaches the returned payload, and that the pre-existing
 * token-only call sites (every current GitHub and Azure DevOps command) are
 * untouched by it.
 *
 * Modelled on tests/vcs-credential-exec-inline-token.test.ts and using the
 * same fake-strategy / fake-member scaffolding, so the assertions here are
 * against the command the tool ACTUALLY dispatches and the payload it
 * ACTUALLY returns, never against an internal helper.
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
import { vcsCredentialExec } from '../src/tools/vcs-credential-exec.js';
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
 * Synthetic, obviously-fake credential material. Neither value resembles a
 * real token or a real account: the username uses the reserved .invalid TLD
 * and both carry a SENTINEL marker. The quote in the username is what makes
 * the escaping assertions meaningful.
 */
const FAKE_USERNAME = "sentinel-o'brien@example.invalid";
const FAKE_TOKEN = "SENTINEL-NOT-A-REAL-TOKEN-o'42";

/**
 * POSIX single-quote removal -- what the MEMBER'S shell does to the
 * substituted command before the program ever sees it. Echoing the raw
 * command text back would be an unfaithful simulation: a verbose program
 * (curl -v, a git error quoting the remote URL) prints the value it was
 * HANDED, i.e. the dequoted one, which is exactly the plaintext this tool's
 * redaction pass has to catch. Asserting against the still-escaped text
 * would pass vacuously, since the raw value is not a substring of it.
 */
function posixDequote(s: string): string {
  const SENTINEL = '\u0000';
  return s
    .split("'\\''").join(SENTINEL) // an escaped interior quote becomes a real one
    .split("'").join('')           // ...then the structural quotes are removed
    .split(SENTINEL).join("'");
}

/**
 * Stub the member-side credential helper. Every OS/shell variant's
 * gitCredentialHelperRead command names the deployed helper file with the
 * '.fleet-git-credential' substring, so matching on that substring separates
 * the server-side credential read (never returned to a caller) from the real
 * dispatched command, regardless of dialect.
 *
 * `username` of null omits the username= line entirely -- the shape a
 * provider that records no basic-auth user leaves behind.
 *
 * `echoCommand` makes the dispatched command echo its own text back on
 * stdout and stderr, as the member's POSIX shell handed it over (see
 * posixDequote) -- the realistic `curl -v` / git-error leak this tool
 * defends against. POSIX members only.
 */
function stubCredentialHelper(opts: {
  token?: string;
  username?: string | null;
  echoCommand?: boolean;
} = {}): void {
  const token = opts.token ?? FAKE_TOKEN;
  const username = opts.username === undefined ? FAKE_USERNAME : opts.username;
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('.fleet-git-credential')) {
      const lines = ['protocol=https', 'host=bitbucket.org'];
      if (username !== null) lines.push(`username=${username}`);
      lines.push(`password=${token}`);
      return { stdout: `${lines.join('\n')}\n`, stderr: '', code: 0 };
    }
    if (opts.echoCommand) {
      const seen = posixDequote(cmd);
      return { stdout: `sent: ${seen}`, stderr: `retrying: ${seen}`, code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
}

/** The dispatched (non credential-read) command sent to execCommand. */
function dispatchedCommand(): string {
  const call = mockExecCommand.mock.calls.find(([cmd]) => !(cmd as string).includes('.fleet-git-credential'));
  if (!call) throw new Error('no dispatched command was captured by the mock');
  return call[0] as string;
}

/** True when a credential-requiring command was dispatched at all. */
function anythingDispatched(): boolean {
  return mockExecCommand.mock.calls.some(([cmd]) => !(cmd as string).includes('.fleet-git-credential'));
}

describe('vcs_credential_exec: basic-auth username placeholders (apra-fleet-qeq1.5.1)', () => {
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
  // Property 1 -- inline substitution, per shell dialect. isPosixShell picks
  // the dialect, so a windows member registered with shell=gitbash must get
  // the POSIX form despite its OS.
  // ---------------------------------------------------------------------
  describe('1. inline substitution: both values land inside the caller\'s own single quotes', () => {
    const COMMAND = "curl -u '{{vcs_username_inline}}:{{vcs_token_inline}}' https://api.bitbucket.org/2.0/repositories/w/r/pullrequests";

    it('POSIX member: escapes both for a single-quoted interior, adding no quotes of their own', async () => {
      const member = makeTestAgent({ friendlyName: 'posix-user-inline', os: 'linux' });
      addAgent(member);
      stubCredentialHelper();

      const result = await vcsCredentialExec({ member_id: member.id, command: COMMAND });

      expect(result.structuredContent.reason).toBe('ok');
      expect(dispatchedCommand()).toBe(
        `curl -u '${escapeShellArgInner(FAKE_USERNAME)}:${escapeShellArgInner(FAKE_TOKEN)}' https://api.bitbucket.org/2.0/repositories/w/r/pullrequests`,
      );
    });

    it('PowerShell member: escapes both with the doubled-quote interior form', async () => {
      const member = makeTestAgent({ friendlyName: 'psh-user-inline', os: 'windows' });
      addAgent(member);
      stubCredentialHelper();

      const result = await vcsCredentialExec({ member_id: member.id, command: COMMAND });

      expect(result.structuredContent.reason).toBe('ok');
      expect(dispatchedCommand()).toBe(
        `curl -u '${escapePowerShellArgInner(FAKE_USERNAME)}:${escapePowerShellArgInner(FAKE_TOKEN)}' https://api.bitbucket.org/2.0/repositories/w/r/pullrequests`,
      );
    });

    it('a WINDOWS member registered as gitbash gets the POSIX inline form for the username too', async () => {
      const member = makeTestAgent({ friendlyName: 'gitbash-user-inline', os: 'windows', shell: 'gitbash' });
      addAgent(member);
      stubCredentialHelper();

      const result = await vcsCredentialExec({ member_id: member.id, command: COMMAND });

      expect(result.structuredContent.reason).toBe('ok');
      const dispatched = dispatchedCommand();
      expect(dispatched).toBe(
        `curl -u '${escapeShellArgInner(FAKE_USERNAME)}:${escapeShellArgInner(FAKE_TOKEN)}' https://api.bitbucket.org/2.0/repositories/w/r/pullrequests`,
      );
      // Not the PowerShell doubled form -- proves the username dialect came
      // from isPosixShell(os, shell), not from the raw `os` field.
      expect(dispatched).not.toContain(escapePowerShellArgInner(FAKE_USERNAME));
    });
  });

  // ---------------------------------------------------------------------
  // Property 2 -- bare substitution arrives escaped AND quoted, matching
  // {{vcs_token}}'s behaviour on the same input.
  // ---------------------------------------------------------------------
  describe('2. bare substitution: {{vcs_username}} arrives escaped AND quoted', () => {
    it('produces byte-identically what {{vcs_token}} produces on the same input', async () => {
      const member = makeTestAgent({ friendlyName: 'bare-username', os: 'linux' });
      addAgent(member);
      // The helper hands back the SAME value as username and as password, so
      // any difference in treatment between the two bare placeholders shows
      // up as a mismatch between the two halves of the dispatched command.
      stubCredentialHelper({ token: FAKE_USERNAME, username: FAKE_USERNAME });

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: 'curl --user {{vcs_username}} --pass {{vcs_token}} https://api.bitbucket.org',
      });

      expect(result.structuredContent.reason).toBe('ok');
      const quoted = escapeShellArg(FAKE_USERNAME); // "'sentinel-o'\''brien@example.invalid'"
      expect(dispatchedCommand()).toBe(`curl --user ${quoted} --pass ${quoted} https://api.bitbucket.org`);
    });

    it('and the two halves are scrubbed back out under DISTINCT redaction markers', async () => {
      const member = makeTestAgent({ friendlyName: 'bare-username-markers', os: 'linux' });
      addAgent(member);
      stubCredentialHelper({ echoCommand: true });

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: 'curl --user {{vcs_username}} --pass {{vcs_token}} https://api.bitbucket.org',
      });

      expect(result.structuredContent.reason).toBe('ok');
      // A reader of a redacted stream can tell WHICH half was removed.
      expect(result.structuredContent.stdout).toBe(
        'sent: curl --user [REDACTED:vcs_username] --pass [REDACTED:vcs_token] https://api.bitbucket.org',
      );
    });
  });

  // ---------------------------------------------------------------------
  // Property 3 -- non-exposure, asserted over the WHOLE serialized payload
  // so a future field that accidentally carries either value fails here.
  // ---------------------------------------------------------------------
  it('3. non-exposure: with the command echoed back on stdout AND stderr, neither plaintext value appears anywhere in the result', async () => {
    const member = makeTestAgent({ friendlyName: 'username-no-leak', os: 'linux' });
    addAgent(member);
    stubCredentialHelper({ echoCommand: true });

    const result = await vcsCredentialExec({
      member_id: member.id,
      command: "curl -u '{{vcs_username_inline}}:{{vcs_token_inline}}' -H X-Tok:{{vcs_token}} https://api.bitbucket.org",
    });

    expect(result.structuredContent.reason).toBe('ok');
    const wholePayload = JSON.stringify({ text: result.text, structuredContent: result.structuredContent });
    expect(wholePayload).not.toContain(FAKE_USERNAME);
    expect(wholePayload).not.toContain(FAKE_TOKEN);

    // ...nor into a log line, which is the other orchestrator-readable sink.
    for (const call of consoleErrorSpy.mock.calls) {
      const line = call.map((arg) => String(arg)).join(' ');
      expect(line).not.toContain(FAKE_USERNAME);
      expect(line).not.toContain(FAKE_TOKEN);
    }
    // Sanity: the echo really did happen, so the assertions above are not
    // vacuously true over an empty stdout.
    expect(result.structuredContent.stdout).toContain('sent: ');
    expect(result.structuredContent.stderr).toContain('retrying: ');
  });

  // ---------------------------------------------------------------------
  // Property 4 -- the regression guard for every current GitHub and Azure
  // DevOps call site: a token-only command is untouched by username support.
  // ---------------------------------------------------------------------
  describe('4. a token-only command behaves exactly as it did before username support existed', () => {
    it('dispatches unchanged and needs no username= line from the helper at all', async () => {
      const member = makeTestAgent({ friendlyName: 'token-only-nouser', os: 'linux' });
      addAgent(member);
      stubCredentialHelper({ username: null });

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: "curl {{vcs_token}} -H 'Authorization: Bearer {{vcs_token_inline}}' https://api.github.com",
      });

      // No username lookup is required of it, and the new failure reason is
      // unreachable from here.
      expect(result.structuredContent.reason).toBe('ok');
      expect(dispatchedCommand()).toBe(
        `curl ${escapeShellArg(FAKE_TOKEN)} -H 'Authorization: Bearer ${escapeShellArgInner(FAKE_TOKEN)}' https://api.github.com`,
      );
    });

    it('does not scrub the helper\'s username out of its own output', async () => {
      const member = makeTestAgent({ friendlyName: 'token-only-nosrub', os: 'linux' });
      addAgent(member);
      // 'x-access-token' is the literal GitHub credential helpers deploy as
      // the username; a token-only command must not start redacting it.
      stubCredentialHelper({ username: 'x-access-token', echoCommand: true });

      const result = await vcsCredentialExec({
        member_id: member.id,
        command: 'curl -H X-User:x-access-token {{vcs_token}} https://api.github.com',
      });

      expect(result.structuredContent.reason).toBe('ok');
      expect(result.structuredContent.stdout).toContain('x-access-token');
      expect(result.structuredContent.stdout).not.toContain('[REDACTED:vcs_username]');
      // Exactly the token's own redactions: one in stdout, one in stderr.
      expect(result.structuredContent.tokenRedactions).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // Property 5 -- a username placeholder against a helper with no username=
  // line is a typed refusal, never an empty substitution.
  // ---------------------------------------------------------------------
  it('5. a username placeholder against a helper with no username= line fails with reason=username_empty and dispatches nothing', async () => {
    const member = makeTestAgent({ friendlyName: 'username-missing', os: 'linux' });
    addAgent(member);
    stubCredentialHelper({ username: null });

    const result = await vcsCredentialExec({
      member_id: member.id,
      command: "curl -u '{{vcs_username_inline}}:{{vcs_token_inline}}' https://api.bitbucket.org",
    });

    expect(result.structuredContent.reason).toBe('username_empty');
    expect(result.structuredContent.ok).toBe(false);
    // The whole point: no ':<token>' command reaches the member to surface
    // later as a confusing 401.
    expect(anythingDispatched()).toBe(false);
  });
});
