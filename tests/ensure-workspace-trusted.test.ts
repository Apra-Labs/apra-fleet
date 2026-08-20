/**
 * Tests for the ensureWorkspaceTrusted(workFolder) provider-adapter hook
 * (apra-fleet-eft.40.1).
 *
 * Covers:
 * - Claude: seeds trust on a fresh/never-opened member (no ~/.claude.json yet)
 * - Claude: idempotent re-run -- once seeded, a second call is a no-op read-only check
 * - Claude: scoping -- only the exact work_folder key is touched; sibling project
 *   entries and sibling fields on the SAME entry (history, allowedTools) are preserved
 * - Claude: path normalization (backslashes, trailing slash) hits the same entry
 * - Claude: Windows delivery path (PowerShell Get-Content / WriteAllText+Move-Item)
 * - Non-Claude providers (agy, opencode, codex, copilot, none) no-op and never
 *   touch the delivery channel
 */

import { describe, it, expect, vi } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude.js';
import { AgyProvider } from '../src/providers/agy.js';
import { OpenCodeProvider } from '../src/providers/opencode.js';
import { CodexProvider } from '../src/providers/codex.js';
import { CopilotProvider } from '../src/providers/copilot.js';
import { NoneProvider } from '../src/providers/none.js';
import type { SSHExecResult } from '../src/types.js';

/** A fake delivery channel standing in for AgentStrategy.execCommand -- tracks a
 *  single virtual remote file (~/.claude.json) across read/write commands, the same
 *  way the real member-side file would evolve across calls.
 *
 *  apra-fleet-9oo.2: the impl's read command fetches ~/.claude.json AND the project's
 *  .mcp.json in one round-trip, joined by a literal split marker embedded in the
 *  command text itself (`echo "${SPLIT}"` / `Write-Output "${SPLIT}"`). Rather than
 *  hard-coding that marker string here (and drifting if it ever changes), extract it
 *  straight out of the command being executed -- that's what makes this fake robust to
 *  the exact marker value while still exercising the impl's real split-on-substring
 *  parsing. `mcpFileContent` stands in for the project's .mcp.json; pass null/undefined
 *  to simulate no .mcp.json existing at all. */
function makeFakeExec(initialFileContent: string | null, mcpFileContent?: string | null) {
  let fileContent: string | null = initialFileContent;
  const calls: string[] = [];

  const exec = vi.fn(async (cmd: string, _timeoutMs?: number): Promise<SSHExecResult> => {
    calls.push(cmd);

    if (cmd.includes('cat "') || cmd.includes('Get-Content')) {
      const markerMatch = cmd.match(/(?:echo|Write-Output) "([^"]+)"/);
      const marker = markerMatch ? markerMatch[1] : '---FLEET_MCP_SPLIT---';
      return { stdout: `${fileContent ?? ''}\n${marker}\n${mcpFileContent ?? ''}`, stderr: '', code: 0 };
    }

    const heredocMatch = cmd.match(/<< 'FLEET_TRUST_EOF'\n([\s\S]*?)\nFLEET_TRUST_EOF/);
    if (heredocMatch) {
      fileContent = heredocMatch[1];
      return { stdout: '', stderr: '', code: 0 };
    }

    const winMatch = cmd.match(/WriteAllText\("[^"]+", '([\s\S]*?)', \(New-Object/);
    if (winMatch) {
      fileContent = winMatch[1].replace(/''/g, "'");
      return { stdout: '', stderr: '', code: 0 };
    }

    return { stdout: '', stderr: '', code: 0 };
  });

  return { exec, calls, getFileContent: () => fileContent };
}

