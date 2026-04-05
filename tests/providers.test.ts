import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { CodexProvider } from '../src/providers/codex.js';
import { CopilotProvider } from '../src/providers/copilot.js';
import { getProvider } from '../src/providers/index.js';
import { buildResumeFlag } from '../src/providers/provider.js';
import type { SSHExecResult } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResult(stdout: string, code = 0): SSHExecResult {
  return { stdout, stderr: '', code };
}

const BASE_OPTS = {
  folder: '/home/user/project',
  b64Prompt: 'aGVsbG8=',  // base64 of "hello"
};

// ─── ClaudeProvider ───────────────────────────────────────────────────────────

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
  });

  it('builds prompt command with session resume', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, sessionId: 'sess-abc' });
    expect(cmd).toContain('--resume "sess-abc"');
  });

  it('builds prompt command with dangerously skip permissions', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, dangerouslySkipPermissions: true });
    expect(cmd).toContain('--dangerously-skip-permissions');
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

  it('supports resume and maxTurns', () => {
    expect(p.supportsResume()).toBe(true);
    expect(p.supportsMaxTurns()).toBe(true);
  });

  it('resumeFlag with sessionId includes ID', () => {
    expect(p.resumeFlag('ses-1')).toBe('--resume "ses-1"');
  });

  it('resumeFlag without sessionId returns empty string', () => {
    expect(p.resumeFlag()).toBe('');
  });

  it('maps model tiers', () => {
    expect(p.modelForTier('cheap')).toBe('claude-haiku-4-5');
    expect(p.modelForTier('mid')).toBe('claude-sonnet-4-6');
    expect(p.modelForTier('premium')).toBe('claude-opus-4-6');
  });

  it('modelTiers() returns cheap/standard/premium mapping', () => {
    const tiers = p.modelTiers();
    expect(tiers.cheap).toBe('claude-haiku-4-5');
    expect(tiers.standard).toBe('claude-sonnet-4-6');
    expect(tiers.premium).toBe('claude-opus-4-6');
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
});

// ─── GeminiProvider ───────────────────────────────────────────────────────────

describe('GeminiProvider', () => {
  const p = new GeminiProvider();

  it('has correct metadata', () => {
    expect(p.name).toBe('gemini');
    expect(p.processName).toBe('gemini');
    expect(p.authEnvVar).toBe('GEMINI_API_KEY');
    expect(p.credentialPath).toBe('~/.gemini/');
    expect(p.instructionFileName).toBe('GEMINI.md');
  });

  it('builds installCommand same for all OS', () => {
    expect(p.installCommand('linux')).toContain('@google/gemini-cli');
    expect(p.installCommand('macos')).toContain('@google/gemini-cli');
    expect(p.installCommand('windows')).toContain('@google/gemini-cli');
  });

  it('builds prompt command with defaults (no max-turns)', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS });
    expect(cmd).toContain('gemini -p');
    expect(cmd).toContain('--output-format json');
    expect(cmd).not.toContain('--max-turns');
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--yolo');
  });

  it('builds prompt command with session resume (sanitized + quoted)', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, sessionId: 'any-id' });
    expect(cmd).toContain('--resume "any-id"');
  });

  it('builds prompt command with skip permissions', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, dangerouslySkipPermissions: true });
    expect(cmd).toContain('--yolo');
  });

  it('builds prompt command with model', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, model: 'gemini-2.5-flash' });
    expect(cmd).toContain('--model "gemini-2.5-flash"');
  });

  it('parses successful JSON response with session_id', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ response: 'gemini result', session_id: 'gem-sess-42' })));
    expect(resp.result).toBe('gemini result');
    expect(resp.sessionId).toBe('gem-sess-42');
    expect(resp.isError).toBe(false);
  });

  it('parses successful JSON response without session_id', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ response: 'gemini result' })));
    expect(resp.result).toBe('gemini result');
    expect(resp.sessionId).toBeUndefined();
    expect(resp.isError).toBe(false);
  });

  it('parses response with is_error flag as error', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ response: 'error output', is_error: true })));
    expect(resp.isError).toBe(true);
  });

  it('parses response with non-zero exit code — sessionId is undefined', () => {
    const resp = p.parseResponse(makeResult(JSON.stringify({ response: 'error output' }), 1));
    expect(resp.isError).toBe(true);
    expect(resp.sessionId).toBeUndefined();
  });

  it('parses non-JSON response with zero exit code — sessionId is undefined', () => {
    const resp = p.parseResponse(makeResult('raw text output'));
    expect(resp.result).toBe('raw text output');
    expect(resp.sessionId).toBeUndefined();
    expect(resp.isError).toBe(false);
  });

  it('parses non-JSON response with non-zero exit code — sessionId is undefined', () => {
    const resp = p.parseResponse(makeResult('error text', 1));
    expect(resp.result).toBe('error text');
    expect(resp.sessionId).toBeUndefined();
    expect(resp.isError).toBe(true);
  });

  it('does not support maxTurns', () => {
    expect(p.supportsMaxTurns()).toBe(false);
  });

  it('resumeFlag uses actual session ID when provided (sanitized + quoted)', () => {
    expect(p.resumeFlag()).toBe('--resume latest');
    expect(p.resumeFlag('gem-sess-42')).toBe('--resume "gem-sess-42"');
  });

  it('maps model tiers', () => {
    expect(p.modelForTier('cheap')).toBe('gemini-2.5-flash');
    expect(p.modelForTier('mid')).toBe('gemini-2.5-pro');
    expect(p.modelForTier('premium')).toBe('gemini-3-pro-preview');
  });

  it('modelTiers() returns cheap/standard/premium mapping', () => {
    const tiers = p.modelTiers();
    expect(tiers.cheap).toBe('gemini-2.5-flash');
    expect(tiers.standard).toBe('gemini-2.5-pro');
    expect(tiers.premium).toBe('gemini-3-pro-preview');
  });

  it('classifies auth errors', () => {
    expect(p.classifyError('unauthorized')).toBe('auth');
    expect(p.classifyError('invalid api key')).toBe('auth');
  });

  it('classifies server errors', () => {
    expect(p.classifyError('503 service unavailable')).toBe('server');
  });

  it('classifies overloaded errors', () => {
    expect(p.classifyError('rate limit exceeded')).toBe('overloaded');
  });

  it('does not support OAuth copy, supports API key', () => {
    expect(p.supportsOAuthCopy()).toBe(false);
    expect(p.supportsApiKey()).toBe(true);
  });
});

