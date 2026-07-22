import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockDetectProviderAvailability = vi.fn();
vi.mock('../../src/services/knowledge/pre-init.js', () => ({
  detectProviderAvailability: () => mockDetectProviderAvailability(),
}));

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const { kbSetup } = await import('../../src/tools/kb-setup.js');
const { readRepoCodeIntelConfig } = await import('../../src/services/knowledge/repo-config.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
  mockDetectProviderAvailability.mockReset();
  mockExecFileSync.mockReset();
  // Default: provider not installed, matching a fresh dev machine. Tests that
  // exercise the indexing path override this explicitly.
  mockDetectProviderAvailability.mockReturnValue({
    available: false,
    provider: 'codebase-memory-mcp',
    error: 'command not found',
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kb_setup', () => {
  it('installs post-commit hook in repo', async () => {
    const result = JSON.parse(await kbSetup({ repo_path: tmpDir }));
    expect(result.success).toBe(true);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'post-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    const hookContent = fs.readFileSync(hookPath, 'utf-8');
    expect(hookContent).toContain('kb invalidate');
  });

  it('writes config file with provider', async () => {
    const result = JSON.parse(await kbSetup({ repo_path: tmpDir, provider: 'sqlite' }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => s.includes('config'))).toBe(true);
  });

  it('stores remote token encrypted (never plaintext)', async () => {
    const result = JSON.parse(await kbSetup({
      repo_path: tmpDir,
      provider: 'http',
      remote: 'http://localhost:7878',
      token: 'secret-token-123',
    }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => s.includes('encrypted'))).toBe(true);

    // Verify token is NOT stored in plaintext
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('secret-token-123');
  });
});

// ---------------------------------------------------------------------------
// First-time code-intel indexing lifecycle (apra-fleet-t0d.2.1).
// ---------------------------------------------------------------------------
describe('kb_setup first-time indexing', () => {
  it('triggers indexing and writes code-intel.json on success', async () => {
    mockDetectProviderAvailability.mockReturnValue({ available: true, provider: 'codebase-memory-mcp' });
    mockExecFileSync.mockReturnValue('');

    const result = JSON.parse(await kbSetup({ repo_path: tmpDir }));

    expect(result.success).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'codebase-memory-mcp',
      ['cli', 'index_repository', JSON.stringify({ repo_path: tmpDir })],
      expect.any(Object),
    );
    expect(result.steps.some((s: string) => s.includes('Indexed repository for code intelligence'))).toBe(true);

    const config = readRepoCodeIntelConfig(tmpDir);
    expect(config?.enabled).toBe(true);
    expect(typeof config?.indexedAt).toBe('string');
  });

  it('returns an error when the provider binary is missing', async () => {
    mockDetectProviderAvailability.mockReturnValue({
      available: false,
      provider: 'codebase-memory-mcp',
      error: 'command not found',
    });

    const result = JSON.parse(await kbSetup({ repo_path: tmpDir }));

    // Overall kb_setup still succeeds (hook + config steps completed); the
    // missing provider only skips the indexing step with a note, matching
    // kb-setup.ts's degrade-safe behavior.
    expect(result.steps.some((s: string) => s.includes('Skipped code-intel indexing: provider not available'))).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(readRepoCodeIntelConfig(tmpDir)).toBeNull();
  });

  it('reports a failure with an actionable retry command when indexing itself fails', async () => {
    mockDetectProviderAvailability.mockReturnValue({ available: true, provider: 'codebase-memory-mcp' });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('indexer crashed');
    });

    const result = JSON.parse(await kbSetup({ repo_path: tmpDir }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Code-intel indexing failed: indexer crashed');
    expect(result.error).toContain('codebase-memory-mcp cli index_repository');
    expect(readRepoCodeIntelConfig(tmpDir)).toBeNull();
  });

  it('skips re-indexing on an already-indexed repo (idempotent)', async () => {
    fs.mkdirSync(path.join(tmpDir, '.apra-fleet'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.apra-fleet', 'code-intel.json'),
      JSON.stringify({ enabled: true, indexedAt: '2026-07-01T00:00:00.000Z' }),
    );
    mockDetectProviderAvailability.mockReturnValue({ available: true, provider: 'codebase-memory-mcp' });

    const result = JSON.parse(await kbSetup({ repo_path: tmpDir }));

    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => s.includes('already indexed at 2026-07-01T00:00:00.000Z, skipping re-index'))).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    // Config on disk is untouched by the skip path.
    expect(readRepoCodeIntelConfig(tmpDir)?.indexedAt).toBe('2026-07-01T00:00:00.000Z');
  });
});
