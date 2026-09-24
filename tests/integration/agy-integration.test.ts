import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry } from '../test-helpers.js';
import { addAgent, getAgent } from '../../src/services/registry.js';
import { getProvider } from '../../src/providers/index.js';
import { AgyProvider, convertClaudeAllowToAgyPermissions, formatAgyPermissionRules } from '../../src/providers/agy.js';
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
      expect(cmd).toContain('agy --add-dir "/home/user/workspace" --model');
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

    it('maps tier preferences to model ids AGY actually offers', () => {
      // Pinned against `agy models` (1.2.8). A slug AGY does not recognize is
      // NOT a soft fallback -- the dispatch returns
      //   "invalid model selection (--model ...): model ... is not recognized"
      // as its entire response, which the engine surfaces as unparseable
      // structured output. The cheap tier is what doers run on, so a stale
      // cheap slug silently costs a sprint every line of code it would write.
      expect(provider.modelForTier('cheap')).toBe('gemini-3.8-flash-low');
      expect(provider.modelForTier('standard')).toBe('gemini-3.8-flash-high');
      expect(provider.modelForTier('premium')).toBe('gemini-3.1-pro-high');
    });

    it('dispatches the SAME model id it reports for a tier (the two catalogs cannot drift)', () => {
      // The original defect was two parallel maps: display names for dispatch,
      // slugs for modelForTier(). They drifted, and only the dispatch one was
      // load-bearing, so nothing caught it.
      for (const tier of ['cheap', 'standard', 'premium'] as const) {
        const cmd = provider.buildPromptCommand({
          folder: '/home/user/project',
          promptFile: '.fleet-task.md',
          tier,
        });
        expect(cmd).toContain(`--model "${provider.modelForTier(tier)}"`);
      }
      expect(provider.modelTiers()).toEqual({
        cheap: provider.modelForTier('cheap'),
        standard: provider.modelForTier('standard'),
        premium: provider.modelForTier('premium'),
      });
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

    it('maps mcp__<server>__<tool> to AGY\'s equally narrow per-tool mcp(server/tool) rule', () => {
      // AGY expresses per-tool MCP grants as mcp(<server>/<tool>) -- the exact
      // granularity Claude's mcp__<server>__<tool> carries, so the mapping
      // widens nothing. Before this, the tokens were dropped and the
      // deployer's Step 0 kb_session_prime was auto-denied in headless mode,
      // failing the whole Deploy phase.
      const claudeAllow = [
        'mcp__apra-fleet__kb_session_prime',
        'mcp__apra-fleet__kb_query',
        'mcp__apra-fleet__kb_capture',
      ];
      const rules = convertClaudeAllowToAgyPermissions(claudeAllow);

      expect(rules).toEqual([
        { action: 'mcp', target: 'apra-fleet/kb_session_prime' },
        { action: 'mcp', target: 'apra-fleet/kb_query' },
        { action: 'mcp', target: 'apra-fleet/kb_capture' },
      ]);
      expect(formatAgyPermissionRules(rules)).toEqual([
        'mcp(apra-fleet/kb_session_prime)',
        'mcp(apra-fleet/kb_query)',
        'mcp(apra-fleet/kb_capture)',
      ]);
    });

    it('never widens a per-tool grant into blanket server-level MCP access', () => {
      // 'apra-fleet' colocates safe read-only KB tools with destructive
      // fleet-admin ones (remove_member, shutdown_server, credential_store_*),
      // so a bare mcp(apra-fleet) rule would hand out all of them.
      const allow = formatAgyPermissionRules(
        convertClaudeAllowToAgyPermissions(['mcp__apra-fleet__kb_query']),
      );
      expect(allow).not.toContain('mcp(apra-fleet)');
      expect(allow).not.toContain('mcp(*)');
      expect(allow).toEqual(['mcp(apra-fleet/kb_query)']);
    });

    it('delivers native AGY permissions to the HOME-anchored project config, not settings.json', () => {
      const provider = new AgyProvider();
      const mockAgent = {
        id: 'agent-123',
        friendlyName: 'agy-doer',
        llmProvider: 'agy',
        workFolder: '/home/user/my-project',
      } as any;
      expect(provider.permissionConfigPaths(mockAgent)).toEqual(['~/.gemini/config/projects/fleet-agent-123.json']);
      expect(() => provider.permissionConfigPaths()).toThrow();

      const configs = provider.composePermissionConfig('doer', ['Read', 'Write', 'Bash(git:*)', 'WebSearch', 'CustomToken'], mockAgent);
      expect(configs).toHaveLength(1);
      const cfg = configs[0] as Record<string, any>;
      expect(cfg.id).toBe('fleet-agent-123');
      expect(cfg.name).toBe('/home/user/my-project');
      expect(cfg.projectResources.resources).toEqual([
        { gitFolder: { folderUri: 'file:///home/user/my-project', allowWrite: true } },
      ]);
      expect(cfg.permissionGrants).toBeDefined();
      // Strings in AGY's own `action(target)` syntax -- NOT {action,target}
      // objects, which AGY's settings parser silently ignores.
      const allowList = cfg.permissionGrants.permissionGrants.allow;
      expect(allowList).toContain('read_file(*)');
      expect(allowList).toContain('write_file(*)');
      expect(allowList).toContain('command(git)');
      expect(allowList).toContain('read_url(*)');
      // 'custom' is not in AGY's action vocabulary -- it must not be written.
      expect(allowList.some((e: string) => e.includes('CustomToken'))).toBe(false);
    });

    it('serializes every rule as a string matching AGY\'s own settings.json validation regex', () => {
      // Verbatim from the agy CLI binary (1.2.8): any entry in permissions.allow
      // that fails this regex is rejected by AGY.
      const AGY_RULE_RE = /^(command|read_file|write_file|read_url|mcp|execute_url|unsandboxed)\s*\(.*\)$/;
      const allow = formatAgyPermissionRules(
        convertClaudeAllowToAgyPermissions(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(bd:*)', 'WebSearch', 'Mcp(some-server)']),
      );
      expect(allow.length).toBeGreaterThan(0);
      for (const entry of allow) {
        expect(typeof entry).toBe('string');
        expect(entry).toMatch(AGY_RULE_RE);
      }
      expect(allow).toEqual([
        'read_file(*)',
        'write_file(*)',
        'command(git)',
        'command(npm)',
        'command(bd)',
        'read_url(*)',
        'mcp(some-server)',
      ]);
    });

    it('drops rules whose action is outside AGY\'s vocabulary instead of writing entries AGY rejects', () => {
      // 'Agent' maps to invoke_subagent/send_message and an unmapped token maps
      // to 'custom' -- none of which are AGY permission actions (they are tool
      // names, or a fleet-internal marker). Writing them into the MACHINE-GLOBAL
      // settings.json the human user also owns is not a harmless no-op.
      const rules = convertClaudeAllowToAgyPermissions(['Agent', 'NotAToolToken', 'Bash(git:*)']);
      expect(rules.some(r => r.action === 'invoke_subagent')).toBe(true);
      expect(rules.some(r => r.action === 'custom')).toBe(true);
      expect(formatAgyPermissionRules(rules)).toEqual(['command(git)']);
    });

    it('de-duplicates identical rules produced by different Claude tokens', () => {
      // Read + Glob + Grep all collapse to read_file(*); the file must not carry
      // the same rule three times.
      expect(formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(['Read', 'Glob', 'Grep']))).toEqual(['read_file(*)']);
    });

    it('names the dispatched work folder as the AGY workspace via --add-dir', () => {
      const provider = new AgyProvider();
      // AGY does NOT adopt the process cwd as its workspace: without --add-dir
      // it runs with no workspace, shells out from its own scratch dir, and
      // dies on the first auto-denied run_command in headless mode.
      expect(provider.workspaceDirFlag('/home/user/workspace')).toBe('--add-dir "/home/user/workspace"');
      const cmd = provider.buildPromptCommand({
        folder: '/home/user/my repo',
        promptFile: '.fleet-task.md',
      });
      expect(cmd).toContain('--add-dir "/home/user/my repo"');
      // The cd is retained so relative paths the agent builds still resolve.
      expect(cmd.startsWith('cd "/home/user/my repo" && agy ')).toBe(true);
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
