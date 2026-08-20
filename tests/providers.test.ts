import { describe, it, expect, vi } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude.js';
import { CodexProvider } from '../src/providers/codex.js';
import { CopilotProvider } from '../src/providers/copilot.js';
import { AgyProvider } from '../src/providers/agy.js';
import { getProvider } from '../src/providers/index.js';
import { buildResumeFlag, buildSessionIdFlag, isMaxTurnsResponse } from '../src/providers/provider.js';
import { isMaxTurnsSignal } from '../src/providers/claude.js';
import type { SSHExecResult } from '../src/types.js';

// --- Helpers -----------------------------------------------------------------

function makeResult(stdout: string, code = 0): SSHExecResult {
  return { stdout, stderr: '', code };
}

const BASE_OPTS = {
  folder: '/home/user/project',
  b64Prompt: 'aGVsbG8=',  // base64 of "hello"
};

// --- ClaudeProvider -----------------------------------------------------------

describe('ClaudeProvider', () => {
  const p = new ClaudeProvider();

  it('has correct metadata', () => {
    expect(p.name).toBe('claude');
    expect(p.processName).toBe('claude');
    expect(p.authEnvVar).toBe('ANTHROPIC_API_KEY');
    expect(p.credentialPath).toBe('~/.claude/.credentials.json');
    expect(p.instructionFileName).toBe('CLAUDE.md');
  });

  it('builds cliCommand', () => {
    expect(p.cliCommand('--version')).toBe('claude --version');
  });

  it('builds versionCommand', () => {
    expect(p.versionCommand()).toBe('claude --version 2>&1');
  });

  it('builds installCommand for linux', () => {
    expect(p.installCommand('linux')).toContain('claude.ai/install.sh');
  });

  it('builds installCommand for macos', () => {
    expect(p.installCommand('macos')).toContain('claude.ai/install.sh');
  });

  it('builds installCommand for windows', () => {
    expect(p.installCommand('windows')).toContain('install.ps1');
  });

  it('builds updateCommand', () => {
    expect(p.updateCommand()).toBe('claude update');
  });

  it('builds prompt command with defaults', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS });
    expect(cmd).toContain('claude -p');
    expect(cmd).toContain('--output-format json');
    expect(cmd).toContain('--max-turns 50');
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    // apra-fleet-eft.65.1: the default (no explicit unattended mode) headless
    // dispatch grants Edit/Write parity for the work folder via acceptEdits.
    expect(cmd).toContain('--permission-mode acceptEdits');
  });

  it('builds prompt command with unattended=false grants work-folder edit parity, not the broad bypass', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: false });
    expect(cmd).toContain('--permission-mode acceptEdits');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('workspaceEditPermissionFlag returns the surgical acceptEdits flag', () => {
    expect(p.workspaceEditPermissionFlag()).toBe('--permission-mode acceptEdits');
  });

  it('builds prompt command with new session using --session-id', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, sessionId: 'sess-abc', resuming: false });
    expect(cmd).toContain('--session-id "sess-abc"');
    expect(cmd).not.toContain('-c');
    expect(cmd).not.toContain('--resume');
  });

  it('builds prompt command with resume using --resume', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, sessionId: 'sess-abc', resuming: true });
    expect(cmd).toContain('--resume "sess-abc"');
    expect(cmd).not.toContain('-c');
    expect(cmd).not.toContain('--session-id');
  });

  it('builds prompt command without sessionId emits no session flags', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS });
    expect(cmd).not.toMatch(/\s-c(\s|$)/);
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--session-id');
  });

  it('builds prompt command with unattended=dangerous', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'dangerous' });
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('builds prompt command with unattended=auto', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'auto' });
    expect(cmd).toContain('--permission-mode auto');
  });

  it('builds prompt command with model', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, model: 'claude-opus-4-6' });
    expect(cmd).toContain('--model "claude-opus-4-6"');
  });

  it('builds prompt command with custom maxTurns', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, maxTurns: 10 });
    expect(cmd).toContain('--max-turns 10');
  });

  it('parses successful JSON response', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ result: 'done', session_id: 'sid-1' })));
    expect(resp.result).toBe('done');
    expect(resp.sessionId).toBe('sid-1');
    expect(resp.isError).toBe(false);
  });

  it('parses response with non-zero exit code as error', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ result: 'fail' }), 1));
    expect(resp.isError).toBe(true);
  });

  it('handles non-JSON stdout gracefully', () => {
    const resp = p.parseResponse(makeResult('some raw output'));
    expect(resp.result).toBe('some raw output');
    expect(resp.sessionId).toBeUndefined();
  });

  it('extracts usage tokens when present in JSON response', () => {
    const payload = JSON.stringify({ result: 'done', session_id: 'sid-1', usage: { input_tokens: 123, output_tokens: 456 } });
    const resp = p.parseResponse(makeResult(payload));
    expect(resp.usage).toEqual({ input_tokens: 123, output_tokens: 456 });
  });

  it('returns undefined usage when usage field is absent', () => {
    const payload = JSON.stringify({ result: 'done', session_id: 'sid-1' });
    const resp = p.parseResponse(makeResult(payload));
    expect(resp.usage).toBeUndefined();
  });

  it('returns undefined usage when JSON parse fails', () => {
    const resp = p.parseResponse(makeResult('not json at all'));
    expect(resp.usage).toBeUndefined();
  });

  // apra-fleet-p4f.1: ParsedResponse must carry subtype/terminalReason from
  // a max_turns-exhausted result event, so callers can classify it distinctly
  // instead of misreporting it as an auth/unknown failure.
  it('extracts subtype and terminalReason from a max_turns result event', () => {
    const payload = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      terminal_reason: 'max_turns',
      result: 'stopped after max turns',
      session_id: 'sid-mt',
    });
    const resp = p.parseResponse(makeResult(payload));
    expect(resp.subtype).toBe('error_max_turns');
    expect(resp.terminalReason).toBe('max_turns');
  });

  it('leaves subtype and terminalReason undefined for a normal success response', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ result: 'done', session_id: 'sid-1' })));
    expect(resp.subtype).toBeUndefined();
    expect(resp.terminalReason).toBeUndefined();
  });

  // apra-fleet-iuc.1 / apra-fleet-ekm: the CLI signals max_turns inconsistently.
  // A result event carrying ONLY `subtype: error_max_turns` (no terminal_reason)
  // must still normalize to terminalReason 'max_turns', or the session is missed
  // and run to a hard timeout + cold restart.
  it('normalizes terminalReason to max_turns when only subtype=error_max_turns is present (no terminal_reason)', () => {
    const payload = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      result: 'stopped after max turns',
      session_id: 'sid-mt-sub',
    });
    const resp = p.parseResponse(makeResult(payload, 1));
    expect(resp.subtype).toBe('error_max_turns');
    expect(resp.terminalReason).toBe('max_turns');
    expect(isMaxTurnsResponse(resp)).toBe(true);
  });

  // A standalone `type: max_turns_reached` transcript event that PRECEDES the
  // terminating result event (which itself has neither subtype nor terminal_reason)
  // must still be caught -- this is the exact ekm forensic miss.
  it('catches a standalone max_turns_reached JSONL event that precedes a bare result event', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-mt-evt' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } }),
      JSON.stringify({ type: 'max_turns_reached' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'partial', session_id: 'sid-mt-evt' }),
    ].join('\n');
    const resp = p.parseResponse(makeResult(stream, 1));
    expect(resp.terminalReason).toBe('max_turns');
    expect(isMaxTurnsResponse(resp)).toBe(true);
  });

  // JSON-array transcript form with subtype-only signal normalizes too.
  it('normalizes terminalReason to max_turns for a JSON-array transcript with subtype-only signal', () => {
    const events = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
      { type: 'result', subtype: 'error_max_turns', result: 'stopped', session_id: 'sid-mt-arr' },
    ];
    const resp = p.parseResponse(makeResult(JSON.stringify(events), 1));
    expect(resp.terminalReason).toBe('max_turns');
    expect(isMaxTurnsResponse(resp)).toBe(true);
  });

  // A standalone max_turns_reached event with NO terminating result event at all
  // (transcript truncated by a hard-timeout kill) must not lose the signal.
  it('preserves max_turns in the plain-text fallback when no result event terminates the stream', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-mt-trunc' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still going' }] } }),
      JSON.stringify({ type: 'max_turns_reached' }),
    ].join('\n');
    const resp = p.parseResponse(makeResult(stream, 143));
    expect(resp.terminalReason).toBe('max_turns');
    expect(isMaxTurnsResponse(resp)).toBe(true);
  });

  it('isMaxTurnsSignal recognizes each turn-limit channel and rejects unrelated events', () => {
    expect(isMaxTurnsSignal({ terminal_reason: 'max_turns' })).toBe(true);
    expect(isMaxTurnsSignal({ subtype: 'error_max_turns' })).toBe(true);
    expect(isMaxTurnsSignal({ type: 'max_turns_reached' })).toBe(true);
    expect(isMaxTurnsSignal({ stop_reason: 'max_turns' })).toBe(true);
    expect(isMaxTurnsSignal({ type: 'result', subtype: 'success' })).toBe(false);
    expect(isMaxTurnsSignal(null)).toBe(false);
    expect(isMaxTurnsSignal(undefined)).toBe(false);
  });

  it('isMaxTurnsResponse keys off either normalized terminalReason or raw subtype', () => {
    expect(isMaxTurnsResponse({ result: '', isError: true, raw: '', terminalReason: 'max_turns' })).toBe(true);
    expect(isMaxTurnsResponse({ result: '', isError: true, raw: '', subtype: 'error_max_turns' })).toBe(true);
    expect(isMaxTurnsResponse({ result: 'ok', isError: false, raw: '', subtype: 'success' })).toBe(false);
    expect(isMaxTurnsResponse(undefined)).toBe(false);
  });

  // apra-fleet-eft.28.6: server-side output-extraction loss. The final
  // `type:result` event can come back with session_id present but an EMPTY
  // result field, even though the assistant reply (incl. tool output) is fully
  // present in the preceding `type:assistant` events. The reply text must be
  // recovered from the stream, not dropped and mislabelled empty_response.
  it('recovers assistant text from a JSONL stream when the result event text is blank (session_id still parses)', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-recover' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is the full ' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'bash' }, { type: 'text', text: 'answer.' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '', session_id: 'sid-recover', usage: { input_tokens: 5, output_tokens: 7 } }),
    ].join('\n');
    const resp = p.parseResponse(makeResult(stream));
    expect(resp.result).toBe('Here is the full answer.');
    expect(resp.sessionId).toBe('sid-recover');
    expect(resp.isError).toBe(false);
    expect(resp.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });

  it('recovers assistant text from a JSON-array stream when the result event text is blank', () => {
    const events = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'array reply' }] } },
      { type: 'result', subtype: 'success', result: '', session_id: 'sid-arr' },
    ];
    const resp = p.parseResponse(makeResult(JSON.stringify(events)));
    expect(resp.result).toBe('array reply');
    expect(resp.sessionId).toBe('sid-arr');
  });

  it('prefers the result event text over harvested assistant text when it is non-empty (happy path unchanged)', () => {
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'intermediate thinking' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer', session_id: 'sid-happy' }),
    ].join('\n');
    const resp = p.parseResponse(makeResult(stream));
    expect(resp.result).toBe('final answer');
    expect(resp.sessionId).toBe('sid-happy');
  });

  it('yields a genuinely empty result (no assistant text, blank result event) so the caller surfaces empty_response, not a silent success', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-empty' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '', session_id: 'sid-empty' }),
    ].join('\n');
    const resp = p.parseResponse(makeResult(stream));
    expect(resp.result).toBe('');
    expect(resp.sessionId).toBe('sid-empty');
  });

  it('supports resume and maxTurns', () => {
    expect(p.supportsResume()).toBe(true);
    expect(p.supportsMaxTurns()).toBe(true);
  });

  it('resumeFlag with resuming=true returns --resume', () => {
    expect(p.resumeFlag('ses-1', true)).toBe('--resume "ses-1"');
  });

  it('resumeFlag with resuming=false returns --session-id', () => {
    expect(p.resumeFlag('ses-1', false)).toBe('--session-id "ses-1"');
  });

  it('resumeFlag without sessionId returns empty string', () => {
    expect(p.resumeFlag()).toBe('');
  });

  it('maps model tiers', () => {
    expect(p.modelForTier('cheap')).toBe('haiku');
    expect(p.modelForTier('standard')).toBe('sonnet');
    expect(p.modelForTier('premium')).toBe('opus');
  });

  it('modelTiers() returns cheap/standard/premium mapping', () => {
    const tiers = p.modelTiers();
    expect(tiers.cheap).toBe('haiku');
    expect(tiers.standard).toBe('sonnet');
    expect(tiers.premium).toBe('opus');
  });

  it('modelFlag wraps model in --model flag', () => {
    expect(p.modelFlag('claude-haiku-4-5')).toBe('--model "claude-haiku-4-5"');
  });

  it('classifies auth errors', () => {
    expect(p.classifyError('Not logged in')).toBe('auth');
  });

  it('classifies server errors', () => {
    expect(p.classifyError('HTTP 500 Internal Server Error')).toBe('server');
  });

  it('classifies overloaded errors', () => {
    expect(p.classifyError('HTTP 429 Too Many Requests')).toBe('overloaded');
  });

  it('classifies unknown errors', () => {
    expect(p.classifyError('something totally unexpected')).toBe('unknown');
  });

  it('supports OAuth copy and API key', () => {
    expect(p.supportsOAuthCopy()).toBe(true);
    expect(p.supportsApiKey()).toBe(true);
  });

  it('composePermissionConfig disables fleet-mcp for doer (#151)', () => {
    const [settings] = p.composePermissionConfig('doer') as [Record<string, unknown>];
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    expect(mcpServers?.['apra-fleet']).toMatchObject({ disabled: true });
  });

  it('composePermissionConfig disables fleet-mcp for reviewer (#151)', () => {
    const [settings] = p.composePermissionConfig('reviewer') as [Record<string, unknown>];
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    expect(mcpServers?.['apra-fleet']).toMatchObject({ disabled: true });
  });
});

