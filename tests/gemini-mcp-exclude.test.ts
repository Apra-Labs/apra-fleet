import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
vi.mock('os');
vi.mock('path');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAllowedMcpServers } from '../src/providers/gemini.js';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockHomedir = vi.mocked(os.homedir);
const mockJoin = vi.mocked(path.join);

beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue('/home/user');
  mockJoin.mockImplementation((...parts: string[]) => parts.join('/'));
});

describe('getAllowedMcpServers', () => {
  it('returns "none" when settings file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(getAllowedMcpServers()).toBe('none');
  });

  it('returns "none" when settings file has no mcpServers key', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ mode: 'auto' }) as unknown as Buffer);
    expect(getAllowedMcpServers()).toBe('none');
  });

  it('returns "none" when mcpServers contains only apra-fleet', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: { 'apra-fleet': {} } }) as unknown as Buffer);
    expect(getAllowedMcpServers()).toBe('none');
  });

  it('returns other servers when apra-fleet is present alongside them', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: { 'apra-fleet': {}, 'my-server': {}, 'another': {} },
    }) as unknown as Buffer);
    const result = getAllowedMcpServers();
    expect(result.split(',').sort()).toEqual(['another', 'my-server']);
  });

  it('returns all servers when apra-fleet is not present', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: { 'server-a': {}, 'server-b': {} },
    }) as unknown as Buffer);
    const result = getAllowedMcpServers();
    expect(result.split(',').sort()).toEqual(['server-a', 'server-b']);
  });

  it('returns "none" when mcpServers is empty', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }) as unknown as Buffer);
    expect(getAllowedMcpServers()).toBe('none');
  });

  it('returns "none" when settings file contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not-valid-json' as unknown as Buffer);
    expect(getAllowedMcpServers()).toBe('none');
  });
});
