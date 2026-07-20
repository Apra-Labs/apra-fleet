/**
 * Surface-integration tests for send_files substitutions (tests p, p2 from Task 1).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { sendFiles } from '../src/tools/send-files.js';

// Track what transferFiles receives so we can read temp file content before cleanup.
const mockTransferFiles = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    transferFiles: mockTransferFiles,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: (member: any) => Promise.resolve(member),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

vi.mock('../src/utils/agent-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/agent-helpers.js')>('../src/utils/agent-helpers.js');
  return { ...actual, touchAgent: vi.fn() };
});

// Spy on credential-store to verify it is never touched during substitution.
vi.mock('../src/services/credential-store.js', () => ({
  credentialResolve: vi.fn(() => { throw new Error('credential-store must not be called during substitution'); }),
  credentialSet: vi.fn(),
  credentialList: vi.fn(),
  credentialDelete: vi.fn(),
  credentialUpdate: vi.fn(),
  purgeExpiredCredentials: vi.fn(),
}));

/** Helper: create a temp source file and return its path. */
function makeTempFile(content: string, basename = `tpl-${Date.now()}.md`): string {
  const p = path.join(os.tmpdir(), basename);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

describe('send_files -- substitution surface tests (p, p2)', () => {
  let member: ReturnType<typeof makeTestAgent>;
  const tempFiles: string[] = [];

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    member = makeTestAgent({ friendlyName: 'subst-member' });
    addAgent(member);
  });

  afterEach(() => {
    restoreRegistry();
    for (const p of tempFiles) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    tempFiles.length = 0;
  });

  // (p) 3-file mixed batch: two files with tokens, one plain -- all succeed
  it('(p) 3-file batch: two with tokens, one plain -- all transfer successfully', async () => {
    const f1 = makeTempFile('Branch: {{branch}}', 'f1.md');
    const f2 = makeTempFile('Reviewer: {{member_name}}', 'f2.md');
    const f3 = makeTempFile('No tokens here at all', 'f3.md');
    tempFiles.push(f1, f2, f3);

    // Capture content from temp files before they are deleted.
    const capturedContent: Map<string, string> = new Map();
    mockTransferFiles.mockImplementation(async (paths: string[]) => {
      for (const p of paths) {
        capturedContent.set(path.basename(p), fs.readFileSync(p, 'utf-8'));
      }
      return { success: paths.map(p => path.basename(p)), failed: [] };
    });

    const result = await sendFiles({
      member_id: member.id,
      local_paths: [f1, f2, f3],
      substitutions: { branch: 'feat/x', member_name: 'Alice' },
    });

    expect(result).toContain('Successfully uploaded 3');
    expect(capturedContent.get('f1.md')).toBe('Branch: feat/x');
    expect(capturedContent.get('f2.md')).toBe('Reviewer: Alice');
    expect(capturedContent.get('f3.md')).toBe('No tokens here at all');
  });

  // (p) Source files must not be modified
  it('(p) source files are never modified by substitution', async () => {
    const original = 'Branch: {{branch}}';
    const f1 = makeTempFile(original, 'src-immutable.md');
    tempFiles.push(f1);

    mockTransferFiles.mockResolvedValue({ success: ['src-immutable.md'], failed: [] });

    await sendFiles({
      member_id: member.id,
      local_paths: [f1],
      substitutions: { branch: 'feat/x' },
    });

    expect(fs.readFileSync(f1, 'utf-8')).toBe(original);
  });

  // (p) Invalid key rejects before reading files
  it('(p) invalid substitution key rejects before any file read', async () => {
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const f1 = makeTempFile('{{branch}}', 'no-read.md');
    tempFiles.push(f1);

    const result = await sendFiles({
      member_id: member.id,
      local_paths: [f1],
      substitutions: { 'secure.github_pat': 'value' },
    });

    expect(result).toContain('invalid substitutions');
    expect(result).toContain('secure.github_pat');
    expect(mockTransferFiles).not.toHaveBeenCalled();
    // readFileSync should not have been called for our source file
    const readCallsForOurFile = readSpy.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('no-read.md'),
    );
    expect(readCallsForOurFile).toHaveLength(0);
    readSpy.mockRestore();
  });

  // (p) Missing token fails with no files transferred
  it('(p) missing token returns structured error, no files transferred', async () => {
    const f1 = makeTempFile('Branch: {{branch}}, base: {{base_branch}}', 'missing-tok.md');
    tempFiles.push(f1);

    const result = await sendFiles({
      member_id: member.id,
      local_paths: [f1],
      substitutions: { branch: 'feat/x' }, // base_branch missing
    });

    expect(result).toContain('send_files: substitution failed');
    expect(result).toContain('base_branch');
    expect(result).not.toContain('feat/x'); // value must not appear in error
    expect(mockTransferFiles).not.toHaveBeenCalled();
  });

  // (p) Extra keys silently ignored
  it('(p) extra substitution keys silently ignored, transfer succeeds', async () => {
    const f1 = makeTempFile('hello {{name}}', 'extra.md');
    tempFiles.push(f1);

    const capturedContent: Map<string, string> = new Map();
    mockTransferFiles.mockImplementation(async (paths: string[]) => {
      for (const p of paths) {
        capturedContent.set(path.basename(p), fs.readFileSync(p, 'utf-8'));
      }
      return { success: paths.map(p => path.basename(p)), failed: [] };
    });

    const result = await sendFiles({
      member_id: member.id,
      local_paths: [f1],
      substitutions: { name: 'world', unused: 'ignored' },
    });

    expect(result).toContain('Successfully uploaded 1');
    expect(capturedContent.get('extra.md')).toBe('hello world');
  });

  // (p2) Full pipeline: tpl-doer.md-style template with multiple tokens
  it('(p2) full pipeline with tpl-doer-style template -- all tokens substituted', async () => {
    const template = `# Task for {{member_name}}

Branch: {{branch}}
Base: {{base_branch}}

Instructions: review {{phase}} changes.`;

    const f1 = makeTempFile(template, 'tpl-doer.md');
    tempFiles.push(f1);

    const capturedContent: Map<string, string> = new Map();
    mockTransferFiles.mockImplementation(async (paths: string[]) => {
      for (const p of paths) {
        capturedContent.set(path.basename(p), fs.readFileSync(p, 'utf-8'));
      }
      return { success: paths.map(p => path.basename(p)), failed: [] };
    });

    const result = await sendFiles({
      member_id: member.id,
      local_paths: [f1],
      substitutions: {
        member_name: 'Alice',
        branch: 'feat/task-1',
        base_branch: 'main',
        phase: '3',
      },
    });

    expect(result).toContain('Successfully uploaded 1');
    const rendered = capturedContent.get('tpl-doer.md');
    expect(rendered).toContain('Task for Alice');
    expect(rendered).toContain('Branch: feat/task-1');
    expect(rendered).toContain('Base: main');
    expect(rendered).toContain('review 3 changes');
    expect(rendered).not.toContain('{{'); // no unresolved tokens
  });

  // (p2) {{secure.NAME}} in template passes through verbatim
  it('(p2) {{secure.NAME}} in template passes through verbatim to member', async () => {
    const template = 'Run: execute_command with {{secure.github_pat}} on branch {{branch}}';
    const f1 = makeTempFile(template, 'tpl-with-secure.md');
    tempFiles.push(f1);

    const capturedContent: Map<string, string> = new Map();
    mockTransferFiles.mockImplementation(async (paths: string[]) => {
      for (const p of paths) {
        capturedContent.set(path.basename(p), fs.readFileSync(p, 'utf-8'));
      }
      return { success: paths.map(p => path.basename(p)), failed: [] };
    });

    const result = await sendFiles({
      member_id: member.id,
      local_paths: [f1],
      substitutions: { branch: 'feat/x' },
    });

    expect(result).toContain('Successfully uploaded 1');
    const rendered = capturedContent.get('tpl-with-secure.md');
    // {{branch}} is substituted; {{secure.github_pat}} is preserved verbatim
    expect(rendered).toBe('Run: execute_command with {{secure.github_pat}} on branch feat/x');
  });

  // Heuristic warning fires when no substitutions given and file has tokens
  it('heuristic warning fires when file has {{tokens}} and no substitutions provided', async () => {
    const f1 = makeTempFile('Branch: {{branch}}', 'warn-test.md');
    tempFiles.push(f1);

    mockTransferFiles.mockResolvedValue({ success: ['warn-test.md'], failed: [] });

    const result = await sendFiles({
      member_id: member.id,
      local_paths: [f1],
      // no substitutions
    });

    expect(result).toContain('Successfully uploaded 1');
    expect(result).toContain('branch'); // warning names the token
  });
});
