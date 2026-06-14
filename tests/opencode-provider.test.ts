import { describe, it, expect } from 'vitest';
import { OpenCodeProvider } from '../src/providers/opencode.js';
import { getProvider } from '../src/providers/index.js';
import type { SSHExecResult } from '../src/types.js';
import { readFileSync } from 'fs';
import { join } from 'path';

function makeResult(stdout: string, code = 0): SSHExecResult {
  return { stdout, stderr: '', code };
}

const p = new OpenCodeProvider();

// -- T3.1: Registration --

describe('OpenCodeProvider registration', () => {
  it('getProvider returns OpenCodeProvider', () => {
    const provider = getProvider('opencode');
    expect(provider).toBeInstanceOf(OpenCodeProvider);
    expect(provider.name).toBe('opencode');
  });
});

// -- T3.2: Core adapter methods --

describe('OpenCodeProvider core methods', () => {
  it('has correct metadata', () => {
    expect(p.name).toBe('opencode');
    expect(p.processName).toBe('opencode');
    expect(p.authEnvVar).toBe('');
    expect(p.credentialPath).toBe('~/.config/opencode/');
    expect(p.instructionFileName).toBe('AGENTS.md');
  });

  it('cliCommand', () => {
    expect(p.cliCommand('--version')).toBe('opencode --version');
  });

  it('versionCommand', () => {
    expect(p.versionCommand()).toBe('opencode --version 2>&1');
  });

  it('installCommand linux uses curl', () => {
    expect(p.installCommand('linux')).toContain('opencode.ai/install');
  });

  it('installCommand windows uses npm', () => {
    expect(p.installCommand('windows')).toBe('npm install -g opencode-ai');
  });

  it('installCommand macos uses npm', () => {
    expect(p.installCommand('macos')).toBe('npm install -g opencode-ai');
  });

  it('updateCommand', () => {
    expect(p.updateCommand()).toBe('npm update -g opencode-ai');
  });

  it('skipPermissionsFlag', () => {
    expect(p.skipPermissionsFlag()).toBe('--dangerously-skip-permissions');
  });

  it('permissionModeAutoFlag returns null', () => {
    expect(p.permissionModeAutoFlag()).toBeNull();
  });

  it('modelTiers returns static defaults', () => {
    const tiers = p.modelTiers();
    expect(tiers.cheap).toBe('ollama/qwen3-coder:30b');
    expect(tiers.standard).toBe('ollama/qwen3-coder:30b');
    expect(tiers.premium).toBe('ollama/qwen3-coder:30b');
  });

  it('modelForTier returns correct model', () => {
    expect(p.modelForTier('cheap')).toBe('ollama/qwen3-coder:30b');
    expect(p.modelForTier('mid')).toBe('ollama/qwen3-coder:30b');
    expect(p.modelForTier('premium')).toBe('ollama/qwen3-coder:30b');
  });

  it('modelFlag', () => {
    expect(p.modelFlag('ollama/qwen3-coder:30b')).toBe('-m "ollama/qwen3-coder:30b"');
  });

  it('classifyError: auth', () => {
    expect(p.classifyError('command not found')).toBe('auth');
    expect(p.classifyError('opencode: not found')).toBe('auth');
  });

  it('classifyError: server', () => {
    expect(p.classifyError('connection refused to host')).toBe('server');
    expect(p.classifyError('ECONNREFUSED')).toBe('server');
    expect(p.classifyError('request timeout')).toBe('server');
    expect(p.classifyError('ETIMEDOUT')).toBe('server');
  });

  it('classifyError: overloaded', () => {
    expect(p.classifyError('429 Too Many Requests')).toBe('overloaded');
    expect(p.classifyError('rate limit exceeded')).toBe('overloaded');
  });

  it('classifyError: unknown', () => {
    expect(p.classifyError('something weird happened')).toBe('unknown');
  });

  it('headlessInvocation', () => {
    expect(p.headlessInvocation('do stuff')).toBe('run "do stuff"');
  });

  it('jsonOutputFlag', () => {
    expect(p.jsonOutputFlag()).toBe('--format json');
  });
});

// -- T3.3: buildPromptCommand + session management --