describe('ClaudeProvider.ensureWorkspaceTrusted (apra-fleet-eft.40.1)', () => {
  it('seeds trust on a fresh member with no ~/.claude.json yet', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec(null);

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.seeded).toBe(true);
    const written = JSON.parse(getFileContent()!);
    expect(written.projects['/home/member/work/project-a'].hasTrustDialogAccepted).toBe(true);
    // Two exec calls: read, then write (atomic tmp-write + mv/rename).
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('seeds trust and merges into an existing ~/.claude.json without disturbing other projects', async () => {
    const provider = new ClaudeProvider();
    const existing = {
      projects: {
        '/home/member/work/other-project': { hasTrustDialogAccepted: true, history: ['unrelated'] },
      },
      someOtherTopLevelKey: 'preserve-me',
    };
    const { exec, getFileContent } = makeFakeExec(JSON.stringify(existing));

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.seeded).toBe(true);
    const written = JSON.parse(getFileContent()!);
    expect(written.projects['/home/member/work/project-a'].hasTrustDialogAccepted).toBe(true);
    // Sibling project entry (and its own fields) untouched -- deep merge, not overwrite.
    expect(written.projects['/home/member/work/other-project']).toEqual({ hasTrustDialogAccepted: true, history: ['unrelated'] });
    expect(written.someOtherTopLevelKey).toBe('preserve-me');
  });

  it('idempotent re-run: a second call on an already-trusted folder does not rewrite the file', async () => {
    const provider = new ClaudeProvider();
    const existing = {
      projects: {
        '/home/member/work/project-a': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
      },
    };
    const { exec, calls, getFileContent } = makeFakeExec(JSON.stringify(existing));

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.seeded).toBe(false);
    // Only the read happens -- no write command issued when trust is already present.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(calls.some(c => c.includes('FLEET_TRUST_EOF') || c.includes('WriteAllText'))).toBe(false);
    // Sibling field on the SAME entry (allowedTools) untouched.
    expect(JSON.parse(getFileContent()!).projects['/home/member/work/project-a'].allowedTools).toEqual(['Bash']);
  });

  it('running seed twice in sequence is idempotent end-to-end', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec(null);

    const first = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');
    expect(first.seeded).toBe(true);
    const afterFirst = getFileContent();

    const second = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');
    expect(second.seeded).toBe(false);
    expect(getFileContent()).toBe(afterFirst);
  });

  it('scopes strictly to the exact work_folder -- never a parent directory', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec(null);

    await provider.ensureWorkspaceTrusted('/home/member/work/project-a/nested', exec, 'linux');

    const written = JSON.parse(getFileContent()!);
    expect(Object.keys(written.projects)).toEqual(['/home/member/work/project-a/nested']);
    expect(written.projects['/home/member/work/project-a']).toBeUndefined();
  });

  it('normalizes backslashes and a trailing slash to the same forward-slash key (Windows path format ground truth)', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec(null);

    await provider.ensureWorkspaceTrusted('C:\\akhil\\git\\project-a\\', exec, 'windows');

    const written = JSON.parse(getFileContent()!);
    expect(Object.keys(written.projects)).toEqual(['C:/akhil/git/project-a']);
  });

  it('a folder passed with a trailing slash re-seeds the SAME entry as without one (idempotency across representations)', async () => {
    const provider = new ClaudeProvider();
    const existing = { projects: { '/home/member/work/project-a': { hasTrustDialogAccepted: true } } };
    const { exec } = makeFakeExec(JSON.stringify(existing));

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a/', exec, 'linux');
    expect(result.seeded).toBe(false);
  });

  it('uses the Windows delivery path (Get-Content / WriteAllText+Move-Item) when agentOs is windows', async () => {
    const provider = new ClaudeProvider();
    const { exec, calls, getFileContent } = makeFakeExec(null);

    await provider.ensureWorkspaceTrusted('C:/akhil/git/project-a', exec, 'windows');

    expect(calls.some(c => c.includes('Get-Content'))).toBe(true);
    expect(calls.some(c => c.includes('WriteAllText') && c.includes('Move-Item'))).toBe(true);
    expect(JSON.parse(getFileContent()!).projects['C:/akhil/git/project-a'].hasTrustDialogAccepted).toBe(true);
  });

  it('tolerates a corrupted/unparseable ~/.claude.json by starting fresh instead of throwing', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec('not-json-at-all{{{');

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.seeded).toBe(true);
    expect(JSON.parse(getFileContent()!).projects['/home/member/work/project-a'].hasTrustDialogAccepted).toBe(true);
  });
});

