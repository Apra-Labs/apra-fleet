// File-transfer cross-OS matrix.
// Any change to src/tools/send-files.ts, src/tools/receive-files.ts,
// src/services/strategy.ts, or src/services/sftp.ts MUST keep this matrix passing.
// If you add a new (fleet host, target) combination, add a row here first.
// Bug history: PR #97 silently broke Linux→Windows transfers because no
// test in this matrix existed for that combination — see issue #220.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as sshModule from '../src/services/ssh.js';
import { uploadViaSFTP, downloadViaSFTP } from '../src/services/sftp.js';
import { resolveRemotePath } from '../src/utils/platform.js';
import { makeTestAgent } from './test-helpers.js';

vi.mock('../src/services/ssh.js');

describe('File-transfer cross-OS matrix', () => {
  let mockFastPut: ReturnType<typeof vi.fn>;
  let mockFastGet: ReturnType<typeof vi.fn>;
  let mockMkdir: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation((() => undefined) as any);

    mockMkdir = vi.fn((_p: string, cb: Function) => cb(null));
    mockFastPut = vi.fn((_local: string, _remote: string, cb: Function) => cb(null));
    mockFastGet = vi.fn((_remote: string, _local: string, cb: Function) => cb(null));

    vi.mocked(sshModule.getConnection).mockResolvedValue({
      sftp: (cb: Function) => cb(null, { mkdir: mockMkdir, fastPut: mockFastPut, fastGet: mockFastGet }),
    } as any);
  });

  afterEach(() => vi.restoreAllMocks());

  // ── resolveRemotePath unit tests ─────────────────────────────────────────

  describe('resolveRemotePath', () => {
    it('Linux workFolder + relative subpath', () => {
      expect(resolveRemotePath('/home/user/project', '_staging'))
        .toBe('/home/user/project/_staging');
    });

    it('Linux workFolder + dotted relative path', () => {
      expect(resolveRemotePath('/home/user/project', '.claude/skills/mapper/SKILL.md'))
        .toBe('/home/user/project/.claude/skills/mapper/SKILL.md');
    });

    it('Linux workFolder + absolute path (absolute wins)', () => {
      expect(resolveRemotePath('/home/user/project', '/absolute/file.txt'))
        .toBe('/absolute/file.txt');
    });

    it('Windows workFolder with backslashes + relative subpath', () => {
      expect(resolveRemotePath('C:\\Users\\Kashyap\\repos', '_staging'))
        .toBe('C:/Users/Kashyap/repos/_staging');
    });

    it('Windows workFolder with forward slashes + relative subpath', () => {
      expect(resolveRemotePath('C:/Users/Kashyap/repos', '_staging'))
        .toBe('C:/Users/Kashyap/repos/_staging');
    });

    it('Windows workFolder + dotted relative path', () => {
      expect(resolveRemotePath('C:/Users/Kashyap/repos', '.claude/skills/mapper/SKILL.md'))
        .toBe('C:/Users/Kashyap/repos/.claude/skills/mapper/SKILL.md');
    });

    it('Windows workFolder + absolute Windows subpath with forward slashes', () => {
      expect(resolveRemotePath('C:/Users/Kashyap/repos', 'C:/Users/Kashyap/repos/_staging/SKILL.md'))
        .toBe('C:/Users/Kashyap/repos/_staging/SKILL.md');
    });

    it('Windows workFolder + absolute Windows subpath with backslashes', () => {
      expect(resolveRemotePath('C:\\Users\\Kashyap\\repos', 'C:\\Users\\Kashyap\\repos\\_staging\\SKILL.md'))
        .toBe('C:/Users/Kashyap/repos/_staging/SKILL.md');
    });

    it('does NOT prepend Linux CWD to Windows paths (regression guard)', () => {
      const result = resolveRemotePath('C:\\Users\\Kashyap\\repos', '_staging');
      expect(result).not.toMatch(/^\/.*\/C:/);
      expect(result).toBe('C:/Users/Kashyap/repos/_staging');
    });
  });

  // ── Linux fleet host → remote Linux member (SFTP) ────────────────────────────
  //
  // | Driver | Target      | send_files | receive_files |
  // | Linux  | remote Linux| required   | required      |

  describe('Linux fleet host → remote Linux member (SFTP)', () => {
    const agent = () => makeTestAgent({ workFolder: '/home/user/project' });

    it('send_files: no dest_subdir → uploads to workFolder root', async () => {
      await uploadViaSFTP(agent(), ['/local/test.txt']);
      expect(mockFastPut).toHaveBeenCalledWith(
        '/local/test.txt',
        '/home/user/project/test.txt',
        expect.any(Function)
      );
    });

    it('send_files: relative dest_subdir → correct remote path', async () => {
      await uploadViaSFTP(agent(), ['/local/test.txt'], '_staging');
      expect(mockFastPut).toHaveBeenCalledWith(
        '/local/test.txt',
        '/home/user/project/_staging/test.txt',
        expect.any(Function)
      );
    });

    it('receive_files: relative remote_path → resolves against workFolder', async () => {
      await downloadViaSFTP(agent(), ['_staging/test.txt'], '/tmp/local');
      expect(mockFastGet).toHaveBeenCalledWith(
        '/home/user/project/_staging/test.txt',
        expect.any(String),
        expect.any(Function)
      );
    });

    it('receive_files: dotted relative path → resolves correctly', async () => {
      await downloadViaSFTP(agent(), ['.claude/skills/mapper/SKILL.md'], '/tmp/local');
      expect(mockFastGet).toHaveBeenCalledWith(
        '/home/user/project/.claude/skills/mapper/SKILL.md',
        expect.any(String),
        expect.any(Function)
      );
    });
  });

  // ── Linux fleet host → remote Windows member (SFTP) ──────────────────────────
  //
  // | Driver | Target         | send_files | receive_files |
  // | Linux  | remote Windows | required   | required      |   ← was missing; see issue #220
  //
  // All 5 repro cases from requirements.md are covered below.

  describe('Linux fleet host → remote Windows member (SFTP)', () => {
    const WIN_WORK_FOLDER = 'C:\\Users\\Kashyap\\bkp\\source\\repos\\incytes-app-30';
    const agent = () => makeTestAgent({ workFolder: WIN_WORK_FOLDER });

    // Repro Case 4 — send_files, dest_subdir = '_staging'
    it('send_files: relative dest_subdir → correct Windows remote path (Case 4)', async () => {
      await uploadViaSFTP(agent(), ['/tmp/regenmed-skill-update/SKILL.md'], '_staging');
      expect(mockFastPut).toHaveBeenCalledWith(
        '/tmp/regenmed-skill-update/SKILL.md',
        'C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging/SKILL.md',
        expect.any(Function)
      );
    });

    // Repro Case 5 — send_files with freshly named copy
    it('send_files: freshly named copy → correct Windows remote path (Case 5)', async () => {
      await uploadViaSFTP(agent(), ['/tmp/regenmed-skill-update/SKILL_v2.md'], '_staging');
      expect(mockFastPut).toHaveBeenCalledWith(
        '/tmp/regenmed-skill-update/SKILL_v2.md',
        'C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging/SKILL_v2.md',
        expect.any(Function)
      );
    });

    // Repro Case 1 — receive_files with dotted relative path
    it('receive_files: dotted relative path → correct Windows remote path (Case 1)', async () => {
      await downloadViaSFTP(
        agent(),
        ['.claude/skills/fhir-regenmed-mapper/SKILL.md'],
        '/tmp/regenmed-skill-update'
      );
      expect(mockFastGet).toHaveBeenCalledWith(
        'C:/Users/Kashyap/bkp/source/repos/incytes-app-30/.claude/skills/fhir-regenmed-mapper/SKILL.md',
        expect.any(String),
        expect.any(Function)
      );
    });

    // Repro Case 2 — receive_files with non-dotted relative path
    it('receive_files: non-dotted relative path → correct Windows remote path (Case 2)', async () => {
      await downloadViaSFTP(
        agent(),
        ['_staging/SKILL.md'],
        '/tmp/regenmed-skill-update'
      );
      expect(mockFastGet).toHaveBeenCalledWith(
        'C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging/SKILL.md',
        expect.any(String),
        expect.any(Function)
      );
    });

    // Repro Case 3 — receive_files with absolute Windows path (backslashes)
    it('receive_files: absolute Windows path (backslashes) → correct path (Case 3)', async () => {
      await downloadViaSFTP(
        agent(),
        ['C:\\Users\\Kashyap\\bkp\\source\\repos\\incytes-app-30\\_staging\\SKILL.md'],
        '/tmp/regenmed-skill-update'
      );
      expect(mockFastGet).toHaveBeenCalledWith(
        'C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging/SKILL.md',
        expect.any(String),
        expect.any(Function)
      );
    });

    it('send_files: no dest_subdir → uploads to Windows workFolder root', async () => {
      await uploadViaSFTP(agent(), ['/tmp/file.txt']);
      expect(mockFastPut).toHaveBeenCalledWith(
        '/tmp/file.txt',
        'C:/Users/Kashyap/bkp/source/repos/incytes-app-30/file.txt',
        expect.any(Function)
      );
    });

    it('remote path does NOT get prefixed with Linux CWD (regression guard)', async () => {
      await uploadViaSFTP(agent(), ['/tmp/file.txt'], '_staging');
      const [[, remotePath]] = mockFastPut.mock.calls;
      expect(remotePath).not.toMatch(/^\/.*\/C:/);
      expect(remotePath).toBe('C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging/file.txt');
    });
  });

  // ── Linux fleet host → local Linux member ────────────────────────────────────
  //
  // | Driver | Target      | send_files | receive_files |
  // | Linux  | local Linux | required   | required      |
  //
  // Local strategy uses fs.copyFile, not SFTP. Covered by existing tests in
  // tests/send-files-collision.test.ts and tests/receive-files.test.ts.

  // ── Windows fleet host → * ───────────────────────────────────────────────────
  //
  // These combinations require a Windows CI runner. Marked TODO until a
  // windows-latest GitHub Actions job is wired up for the fleet test suite.

  describe.todo('Windows fleet host → local Windows member — needs Windows runner');
  describe.todo('Windows fleet host → remote Linux member (SFTP) — needs Windows runner');
  describe.todo('Windows fleet host → remote Windows member (SFTP) — needs Windows runner');
});