// --- CodexProvider ------------------------------------------------------------

describe('CodexProvider', () => {
  const p = new CodexProvider();

  it('has correct metadata', () => {
    expect(p.name).toBe('codex');
    expect(p.processName).toBe('codex');
    expect(p.authEnvVar).toBe('OPENAI_API_KEY');
    expect(p.credentialPath).toBe('~/.codex/');
    expect(p.instructionFileName).toBe('AGENTS.md');
  });

  it('builds installCommand for macos using brew', () => {
    expect(p.installCommand('macos')).toBe('brew install --cask codex');
  });

  it('builds installCommand for linux/windows using npm', () => {
    expect(p.installCommand('linux')).toContain('@openai/codex');
    expect(p.installCommand('windows')).toContain('@openai/codex');
  });

  it('builds prompt command with defaults', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS });
    expect(cmd).toContain('codex exec');
    expect(cmd).toContain('--json');
    expect(cmd).not.toContain('resume');
    expect(cmd).not.toContain('--sandbox');
  });

  it('builds prompt command with session resume (positional keyword)', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, sessionId: 'any-id' });
    expect(cmd).toContain('resume');
  });

  it('builds prompt command with unattended=auto', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'auto' });
    expect(cmd).toContain('--ask-for-approval auto-edit');
  });

  it('unattended=dangerous adds skip-permissions flags', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'dangerous' });
    expect(cmd).toContain('--sandbox danger-full-access');
    expect(cmd).toContain('--ask-for-approval never');
  });

  it('does not support maxTurns', () => {
    expect(p.supportsMaxTurns()).toBe(false);
  });

  it('resumeFlag returns positional keyword resume', () => {
    expect(p.resumeFlag()).toBe('resume');
  });

  it('maps model tiers', () => {
    expect(p.modelForTier('cheap')).toBe('gpt-5.4-mini');
    expect(p.modelForTier('standard')).toBe('gpt-5.4');
    expect(p.modelForTier('premium')).toBe('gpt-5.4');
  });

  it('modelTiers() returns cheap/standard/premium mapping', () => {
    const tiers = p.modelTiers();
    expect(tiers.cheap).toBe('gpt-5.4-mini');
    expect(tiers.standard).toBe('gpt-5.4');
    expect(tiers.premium).toBe('gpt-5.4');
  });

  it('parses NDJSON response -- extracts last assistant message', () => {
    const ndjson = [
      JSON.stringify({ type: 'start' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working...' }] }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final answer' }] }),
    ].join('\n');
    const resp = p.parseResponse(makeResult(ndjson));
    expect(resp.result).toBe('Final answer');
    expect(resp.isError).toBe(false);
    expect(resp.sessionId).toBeUndefined();
  });

  it('parses NDJSON response -- marks error when error event present', () => {
    const ndjson = [
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Starting...' }] }),
      JSON.stringify({ type: 'error', message: 'quota exceeded' }),
    ].join('\n');
    const resp = p.parseResponse(makeResult(ndjson));
    expect(resp.isError).toBe(true);
    expect(resp.result).toBe('quota exceeded');
  });

  it('parses NDJSON with non-JSON lines gracefully', () => {
    const ndjson = 'not json\n' + JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] });
    const resp = p.parseResponse(makeResult(ndjson));
    expect(resp.result).toBe('ok');
  });

  it('falls back to raw when no parseable content', () => {
    const resp = p.parseResponse(makeResult('raw unparsed output'));
    expect(resp.result).toBe('raw unparsed output');
  });

  it('classifies auth errors', () => {
    expect(p.classifyError('invalid api key')).toBe('auth');
    expect(p.classifyError('401 unauthorized')).toBe('auth');
  });

  it('does not support OAuth copy', () => {
    expect(p.supportsOAuthCopy()).toBe(false);
    expect(p.supportsApiKey()).toBe(true);
  });
});