describe('ClaudeProvider.ensureWorkspaceTrusted -- enabledMcpjsonServers seeding (apra-fleet-9oo.2, regression for apra-fleet-9oo.1)', () => {
  const mcpJson = JSON.stringify({ mcpServers: { serverA: {}, serverB: {} } });

  it('fresh member: seeds every server name declared in .mcp.json into enabledMcpjsonServers', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec(null, mcpJson);

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.seeded).toBe(true);
    expect(result.mcpServersSeeded).toEqual(['serverA', 'serverB']);
    const written = JSON.parse(getFileContent()!);
    expect(written.projects['/home/member/work/project-a'].enabledMcpjsonServers).toEqual(['serverA', 'serverB']);
  });

  it('already-trusted member missing servers still gets them seeded (guards against the old early return)', async () => {
    const provider = new ClaudeProvider();
    const existing = {
      projects: {
        '/home/member/work/project-a': { hasTrustDialogAccepted: true },
      },
    };
    const { exec, getFileContent } = makeFakeExec(JSON.stringify(existing), mcpJson);

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    // Trust was already present, so `seeded` (trust-seeded) stays false, but the
    // servers must still be added -- this is exactly the bug apra-fleet-9oo.1 fixed.
    expect(result.seeded).toBe(false);
    expect(result.mcpServersSeeded).toEqual(['serverA', 'serverB']);
    const written = JSON.parse(getFileContent()!);
    expect(written.projects['/home/member/work/project-a'].hasTrustDialogAccepted).toBe(true);
    expect(written.projects['/home/member/work/project-a'].enabledMcpjsonServers).toEqual(['serverA', 'serverB']);
  });

  it('deny wins: a server listed in disabledMcpjsonServers is never added', async () => {
    const provider = new ClaudeProvider();
    const existing = {
      projects: {
        '/home/member/work/project-a': { hasTrustDialogAccepted: true, disabledMcpjsonServers: ['serverB'] },
      },
    };
    const { exec, getFileContent } = makeFakeExec(JSON.stringify(existing), mcpJson);

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.mcpServersSeeded).toEqual(['serverA']);
    const written = JSON.parse(getFileContent()!);
    expect(written.projects['/home/member/work/project-a'].enabledMcpjsonServers).toEqual(['serverA']);
    // The deny list itself is untouched -- still exactly what the human set.
    expect(written.projects['/home/member/work/project-a'].disabledMcpjsonServers).toEqual(['serverB']);
  });

  it('union-merges into a pre-existing enabledMcpjsonServers list instead of clobbering it', async () => {
    const provider = new ClaudeProvider();
    const existing = {
      projects: {
        '/home/member/work/project-a': { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['humanAdded'] },
      },
    };
    const { exec, getFileContent } = makeFakeExec(JSON.stringify(existing), mcpJson);

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.mcpServersSeeded).toEqual(['serverA', 'serverB']);
    const written = JSON.parse(getFileContent()!);
    // The human's pre-existing entry is preserved (union), not replaced, and new
    // servers are appended in declaration order after it.
    expect(written.projects['/home/member/work/project-a'].enabledMcpjsonServers).toEqual(['humanAdded', 'serverA', 'serverB']);
  });

  it('idempotent re-run over the post-write state: no duplicates, no clobbering of sibling/other-project fields', async () => {
    const provider = new ClaudeProvider();
    const existing = {
      projects: {
        '/home/member/work/project-a': { hasTrustDialogAccepted: true, history: ['unrelated'] },
        '/home/member/work/other-project': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
      },
    };
    const { exec, getFileContent } = makeFakeExec(JSON.stringify(existing), mcpJson);

    const first = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');
    expect(first.mcpServersSeeded).toEqual(['serverA', 'serverB']);

    const second = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');
    expect(second.seeded).toBe(false);
    expect(second.mcpServersSeeded).toEqual([]);

    const written = JSON.parse(getFileContent()!);
    // No duplicates from the second pass.
    expect(written.projects['/home/member/work/project-a'].enabledMcpjsonServers).toEqual(['serverA', 'serverB']);
    // Sibling field on the SAME entry untouched.
    expect(written.projects['/home/member/work/project-a'].history).toEqual(['unrelated']);
    // Other project's entry untouched.
    expect(written.projects['/home/member/work/other-project']).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Bash'] });
  });

  it('missing .mcp.json degrades to trust-only behaviour without throwing', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec(null, null);

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.seeded).toBe(true);
    expect(result.mcpServersSeeded).toEqual([]);
    const written = JSON.parse(getFileContent()!);
    expect(written.projects['/home/member/work/project-a'].hasTrustDialogAccepted).toBe(true);
    expect(written.projects['/home/member/work/project-a'].enabledMcpjsonServers).toBeUndefined();
  });

  it('unparseable .mcp.json degrades to trust-only behaviour without throwing', async () => {
    const provider = new ClaudeProvider();
    const { exec, getFileContent } = makeFakeExec(null, 'not-json-at-all{{{');

    const result = await provider.ensureWorkspaceTrusted('/home/member/work/project-a', exec, 'linux');

    expect(result.seeded).toBe(true);
    expect(result.mcpServersSeeded).toEqual([]);
    const written = JSON.parse(getFileContent()!);
    expect(written.projects['/home/member/work/project-a'].hasTrustDialogAccepted).toBe(true);
    expect(written.projects['/home/member/work/project-a'].enabledMcpjsonServers).toBeUndefined();
  });
});

describe('ensureWorkspaceTrusted no-ops for non-Claude providers (apra-fleet-eft.40 provider trust matrix)', () => {
  const cases: Array<[string, () => { ensureWorkspaceTrusted: any }]> = [
    ['agy', () => new AgyProvider()],
    ['opencode', () => new OpenCodeProvider()],
    ['codex', () => new CodexProvider()],
    ['copilot', () => new CopilotProvider()],
    ['none', () => new NoneProvider()],
  ];

  for (const [name, make] of cases) {
    it(`${name}: returns seeded:false and never touches the delivery channel`, async () => {
      const provider = make();
      const exec = vi.fn(async (): Promise<SSHExecResult> => ({ stdout: '', stderr: '', code: 0 }));

      const result = await provider.ensureWorkspaceTrusted('/some/work/folder', exec, 'linux');

      expect(result.seeded).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });
  }
});