describe('OpenCodeProvider buildPromptCommand', () => {
  it('builds basic command', () => {
    const cmd = p.buildPromptCommand({
      folder: '/home/user/project',
      promptFile: '.fleet-task.md',
      model: 'ollama/qwen3-coder:30b',
    });
    expect(cmd).toContain('cd "/home/user/project"');
    expect(cmd).toContain('opencode run');
    expect(cmd).toContain('-m "ollama/qwen3-coder:30b"');
    expect(cmd).toContain('--format json');
    expect(cmd).toContain('.fleet-task.md');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    expect(cmd).not.toContain('--session');
    expect(cmd).not.toContain('--continue');
  });

  it('adds skip-permissions for unattended=dangerous', () => {
    const cmd = p.buildPromptCommand({
      folder: '/tmp/test',
      promptFile: '.fleet-task.md',
      unattended: 'dangerous',
      model: 'ollama/qwen3-coder:30b',
    });
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('does not add skip-permissions for unattended=auto', () => {
    const cmd = p.buildPromptCommand({
      folder: '/tmp/test',
      promptFile: '.fleet-task.md',
      unattended: 'auto',
      model: 'ollama/qwen3-coder:30b',
    });
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('adds resume with session ID', () => {
    const cmd = p.buildPromptCommand({
      folder: '/tmp/test',
      promptFile: '.fleet-task.md',
      sessionId: 'ses_abc123',
      resuming: true,
      model: 'ollama/qwen3-coder:30b',
    });
    expect(cmd).toContain('--session "ses_abc123"');
    expect(cmd).not.toContain('--continue');
  });

  it('adds --continue for resume without session ID', () => {
    const cmd = p.buildPromptCommand({
      folder: '/tmp/test',
      promptFile: '.fleet-task.md',
      resuming: true,
      model: 'ollama/qwen3-coder:30b',
    });
    expect(cmd).toContain('--continue');
    expect(cmd).not.toContain('--session');
  });

  it('prepends inv tag', () => {
    const cmd = p.buildPromptCommand({
      folder: '/tmp/test',
      promptFile: '.fleet-task.md',
      inv: 'abc123',
      model: 'ollama/qwen3-coder:30b',
    });
    expect(cmd).toContain('[abc123]');
  });

  it('works without model', () => {
    const cmd = p.buildPromptCommand({
      folder: '/tmp/test',
      promptFile: '.fleet-task.md',
    });
    expect(cmd).toContain('opencode run');
    expect(cmd).not.toContain('-m');
  });
});

describe('OpenCodeProvider session support', () => {
  it('supportsResume', () => {
    expect(p.supportsResume()).toBe(true);
  });

  it('supportsMaxTurns', () => {
    expect(p.supportsMaxTurns()).toBe(false);
  });

  it('resumeFlag with session ID and resuming', () => {
    expect(p.resumeFlag('ses_abc', true)).toContain('--session "ses_abc"');
  });

  it('resumeFlag with resuming but no session ID', () => {
    expect(p.resumeFlag(undefined, true)).toBe('--continue');
  });

  it('resumeFlag with no resume', () => {
    expect(p.resumeFlag('ses_abc', false)).toBe('');
    expect(p.resumeFlag(undefined, false)).toBe('');
    expect(p.resumeFlag()).toBe('');
  });
});

// -- T3.4: parseResponse --

describe('OpenCodeProvider parseResponse', () => {
  const fixturePath = join(__dirname, 'fixtures', 'opencode-output.ndjson');

  it('extracts text from text events', () => {
    const ndjson = readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(ndjson));
    expect(parsed.result).toContain('hello');
    expect(parsed.isError).toBe(false);
  });

  it('extracts sessionId from events', () => {
    const ndjson = readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(ndjson));
    expect(parsed.sessionId).toMatch(/^ses_/);
  });

  it('extracts usage from step_finish', () => {
    const ndjson = readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(ndjson));
    expect(parsed.usage).toBeDefined();
    expect(parsed.usage!.input_tokens).toBe(7165);
    expect(parsed.usage!.output_tokens).toBe(2);
  });

  it('handles error events', () => {
    const errorLine = '{"type":"error","timestamp":1749843180,"sessionID":"ses_err_test","error":{"name":"UnknownError","data":{"message":"Model not found: ollama/nonexistent-model-xyz123."}}}';
    const parsed = p.parseResponse(makeResult(errorLine));
    expect(parsed.isError).toBe(true);
    expect(parsed.result).toContain('Model not found');
    expect(parsed.sessionId).toBe('ses_err_test');
  });

  it('handles empty output', () => {
    const parsed = p.parseResponse(makeResult(''));
    expect(parsed.result).toBe('');
    expect(parsed.isError).toBe(false);
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.usage).toBeUndefined();
  });

  it('handles non-zero exit code', () => {
    const parsed = p.parseResponse(makeResult('', 1));
    expect(parsed.isError).toBe(true);
  });

  it('handles malformed JSON lines', () => {
    const parsed = p.parseResponse(makeResult('{bad json}\n{"type":"text","sessionID":"ses_x","part":{"text":"ok"}}'));
    expect(parsed.isError).toBe(true);
    expect(parsed.result).toContain('ok');
  });

  it('handles step_finish with unexpected reason', () => {
    const line = '{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","reason":"unexpected_reason","tokens":{"total":100,"input":90,"output":10,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}';
    const parsed = p.parseResponse(makeResult(line));
    expect(parsed.isError).toBe(true);
  });

  it('handles step_finish with stop reason as non-error', () => {
    const line = '{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","reason":"stop","tokens":{"total":100,"input":90,"output":10,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}';
    const parsed = p.parseResponse(makeResult(line));
    expect(parsed.isError).toBe(false);
  });

  it('prefers last error message', () => {
    const lines = [
      '{"type":"error","timestamp":1,"sessionID":"ses_multi","error":{"name":"GenericError","data":{"message":"Unexpected server error"}}}',
      '{"type":"error","timestamp":2,"sessionID":"ses_multi","error":{"name":"UnknownError","data":{"message":"Model not found: ollama/bad-model"}}}',
    ].join('\n');
    const parsed = p.parseResponse(makeResult(lines));
    expect(parsed.isError).toBe(true);
    expect(parsed.result).toContain('Model not found');
  });
});