// --- CopilotProvider ---------------------------------------------------------

describe('CopilotProvider', () => {
  const p = new CopilotProvider();

  it('has correct metadata', () => {
    expect(p.name).toBe('copilot');
    expect(p.processName).toBe('copilot');
    expect(p.authEnvVar).toBe('COPILOT_GITHUB_TOKEN');
    expect(p.credentialPath).toBe('~/.copilot/');
    expect(p.instructionFileName).toBe('COPILOT.md');
  });

  it('builds installCommand per OS', () => {
    expect(p.installCommand('linux')).toContain('gh.io/copilot-install');
    expect(p.installCommand('macos')).toContain('brew install --cask copilot');
    expect(p.installCommand('windows')).toContain('winget install GitHub.CopilotCLI');
  });

  it('builds updateCommand', () => {
    expect(p.updateCommand()).toBe('copilot update');
  });

  it('builds prompt command with defaults', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS });
    expect(cmd).toContain('copilot -p');
    expect(cmd).toContain('--format json');
    expect(cmd).not.toContain('--continue');
    expect(cmd).not.toContain('--allow-all-tools');
    expect(cmd).not.toContain('--max-turns');
  });

  it('builds prompt command with session resume', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, sessionId: 'any-id' });
    expect(cmd).toContain('--continue');
  });

  it('logs warning for unattended=auto (not supported)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'auto' });
    expect(cmd).not.toContain('--allow-all-tools');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not supported for Copilot'));
    spy.mockRestore();
  });

  it('logs warning for unattended=dangerous (not supported)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'dangerous' });
    expect(cmd).not.toContain('--allow-all-tools');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not supported for Copilot'));
    spy.mockRestore();
  });

  it('builds prompt command with model', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, model: 'claude-opus-4-5' });
    expect(cmd).toContain('--model "claude-opus-4-5"');
  });

  it('skipPermissionsFlag returns --allow-all-tools', () => {
    expect(p.skipPermissionsFlag()).toBe('--allow-all-tools');
  });

  it('parses successful JSON response', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ result: 'copilot done' })));
    expect(resp.result).toBe('copilot done');
    expect(resp.sessionId).toBeUndefined();
    expect(resp.isError).toBe(false);
  });

  it('parses JSON with response field', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ response: 'copilot result' })));
    expect(resp.result).toBe('copilot result');
  });

  it('handles non-JSON stdout gracefully', () => {
    const resp = p.parseResponse(makeResult('raw text'));
    expect(resp.result).toBe('raw text');
    expect(resp.sessionId).toBeUndefined();
  });

  it('marks non-zero exit code as error', () => {
    const resp = p.parseResponse(makeResult('{}', 1));
    expect(resp.isError).toBe(true);
  });

  it('does not support maxTurns', () => {
    expect(p.supportsMaxTurns()).toBe(false);
  });

  it('resumeFlag always returns --continue', () => {
    expect(p.resumeFlag()).toBe('--continue');
    expect(p.resumeFlag('any-id')).toBe('--continue');
  });

  it('maps model tiers', () => {
    expect(p.modelForTier('cheap')).toBe('claude-haiku-4-5');
    expect(p.modelForTier('standard')).toBe('claude-sonnet-4-5');
    expect(p.modelForTier('premium')).toBe('claude-opus-4-5');
  });

  it('modelTiers() returns cheap/standard/premium mapping', () => {
    const tiers = p.modelTiers();
    expect(tiers.cheap).toBe('claude-haiku-4-5');
    expect(tiers.standard).toBe('claude-sonnet-4-5');
    expect(tiers.premium).toBe('claude-opus-4-5');
  });

  it('classifies auth errors', () => {
    expect(p.classifyError('not logged in')).toBe('auth');
    expect(p.classifyError('401 unauthorized')).toBe('auth');
    expect(p.classifyError('invalid token')).toBe('auth');
  });

  it('classifies server errors', () => {
    expect(p.classifyError('500 internal server error')).toBe('server');
  });

  it('classifies overloaded errors', () => {
    expect(p.classifyError('429 rate limit')).toBe('overloaded');
  });

  it('classifies unknown errors', () => {
    expect(p.classifyError('something random')).toBe('unknown');
  });

  it('does not support OAuth copy, supports API key', () => {
    expect(p.supportsOAuthCopy()).toBe(false);
    expect(p.supportsApiKey()).toBe(true);
  });
});

