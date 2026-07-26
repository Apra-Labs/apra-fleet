import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ONLY the shared registerMember handler -- keep the real
// registerMemberSchema so the CLI's parse/validate/default behavior is
// exercised for real. This proves the CLI parses flags and delegates to the
// one shared registration function without touching the SSH/server side.
const { mockRegisterMember } = vi.hoisted(() => ({
  mockRegisterMember: vi.fn<(input: any) => Promise<string>>(),
}));
vi.mock('../src/tools/register-member.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/register-member.js')>();
  return { ...actual, registerMember: mockRegisterMember };
});

import { runRegisterMember } from '../src/cli/register-member.js';

describe('register-member CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockRegisterMember.mockResolvedValue('[OK] Member registered successfully!');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('parses flags and calls the shared registerMember with a schema-validated object', async () => {
    await runRegisterMember([
      '--type', 'local',
      '--name', 'toy-doer',
      '--path', '/home/u/toy-repo',
      '--llm', 'claude',
    ]);
    expect(mockRegisterMember).toHaveBeenCalledTimes(1);
    const arg = mockRegisterMember.mock.calls[0][0];
    expect(arg).toMatchObject({
      friendly_name: 'toy-doer',
      member_type: 'local',
      work_folder: '/home/u/toy-repo',
      llm_provider: 'claude',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('applies schema defaults for omitted fields (member_type=remote, port=22, llm=claude)', async () => {
    await runRegisterMember([
      '--name', 'r1',
      '--path', '/srv/x',
      '--host', '10.0.0.1',
      '--username', 'ubuntu',
      '--auth', 'key',
    ]);
    const arg = mockRegisterMember.mock.calls[0][0];
    expect(arg.member_type).toBe('remote');
    expect(arg.port).toBe(22);
    expect(arg.llm_provider).toBe('claude');
  });

  it('supports --flag=value form, comma tags, and repeatable --model-tier', async () => {
    await runRegisterMember([
      '--type=local',
      '--name=m2',
      '--path=/w',
      '--tags=doer,gpu',
      '--model-tier', 'cheap=x/y',
      '--model-tier', 'standard=a/b',
    ]);
    const arg = mockRegisterMember.mock.calls[0][0];
    expect(arg.tags).toEqual(['doer', 'gpu']);
    expect(arg.model_tiers).toEqual({ cheap: 'x/y', standard: 'a/b' });
  });

  it('errors and exits non-zero when --name or --path is missing', async () => {
    await runRegisterMember(['--type', 'local', '--name', 'no-path']);
    expect(mockRegisterMember).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--name and --path are required'));
  });

  it('rejects an unknown flag before calling the handler', async () => {
    await runRegisterMember(['--name', 'a', '--path', '/w', '--bogus', 'z']);
    expect(mockRegisterMember).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('surfaces schema validation errors (bad llm_provider) without calling the handler', async () => {
    await runRegisterMember(['--name', 'a', '--path', '/w', '--llm', 'not-a-provider']);
    expect(mockRegisterMember).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid arguments'));
  });

  it('exits non-zero and prints to stderr when registration fails', async () => {
    mockRegisterMember.mockResolvedValue('[X] "host" is required for remote members. Member was NOT registered.');
    await runRegisterMember(['--name', 'a', '--path', '/w', '--type', 'remote']);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('NOT registered'));
  });

  it('prints the success message and leaves exit code unset on success', async () => {
    await runRegisterMember(['--type', 'local', '--name', 'ok', '--path', '/w']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('registered successfully'));
    expect(process.exitCode).toBeUndefined();
  });

  it('--help prints usage without registering', async () => {
    await runRegisterMember(['--help']);
    expect(mockRegisterMember).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('register-member'));
  });
});
