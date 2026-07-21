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
 * - Non-Claude providers (gemini, agy, opencode, codex, copilot, none) no-op and never
 *   touch the delivery channel
 */

import { describe, it, expect, vi } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { AgyProvider } from '../src/providers/agy.js';
import { OpenCodeProvider } from '../src/providers/opencode.js';
import { CodexProvider } from '../src/providers/codex.js';
import { CopilotProvider } from '../src/providers/copilot.js';
import { NoneProvider } from '../src/providers/none.js';
import type { SSHExecResult } from '../src/types.js';

/** A fake delivery channel standing in for AgentStrategy.execCommand -- tracks a
 *  single virtual remote file (~/.claude.json) across read/write commands, the same
 *  way the real member-side file would evolve across calls. */
function makeFakeExec(initialFileContent: string | null) {
  let fileContent: string | null = initialFileContent;
  const calls: string[] = [];

  const exec = vi.fn(async (cmd: string, _timeoutMs?: number): Promise<SSHExecResult> => {
    calls.push(cmd);

    if (cmd.includes('cat "') || cmd.includes('Get-Content')) {
      return { stdout: fileContent ?? '', stderr: '', code: 0 };
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

describe('ensureWorkspaceTrusted no-ops for non-Claude providers (apra-fleet-eft.40 provider trust matrix)', () => {
  const cases: Array<[string, () => { ensureWorkspaceTrusted: any }]> = [
    ['gemini', () => new GeminiProvider()],
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