// ─── CodexProvider ────────────────────────────────────────────────────────────

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

  it('builds prompt command with skip permissions', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, dangerouslySkipPermissions: true });
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
    expect(p.modelForTier('mid')).toBe('gpt-5.4');
    expect(p.modelForTier('premium')).toBe('gpt-5.4');
  });

  it('modelTiers() returns cheap/standard/premium mapping', () => {
    const tiers = p.modelTiers();
    expect(tiers.cheap).toBe('gpt-5.4-mini');
    expect(tiers.standard).toBe('gpt-5.4');
    expect(tiers.premium).toBe('gpt-5.4');
  });

  it('parses NDJSON response — extracts last assistant message', () => {
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

  it('parses NDJSON response — marks error when error event present', () => {
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

// ─── CopilotProvider ─────────────────────────────────────────────────────────

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

  it('builds prompt command with skip permissions', () => {
    const cmd = p.buildPromptCommand({ ...BASE_OPTS, dangerouslySkipPermissions: true });
    expect(cmd).toContain('--allow-all-tools');
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
    expect(p.modelForTier('mid')).toBe('claude-sonnet-4-5');
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

// ─── getProvider factory ──────────────────────────────────────────────────────

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

  it('returns GeminiProvider for "gemini"', () => {
    expect(getProvider('gemini').name).toBe('gemini');
  });

  it('returns CodexProvider for "codex"', () => {
    expect(getProvider('codex').name).toBe('codex');
  });

  it('returns CopilotProvider for "copilot"', () => {
    expect(getProvider('copilot').name).toBe('copilot');
  });

  it('returns singleton instances (same object reference)', () => {
    expect(getProvider('claude')).toBe(getProvider('claude'));
    expect(getProvider('gemini')).toBe(getProvider('gemini'));
  });
});

// ─── buildResumeFlag shared helper ───────────────────────────────────────────

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

// ─── Backwards compatibility ──────────────────────────────────────────────────

describe('backwards compatibility', () => {
  it('agent without llmProvider uses ClaudeProvider', () => {
    // Simulate what code does: agent.llmProvider ?? 'claude'
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
