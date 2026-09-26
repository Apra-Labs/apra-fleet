import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry } from '../test-helpers.js';
import { addAgent, getAgent } from '../../src/services/registry.js';
import { getProvider } from '../../src/providers/index.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { resolveSessionLogPath, resolveSessionLogDir } from '../../src/services/stall/log-path-resolver.js';
import { classifyPromptError } from '../../src/utils/prompt-errors.js';

describe('Claude Integration Suite (claude-integration-tests)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  describe('Claude Member Registration & Provider Mapping', () => {
    it('registers a Claude member and maps to ClaudeProvider', () => {
      const member = makeTestAgent({
        id: 'claude-member-001',
        friendlyName: 'fleet-dev',
        llmProvider: 'claude',
        os: 'linux',
      });
      addAgent(member);

      const resolved = getAgent('claude-member-001');
      expect(resolved).toBeDefined();
      expect(resolved?.llmProvider).toBe('claude');

      const provider = getProvider('claude');
      expect(provider).toBeInstanceOf(ClaudeProvider);
      expect(provider.name).toBe('claude');
      expect(provider.processName).toBe('claude');
      expect(provider.instructionFileName).toBe('CLAUDE.md');
    });
  });

  describe('Claude Command Construction & Features (Session, Resume, Turns)', () => {
    const provider = new ClaudeProvider();

    it('builds non-interactive claude prompt command with model, max-turns, and dangerously-skip-permissions', () => {
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/workspace',
        promptFile: '.fleet-task.md',
        model: 'sonnet',
        unattended: 'dangerous',
        maxTurns: 50,
      });
      expect(cmd).toContain('claude');
      expect(cmd).toContain('-p "Your task is described in .fleet-task.md');
      expect(cmd).toContain('--output-format json');
      expect(cmd).toContain('--max-turns 50');
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).toContain('--model "sonnet"');
    });

    it('supports session resumption via --resume flag', () => {
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/workspace',
        promptFile: '.fleet-task.md',
        sessionId: 'sess-claude-12345',
        resuming: true,
      });
      expect(cmd).toContain('--resume "sess-claude-12345"');
    });

    it('carries a fresh session id via --session-id when not resuming', () => {
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/workspace',
        promptFile: '.fleet-task.md',
        sessionId: 'sess-claude-67890',
        resuming: false,
      });
      expect(cmd).toContain('--session-id "sess-claude-67890"');
    });

    it('falls back to acceptEdits permission mode for headless dispatch with no unattended flag', () => {
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/workspace',
        promptFile: '.fleet-task.md',
      });
      expect(cmd).toContain('--permission-mode acceptEdits');
    });

    it('uses --permission-mode auto for unattended "auto"', () => {
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/workspace',
        promptFile: '.fleet-task.md',
        unattended: 'auto',
      });
      expect(cmd).toContain('--permission-mode auto');
    });

    it('maps tier preferences seamlessly across cheap, standard, and premium', () => {
      expect(provider.modelForTier('cheap')).toBe('haiku');
      expect(provider.modelForTier('standard')).toBe('sonnet');
      expect(provider.modelForTier('premium')).toBe('opus');
    });

    it('handles supportsResume and supportsMaxTurns capabilities', () => {
      expect(provider.supportsResume()).toBe(true);
      expect(provider.supportsMaxTurns()).toBe(true);
    });
  });

  describe('Claude Native Permission Composition', () => {
    it('delivers native Claude permissions to .claude/settings.local.json', () => {
      const provider = new ClaudeProvider();
      expect(provider.permissionConfigPaths()).toEqual(['.claude/settings.local.json']);

      const allow = ['Read', 'Write', 'Edit', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(bd:*)', 'Agent'];
      const configs = provider.composePermissionConfig('doer', allow);
      expect(configs).toHaveLength(1);
      const cfg = configs[0] as Record<string, any>;
      expect(cfg.permissions).toBeDefined();
      // Claude consumes its own allow-list syntax verbatim -- no translation layer
      // (unlike AGY's convertClaudeAllowToAgyPermissions), so the composed config
      // must carry the exact same entries the caller passed in.
      expect(cfg.permissions.allow).toEqual(allow);
      // The dispatched agent must never call back into its own fleet MCP server
      // mid-task, and the pm/fleet skills must stay off during a headless dispatch.
      expect(cfg.mcpServers).toEqual({ 'apra-fleet': { disabled: true } });
      expect(cfg.skillOverrides).toEqual({ pm: 'off', fleet: 'off' });
    });
  });

  describe('Claude Exception Classification & Schema Parity', () => {
    it('classifies auth, workspace-trust, overloaded, and server errors distinctly', () => {
      // Auth signatures
      expect(classifyPromptError('Error: 401 Unauthorized')).toBe('auth');
      expect(classifyPromptError('Error: invalid API key')).toBe('auth');
      expect(classifyPromptError('Error: permission_error - not logged in')).toBe('auth');

      // Claude-specific: an untrusted workspace silently drops permissions.allow
      expect(classifyPromptError('Error: this workspace has not been trusted')).toBe('workspace_not_trusted');

      // Subscription usage limit / quota exceeded signatures
      expect(classifyPromptError('Error: 429 Too Many Requests')).toBe('overloaded');
      expect(classifyPromptError('Error: rate limit exceeded')).toBe('overloaded');
      expect(classifyPromptError('Error: Claude AI usage limit reached')).toBe('overloaded');

      // Server / endpoint unreachable signatures
      expect(classifyPromptError('Error: connection refused')).toBe('server');
      expect(classifyPromptError('Error: 500 Internal Server Error')).toBe('server');
      expect(classifyPromptError('Error: dns lookup failed')).toBe('server');
    });
  });

  describe('Claude Stall Detection & Log Resolution', () => {
    it('resolves the Claude project session directory and transcript log path cleanly', () => {
      const workFolder = '/home/user/workspace';
      const home = '/home/user';

      const logDir = resolveSessionLogDir('claude', workFolder, home);
      expect(logDir).toBe(path.join(home, '.claude', 'projects', '-home-user-workspace'));

      const logPath = resolveSessionLogPath('claude', 'sess-claude-999', workFolder, home);
      expect(logPath).toBe(
        path.join(home, '.claude', 'projects', '-home-user-workspace', 'sess-claude-999.jsonl')
      );
    });
  });

  describe('Claude Response Parser', () => {
    it('parses the final type:result event from a JSONL stream', () => {
      const provider = new ClaudeProvider();
      const stdout = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it...' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'Claude Task Completed Successfully', session_id: 'sess-claude-1' }),
      ].join('\n');

      const result = provider.parseResponse({ stdout, stderr: '', code: 0 });
      expect(result.result).toContain('Claude Task Completed Successfully');
      expect(result.sessionId).toBe('sess-claude-1');
      expect(result.isError).toBe(false);
    });
  });
});