// --- getProvider factory ------------------------------------------------------

describe('getProvider factory', () => {
  it('returns ClaudeProvider by default (undefined)', () => {
    expect(getProvider(undefined).name).toBe('claude');
  });

  it('returns ClaudeProvider for null', () => {
    expect(getProvider(null).name).toBe('claude');
  });

  it('returns ClaudeProvider for "claude"', () => {
    expect(getProvider('claude').name).toBe('claude');
  });

  it('returns CodexProvider for "codex"', () => {
    expect(getProvider('codex').name).toBe('codex');
  });

  it('returns CopilotProvider for "copilot"', () => {
    expect(getProvider('copilot').name).toBe('copilot');
  });

  it('returns singleton instances (same object reference)', () => {
    expect(getProvider('claude')).toBe(getProvider('claude'));
    expect(getProvider('agy')).toBe(getProvider('agy'));
  });

  it('throws TypeError for unknown provider strings (no silent fallback)', () => {
    // Cast to bypass TS -- registry JSON could yield arbitrary strings at runtime
    expect(() => getProvider('bogus' as any)).toThrow(TypeError);
    expect(() => getProvider('bogus' as any)).toThrow(/Unknown LLM provider "bogus"/);
  });

  // apra-fleet-ytfy.1.7: the gemini provider identifier must no longer resolve
  // now that the registry entry and GeminiProvider module have been removed.
  it('throws TypeError for "gemini" -- provider was removed', () => {
    expect(() => getProvider('gemini' as any)).toThrow(TypeError);
    expect(() => getProvider('gemini' as any)).toThrow(/Unknown LLM provider "gemini"/);
  });

  it('error message lists supported providers and excludes gemini', () => {
    let caught: Error | undefined;
    try {
      getProvider('nonsense' as any);
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/claude/);
    expect(caught!.message).toMatch(/codex/);
    expect(caught!.message).toMatch(/copilot/);
    expect(caught!.message).toMatch(/agy/);
    expect(caught!.message).not.toMatch(/gemini/);
  });
});

