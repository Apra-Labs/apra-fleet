import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry } from '../test-helpers.js';
import { addAgent, getAgent } from '../../src/services/registry.js';
import { getProvider } from '../../src/providers/index.js';
import { AgyProvider, convertClaudeAllowToAgyPermissions } from '../../src/providers/agy.js';
import { resolveSessionLogPath, resolveSessionLogDir } from '../../src/services/stall/log-path-resolver.js';
import { classifyPromptError } from '../../src/utils/prompt-errors.js';

describe('AGY Integration Suite (agy-integration-tests)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  describe('AGY Member Registration & Provider Mapping', () => {
    it('registers an AGY member and maps to AgyProvider', () => {
      const member = makeTestAgent({
        id: 'agy-member-001',
        friendlyName: 'fleet-lin-agy',
        llmProvider: 'agy',
        os: 'linux',
      });
      addAgent(member);

      const resolved = getAgent('agy-member-001');
      expect(resolved).toBeDefined();
      expect(resolved?.llmProvider).toBe('agy');

      const provider = getProvider('agy');
      expect(provider).toBeInstanceOf(AgyProvider);
      expect(provider.name).toBe('agy');
      expect(provider.processName).toBe('agy');
      expect(provider.instructionFileName).toBe('AGY.md');
    });
  });

  describe('AGY Command Construction & Features (Session, Resume, Turns)', () => {
    const provider = new AgyProvider();

    it('builds non-interactive agy prompt command with model, --output-format json, and dangerously-skip-permissions', () => {
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/workspace',
        promptFile: '.fleet-task.md',
        model: 'Gemini 3.5 Flash',
        unattended: 'dangerous',
      });
      expect(cmd).toContain('agy --model');
      expect(cmd).toContain('--output-format json');
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).toContain('Your task is described in /home/user/workspace/.fleet-task.md');
    });

    it('supports session resumption via --conversation flag', () => {
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/workspace',
        promptFile: '.fleet-task.md',
        sessionId: 'sess-agy-12345',
        resuming: true,
      });
      expect(cmd).toContain('--conversation "sess-agy-12345"');
    });

    it('maps tier preferences seamlessly across cheap, standard, and premium', () => {
      expect(provider.modelForTier('cheap')).toBe('gemini-3.5-flash-lite');
      expect(provider.modelForTier('standard')).toBe('gemini-3.5-flash');
      expect(provider.modelForTier('premium')).toBe('claude-sonnet-4.6');
    });

    it('handles supportsResume and supportsMaxTurns capabilities', () => {
      expect(provider.supportsResume()).toBe(true);
      expect(provider.supportsMaxTurns()).toBe(false);
    });
  });

  describe('AGY Native Permission Composition', () => {
    it('converts Claude allow lists into AGY native permission rule objects', () => {
      const claudeAllow = ['Read', 'Write', 'Edit', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(bd:*)', 'Agent'];
      const rules = convertClaudeAllowToAgyPermissions(claudeAllow);

      expect(rules).toEqual([
        { action: 'read_file', target: '*' },
        { action: 'write_file', target: '*' },
        { action: 'command', target: 'git' },
        { action: 'command', target: 'npm' },
        { action: 'command', target: 'bd' },
        { action: 'invoke_subagent', target: '*' },
        { action: 'send_message', target: '*' },
      ]);
    });

    it('refuses to auto-collapse mcp__<server>__<tool> entries into a broad server-level mcp rule', () => {
      // AGY's permission model is server-granular, and 'apra-fleet' colocates safe
      // KB tools with destructive fleet-admin tools (remove_member, shutdown_server,
      // credential_store_*) on the same server -- collapsing a narrow per-tool grant
      // like kb_query into { action: 'mcp', target: 'apra-fleet' } would silently
      // hand out access to all of them. This must fall through to an explicit
      // 'custom' rule (surfaced for manual escalation) instead of a 'mcp' rule.
      const claudeAllow = [
        'mcp__apra-fleet__kb_session_prime',
        'mcp__apra-fleet__kb_query',
        'mcp__apra-fleet__kb_capture',
      ];
      const rules = convertClaudeAllowToAgyPermissions(claudeAllow);

      expect(rules.some((r) => r.action === 'mcp')).toBe(false);
      expect(rules).toEqual(
        claudeAllow.map((item) => ({ action: 'custom', target: item })),
      );
    });

    it('delivers native AGY permissions to .gemini/antigravity-cli/settings.json', () => {
      const provider = new AgyProvider();
      expect(provider.permissionConfigPaths()).toEqual(['.gemini/antigravity-cli/settings.json']);

      const configs = provider.composePermissionConfig('doer', ['Read', 'Write', 'Bash(git:*)', 'WebSearch', 'CustomToken']);
      expect(configs).toHaveLength(1);
      const cfg = configs[0] as Record<string, any>;
      expect(cfg.permissions).toBeDefined();
      expect(cfg.permissions.allow).toContainEqual({ action: 'read_file', target: '*' });
      expect(cfg.permissions.allow).toContainEqual({ action: 'write_file', target: '*' });
      expect(cfg.permissions.allow).toContainEqual({ action: 'command', target: 'git' });
      expect(cfg.permissions.allow).toContainEqual({ action: 'read_url', target: '*' });
      expect(cfg.permissions.allow).toContainEqual({ action: 'custom', target: 'CustomToken' });
    });
  });

  describe('AGY Exception Classification & 1:1 Schema Parity', () => {
    it('classifies auth errors distinctly from endpoint unreachable and quota errors', () => {
      // Auth signatures
      expect(classifyPromptError('Error: 401 Unauthorized')).toBe('auth');
      expect(classifyPromptError('Error: invalid API key')).toBe('auth');
      expect(classifyPromptError('Error: permission_error - not logged in')).toBe('auth');
      expect(classifyPromptError('Error: ANTIGRAVITY_API_KEY is missing or invalid')).toBe('auth');

      // Subscription Usage Limit / Quota Exceeded signatures
      expect(classifyPromptError('Error: 429 Too Many Requests')).toBe('overloaded');
      expect(classifyPromptError('Error: rate limit exceeded')).toBe('overloaded');
      expect(classifyPromptError('Error: quota exceeded')).toBe('overloaded');
      expect(classifyPromptError('Error: resource_exhausted - subscription usage limit reached')).toBe('overloaded');
      expect(classifyPromptError('Error: credit limit reached for current billing cycle')).toBe('overloaded');

      // Server / Endpoint Unreachable signatures
      expect(classifyPromptError('Error: connection refused')).toBe('server');
      expect(classifyPromptError('Error: endpoint not reachable')).toBe('server');
      expect(classifyPromptError('Error: 503 Service Unavailable')).toBe('server');
      expect(classifyPromptError('Error: dial tcp: no route to host')).toBe('server');
      expect(classifyPromptError('Error: dns lookup failed')).toBe('server');
    });
  });

  describe('AGY Stall Detection & Log Resolution', () => {
    it('resolves AGY brain directory and transcript log path cleanly', () => {
      const brainDir = resolveSessionLogDir('agy', '/home/user', '/home/user');
      expect(brainDir).toBe(path.join('/home/user', '.gemini', 'antigravity-cli', 'brain'));

      const logPath = resolveSessionLogPath('agy', 'sess-agy-999', '/home/user', '/home/user');
      expect(logPath).toBe(
        path.join('/home/user', '.gemini', 'antigravity-cli', 'brain', 'sess-agy-999', '.system_generated', 'logs', 'transcript.jsonl')
      );
    });
  });

  describe('AGY Response Parser', () => {
    it('parses native --output-format json envelope with conversation_id and token usage', () => {
      const provider = new AgyProvider();
      const envelope = {
        conversation_id: '52f769e2-d98f-499b-8535-b389b7a7d1a1',
        status: 'SUCCESS',
        response: 'AGY Task Completed Successfully via Native JSON',
        usage: {
          input_tokens: 16397,
          output_tokens: 532,
          total_tokens: 16929,
        },
      };
      const stdout = `FLEET_PID:12345\n${JSON.stringify(envelope)}`;

      const result = provider.parseResponse({ stdout, stderr: '', code: 0 });
      expect(result.result).toContain('AGY Task Completed Successfully via Native JSON');
      expect(result.sessionId).toBe('52f769e2-d98f-499b-8535-b389b7a7d1a1');
      expect(result.isError).toBe(false);
      expect(result.usage).toEqual({
        input_tokens: 16397,
        output_tokens: 532,
      });
    });

    it('parses assistant output from legacy JSONL lines as fallback', () => {
      const provider = new AgyProvider();
      const stdout = [
        'FLEET_PID:12345',
        '{"step_index":1,"source":"MODEL","type":"GENERIC","content":"AGY Task Completed Successfully","created_at":"2026-08-05T05:13:28Z"}',
      ].join('\n');

      const result = provider.parseResponse({ stdout, stderr: '', code: 0 });
      expect(result.result).toContain('AGY Task Completed Successfully');
      expect(result.isError).toBe(false);
    });
  });
});
