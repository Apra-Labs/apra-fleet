import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { kbCommitCmd, parseKbCommitArgs, type KbExportFn } from '../../src/cli/kb-commit.js';

// T3.7b (PM-added, closes yashr-8wy + Phase 2 LOW-1 dangling reference):
// `apra-fleet kb commit [--repo <path>] [--global]`. This is the
// manual/recovery path that the amended-D5 fleet_status bible-drift anomaly
// message names -- a thin wrapper around kb_export (T2.3/T3.3), which
// already owns every commit/no-commit decision. kbExport is mocked here
// (structural KbExportFn type) so these tests never touch a real KB or git.

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseKbCommitArgs', () => {
  it('defaults to project scope (no --repo, no --global)', () => {
    expect(parseKbCommitArgs([])).toEqual({ repo: undefined, global: false });
  });

  it('parses --repo <path>', () => {
    expect(parseKbCommitArgs(['--repo', '/some/path'])).toEqual({ repo: '/some/path', global: false });
  });

  it('parses --global', () => {
    expect(parseKbCommitArgs(['--global'])).toEqual({ repo: undefined, global: true });
  });

  it('parses --repo and --global together, in either order', () => {
    expect(parseKbCommitArgs(['--repo', '/x', '--global'])).toEqual({ repo: '/x', global: true });
    expect(parseKbCommitArgs(['--global', '--repo', '/x'])).toEqual({ repo: '/x', global: true });
  });

  it('ignores a trailing --repo with no value', () => {
    expect(parseKbCommitArgs(['--repo'])).toEqual({ repo: undefined, global: false });
  });
});

describe('kbCommitCmd', () => {
  it('defaults to project scope and reports the export + commit result', async () => {
    const exportFn: KbExportFn = vi.fn(async () =>
      JSON.stringify({ exported: 5, path: '.fleet/kb-canonical.json', scope: 'project', committed: true })
    );
    const code = await kbCommitCmd(exportFn, []);
    expect(code).toBe(0);
    expect(exportFn).toHaveBeenCalledWith({ repo_path: undefined, scope: 'project' });
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Exported 5 entries');
    expect(output).toContain('.fleet/kb-canonical.json');
    expect(output).toContain('scope=project');
    expect(output).toContain('Committed');
  });

  it('passes --global through as scope=global', async () => {
    const exportFn: KbExportFn = vi.fn(async () =>
      JSON.stringify({ exported: 2, path: '.fleet/kb-canonical-global.json', scope: 'global', committed: false })
    );
    const code = await kbCommitCmd(exportFn, ['--global']);
    expect(code).toBe(0);
    expect(exportFn).toHaveBeenCalledWith({ repo_path: undefined, scope: 'global' });
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('scope=global');
    expect(output).toContain('Not committed');
  });

  it('passes --repo through as repo_path', async () => {
    const exportFn: KbExportFn = vi.fn(async () =>
      JSON.stringify({ exported: 0, path: '.fleet/kb-canonical.json', scope: 'project', committed: false })
    );
    const code = await kbCommitCmd(exportFn, ['--repo', '/tmp/some-repo']);
    expect(code).toBe(0);
    expect(exportFn).toHaveBeenCalledWith({ repo_path: '/tmp/some-repo', scope: 'project' });
  });

  it('reports "Not committed" wording for a no-op export (no change / autoCommit off / not a git repo)', async () => {
    const exportFn: KbExportFn = vi.fn(async () =>
      JSON.stringify({ exported: 3, path: '.fleet/kb-canonical.json', scope: 'project', committed: false })
    );
    const code = await kbCommitCmd(exportFn, []);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Not committed/);
  });

  it('errors (exit 1) and prints the message when kbExport rejects (e.g. invalid --repo path)', async () => {
    const exportFn: KbExportFn = vi.fn(async () => {
      throw new Error('repo path does not exist: /nope');
    });
    const code = await kbCommitCmd(exportFn, ['--repo', '/nope']);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('repo path does not exist');
  });

  it('errors (exit 1) when kbExport returns malformed JSON', async () => {
    const exportFn: KbExportFn = vi.fn(async () => 'not json');
    const code = await kbCommitCmd(exportFn, []);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });
});