// --- buildResumeFlag shared helper -------------------------------------------

describe('buildResumeFlag', () => {
  it('returns empty string when no sessionId and no fallback', () => {
    expect(buildResumeFlag(undefined)).toBe('');
  });

  it('returns fallback when no sessionId', () => {
    expect(buildResumeFlag(undefined, '--resume latest')).toBe('--resume latest');
  });

  it('sanitizes and quotes session ID', () => {
    expect(buildResumeFlag('sess-abc-123')).toBe('--resume "sess-abc-123"');
  });

  it('rejects malicious session IDs', () => {
    expect(() => buildResumeFlag('$(whoami)')).toThrow('Invalid session ID');
    expect(() => buildResumeFlag('id;rm -rf /')).toThrow('Invalid session ID');
  });
});

// --- buildSessionIdFlag shared helper ----------------------------------------

describe('buildSessionIdFlag', () => {
  it('returns --session-id with sanitized and quoted ID', () => {
    expect(buildSessionIdFlag('sess-abc-123')).toBe('--session-id "sess-abc-123"');
  });

  it('rejects malicious session IDs', () => {
    expect(() => buildSessionIdFlag('$(whoami)')).toThrow('Invalid session ID');
    expect(() => buildSessionIdFlag('id;rm -rf /')).toThrow('Invalid session ID');
  });
});