// -- T3.5: Permission and auth methods --

describe('OpenCodeProvider permission and auth methods', () => {
  it('permissionConfigPaths returns opencode settings path', () => {
    expect(p.permissionConfigPaths()).toEqual(['.opencode/settings.json']);
  });

  it('composePermissionConfig doer allows edit, write, bash', () => {
    const config = p.composePermissionConfig('doer');
    expect(config).toHaveLength(1);
    const perm = (config[0] as Record<string, unknown>).permission as Record<string, string>;
    expect(perm.edit).toBe('allow');
    expect(perm.write).toBe('allow');
    expect(perm.bash).toBe('allow');
  });

  it('composePermissionConfig reviewer denies edit and write, allows bash', () => {
    const config = p.composePermissionConfig('reviewer');
    expect(config).toHaveLength(1);
    const perm = (config[0] as Record<string, unknown>).permission as Record<string, string>;
    expect(perm.edit).toBe('deny');
    expect(perm.write).toBe('deny');
    expect(perm.bash).toBe('allow');
  });

  it('supportsOAuthCopy returns false', () => {
    expect(p.supportsOAuthCopy()).toBe(false);
  });

  it('supportsApiKey returns false', () => {
    expect(p.supportsApiKey()).toBe(false);
  });

  it('oauthCredentialFiles returns null', () => {
    expect(p.oauthCredentialFiles()).toBeNull();
  });

  it('oauthSettingsMerge returns null', () => {
    expect(p.oauthSettingsMerge()).toBeNull();
  });

  it('oauthEnvVarsToUnset returns empty array', () => {
    expect(p.oauthEnvVarsToUnset()).toEqual([]);
  });

  it('authEnvVarForToken returns empty string', () => {
    expect(p.authEnvVarForToken('some-token')).toBe('');
  });

  it('wrapWindowsPrompt mirrors codex pattern', () => {
    const result = p.wrapWindowsPrompt('$setup; ', 'opencode', '--args');
    expect(result).toContain('FLEET_PID:$pid');
    expect(result).toContain('opencode');
    expect(result).toContain('--args');
  });
});
