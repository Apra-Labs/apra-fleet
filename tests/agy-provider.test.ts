import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgyProvider } from '../src/providers/agy.js';

describe('AgyProvider registerMcpEndpoint', () => {
  const p = new AgyProvider();
  let homeDir: string;
  let restoreHomedir: () => void;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-agy-test-'));
    const original = os.homedir;
    os.homedir = () => homeDir;
    restoreHomedir = () => { os.homedir = original; };
  });

  afterEach(() => {
    restoreHomedir();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function configFile(): string {
    return path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  }

  it('creates mcp_config.json when none exists', async () => {
    const result = await p.registerMcpEndpoint!({
      url: 'http://127.0.0.1:7523/mcp?member=test',
      token: 'testtoken123',
      workFolder: '/some/folder',
      scope: 'user',
    });

    expect(result.mechanism).toBe('config-file-merge');
    expect(fs.existsSync(configFile())).toBe(true);

    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.mcpServers['apra-fleet-member']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7523/mcp?member=test',
      headers: { Authorization: 'Bearer testtoken123' },
    });
  });

  it('merges without clobbering sibling MCP entries', async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({
      mcpServers: { 'some-other-server': { type: 'http', url: 'http://other' } },
    }));

    await p.registerMcpEndpoint!({
      url: 'http://127.0.0.1:7523/mcp?member=test',
      token: 'tok',
      workFolder: '/some/folder',
      scope: 'user',
    });

    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.mcpServers['some-other-server']).toEqual({ type: 'http', url: 'http://other' });
    expect(written.mcpServers['apra-fleet-member'].url).toBe('http://127.0.0.1:7523/mcp?member=test');
  });

  it('recovers from malformed existing file rather than throwing', async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), '{not valid json');

    const result = await p.registerMcpEndpoint!({
      url: 'http://127.0.0.1:7523/mcp?member=test',
      token: 'tok',
      workFolder: '/some/folder',
      scope: 'user',
    });

    expect(result.mechanism).toBe('config-file-merge');
    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.mcpServers['apra-fleet-member'].url).toBe('http://127.0.0.1:7523/mcp?member=test');
  });
});
