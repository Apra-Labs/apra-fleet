import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { receiveFiles } from '../src/tools/receive-files.js';
import { registry } from '../src/services/registry.js';
import { makeTestLocalAgent, makeTestAgent } from './test-helpers.js';
import * as sftp from '../src/services/sftp.js';
import { resolveMember } from '../src/utils/resolve-member.js';

vi.mock('../src/services/registry.js');
vi.mock('../src/services/sftp.js');
vi.mock('../src/utils/resolve-member.js');

describe('receiveFiles', () => {
  let tmpDir: string;
  let localAgent: any;
  let remoteAgent: any;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `fleet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    localAgent = makeTestLocalAgent({ workFolder: tmpDir });
    remoteAgent = makeTestAgent({ workFolder: '/remote/work' });

    (resolveMember as vi.Mock).mockImplementation((id: any) => {
      if (id === localAgent.id) return localAgent;
      if (id === remoteAgent.id) return remoteAgent;
      return 'Member not found';
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('Local member: copies file from remote_path to local_destination', async () => {
    const remoteFilePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(remoteFilePath, 'test content');

    const localDestination = path.join(tmpDir, 'local-dest');
    fs.mkdirSync(localDestination);

    const result = await receiveFiles({
      member_id: localAgent.id,
      remote_paths: ['test.txt'],
      local_dest_dir: localDestination,
    });

    expect(result).toContain('Successfully downloaded 1 file(s)');
    const destFile = path.join(localDestination, 'test.txt');
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe('test content');
  });

  it('Remote member: downloads via SFTP', async () => {
    const downloadViaSFTP = vi.spyOn(sftp, 'downloadViaSFTP').mockResolvedValue({
        success: ['test.txt'],
        failed: [],
    });

    const localDestination = path.join(tmpDir, 'local-dest');
    fs.mkdirSync(localDestination);

    await receiveFiles({
      member_id: remoteAgent.id,
      remote_paths: ['test.txt'],
      local_dest_dir: localDestination,
    });

    expect(downloadViaSFTP).toHaveBeenCalledWith(remoteAgent, ['test.txt'], localDestination);
  });

  it('Boundary violation: remote_path outside work folder', async () => {
    const result = await receiveFiles({
      member_id: localAgent.id,
      remote_paths: ['../test.txt'],
      local_dest_dir: tmpDir,
    });

    expect(result).toContain('resolves outside member work_folder');
  });

  it('Null byte in remote_path', async () => {
    const result = await receiveFiles({
      member_id: localAgent.id,
      remote_paths: ['test\0.txt'],
      local_dest_dir: tmpDir,
    });

    expect(result).toContain('null bytes are not allowed');
  });
});