// --- Cross-OS consistency (Linux buildPromptCommand vs Windows resumeFlag) --

describe('cross-OS session flag consistency', () => {
  it('Claude: buildPromptCommand and resumeFlag produce consistent flags for new session', () => {
    const p = new ClaudeProvider();
    const sid = 'test-session-id';
    const cmd = p.buildPromptCommand({ folder: '/work', promptFile: '.fleet-task.md', sessionId: sid, resuming: false });
    const winFlag = p.resumeFlag(sid, false);
    expect(cmd).toContain('--session-id "test-session-id"');
    expect(winFlag).toBe('--session-id "test-session-id"');
  });

  it('Claude: buildPromptCommand and resumeFlag produce consistent flags for resumed session', () => {
    const p = new ClaudeProvider();
    const sid = 'test-session-id';
    const cmd = p.buildPromptCommand({ folder: '/work', promptFile: '.fleet-task.md', sessionId: sid, resuming: true });
    const winFlag = p.resumeFlag(sid, true);
    expect(cmd).toContain('--resume "test-session-id"');
    expect(winFlag).toBe('--resume "test-session-id"');
  });

});

// --- Claude dispatch: resume with no stored ID -----------------------------

describe('Claude dispatch: resume with no stored session ID', () => {
  it('produces --session-id (fresh), not -c, when resume=true but no stored ID', () => {
    const p = new ClaudeProvider();
    const sid = 'fresh-uuid';
    const cmd = p.buildPromptCommand({ folder: '/work', promptFile: '.fleet-task.md', sessionId: sid, resuming: false });
    expect(cmd).toContain('--session-id "fresh-uuid"');
    expect(cmd).not.toContain('-c');
    expect(cmd).not.toContain('--resume');
  });
});

// --- Backwards compatibility --------------------------------------------------

describe('backwards compatibility', () => {
  it('member without llmProvider uses ClaudeProvider', () => {
    // Simulate what code does: member.llmProvider ?? 'claude'
    const agentLlmProvider = undefined;
    const provider = getProvider(agentLlmProvider ?? 'claude');
    expect(provider.name).toBe('claude');
  });

  it('Claude prompt command matches historical format', () => {
    const p = new ClaudeProvider();
    const cmd = p.buildPromptCommand({ folder: '/work', b64Prompt: 'dGVzdA==', maxTurns: 50 });
    // Verify the key parts that current code depends on
    expect(cmd).toMatch(/cd "\/work" && claude -p/);
    expect(cmd).toContain('--output-format json');
    expect(cmd).toContain('--max-turns 50');
  });
});

describe('AgyProvider', () => {
  const p = new AgyProvider();

  it('has correct metadata', () => {
    expect(p.name).toBe('agy');
    expect(p.processName).toBe('agy');
    expect(p.authEnvVar).toBe('ANTIGRAVITY_API_KEY');
    expect(p.credentialPath).toBe('~/.gemini/antigravity-cli/settings.json');
    expect(p.instructionFileName).toBe('AGY.md');
  });

  it('builds cliCommand', () => {
    expect(p.cliCommand('--version')).toBe('agy --version');
  });

  it('builds versionCommand', () => {
    expect(p.versionCommand()).toBe('agy --version 2>&1');
  });

  it('builds installCommand', () => {
    expect(p.installCommand('linux')).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
    expect(p.installCommand('macos')).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
    expect(p.installCommand('windows')).toBe('powershell -Command "irm https://antigravity.google/cli/install.ps1 | iex"');
  });

  it('builds updateCommand', () => {
    expect(p.updateCommand()).toBe('agy update');
  });

  it('builds prompt command with defaults and --output-format json', () => {
    const cmd = p.buildPromptCommand({ folder: '/home/user/project', promptFile: '.fleet-task.md' });
    expect(cmd).toContain('agy --model');
    expect(cmd).toContain('--output-format json');
    expect(cmd).toContain('-p');
    expect(cmd).not.toContain('--conversation');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('builds prompt command with resume flag', () => {
    const cmd = p.buildPromptCommand({ folder: '/home/user/project', promptFile: '.fleet-task.md', sessionId: 'sess-abc', resuming: true });
    expect(cmd).toContain('--conversation "sess-abc"');
    expect(cmd).toContain('--output-format json');
  });

  it('builds prompt command with unattended=dangerous', () => {
    const cmd = p.buildPromptCommand({ folder: '/home/user/project', promptFile: '.fleet-task.md', unattended: 'dangerous' });
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('builds prompt command with unattended=auto (baseline accept-edits, not a full bypass)', () => {
    const cmd = p.buildPromptCommand({ folder: '/home/user/project', promptFile: '.fleet-task.md', unattended: 'auto' });
    expect(cmd).toContain('--mode accept-edits');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    expect(p.permissionModeAutoFlag()).toBe('--mode accept-edits');
  });

  it('jsonOutputFlag returns --output-format json', () => {
    expect(p.jsonOutputFlag()).toBe('--output-format json');
  });

  it('parseResponse extracts result, sessionId, and usage metrics from AGY native JSON envelope', () => {
    const agyJson = JSON.stringify({
      conversation_id: 'conv-12345-uuid',
      status: 'SUCCESS',
      response: 'Hello from AGY!',
      duration_seconds: 1.23,
      num_turns: 1,
      usage: {
        input_tokens: 5000,
        output_tokens: 150,
        thinking_tokens: 50,
        cache_read_tokens: 1000,
        total_tokens: 5150,
      },
    });

    const parsed = p.parseResponse({ stdout: agyJson, stderr: '', code: 0 });
    expect(parsed.result).toBe('Hello from AGY!');
    expect(parsed.sessionId).toBe('conv-12345-uuid');
    expect(parsed.isError).toBe(false);
    expect(parsed.usage).toEqual({ input_tokens: 5000, output_tokens: 150 });
  });

  it('parseResponse handles AGY JSON error status and error message', () => {
    const agyErrJson = JSON.stringify({
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'invalid model selection (--model "bogus")',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    });

    const parsed = p.parseResponse({ stdout: agyErrJson, stderr: '', code: 1 });
    expect(parsed.result).toBe('invalid model selection (--model "bogus")');
    expect(parsed.isError).toBe(true);
  });

  it('modelFlag returns empty string', () => {
    expect(p.modelFlag('gemini-3.5-flash')).toBe('');
  });

  it('modelTiers and modelForTier return correct mappings', () => {
    expect(p.modelForTier('cheap')).toBe('gemini-3.5-flash-lite');
    expect(p.modelForTier('standard')).toBe('gemini-3.5-flash');
    expect(p.modelForTier('premium')).toBe('claude-sonnet-4.6');
  });

  it('permissionConfigPaths returns .gemini/antigravity-cli/settings.json', () => {
    expect(p.permissionConfigPaths()).toEqual(['.gemini/antigravity-cli/settings.json']);
  });

  it('composePermissionConfig produces AGY native permission rule objects', () => {
    const claudeAllow = ['Read', 'Write', 'Edit', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(bd:*)', 'Agent'];
    const configs = p.composePermissionConfig('doer', claudeAllow);
    expect(configs).toHaveLength(1);
    const cfg = configs[0] as Record<string, any>;
    expect(cfg.permissions).toBeDefined();
    expect(cfg.permissions.allow).toEqual([
      { action: 'read_file', target: '*' },
      { action: 'write_file', target: '*' },
      { action: 'command', target: 'git' },
      { action: 'command', target: 'npm' },
      { action: 'command', target: 'bd' },
      { action: 'invoke_subagent', target: '*' },
      { action: 'send_message', target: '*' },
    ]);
  });
});

describe('SessionIdStrategy & Log Path Resolution', () => {
  it('claude uses caller-minted sessionIdStrategy', () => {
    expect(getProvider('claude').sessionIdStrategy()).toEqual({ type: 'caller-minted' });
  });

  it('agy, opencode, codex, copilot, none use provider-minted sessionIdStrategy', () => {
    expect(getProvider('agy').sessionIdStrategy()).toEqual({ type: 'provider-minted' });
    expect(getProvider('opencode').sessionIdStrategy()).toEqual({ type: 'provider-minted' });
    expect(getProvider('codex').sessionIdStrategy()).toEqual({ type: 'provider-minted' });
    expect(getProvider('copilot').sessionIdStrategy()).toEqual({ type: 'provider-minted' });
    expect(getProvider('none').sessionIdStrategy()).toEqual({ type: 'provider-minted' });
  });

  it('opencode, codex, copilot, none return empty string for resolveSessionLogPath', () => {
    expect(getProvider('opencode').resolveSessionLogPath('sid', '/path')).toBe('');
    expect(getProvider('codex').resolveSessionLogPath('sid', '/path')).toBe('');
    expect(getProvider('copilot').resolveSessionLogPath('sid', '/path')).toBe('');
    expect(getProvider('none').resolveSessionLogPath('sid', '/path')).toBe('');
  });
});
