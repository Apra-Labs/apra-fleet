import { describe, it, expect } from 'vitest';
import {
  readMemberFile, readMemberJson, readMemberFileCommand, MemberConfigUnreadableError, MemberConfigNotJsonError,
} from '../src/services/member-config-io.js';

// readMemberFile must tell "missing" (-> '' / {}) from "exists but unreadable"
// (-> typed E-MEMBER-CONFIG-UNREADABLE), so a caller can never read a locked
// ~/.claude.json as {} and then rewrite it.

const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });

describe('readMemberFileCommand shapes', () => {
  it('bash: existence test, exit code of cat is not swallowed', () => {
    const cmd = readMemberFileCommand('/home/u/.claude.json', true);
    expect(cmd).toContain('test -e "/home/u/.claude.json"');
    expect(cmd).toContain('cat "/home/u/.claude.json"');
    expect(cmd).not.toContain('|| true');
    expect(cmd).not.toContain('2>/dev/null');
  });

  it('PowerShell: Test-Path then Get-Content with -ErrorAction Stop, never SilentlyContinue', () => {
    const cmd = readMemberFileCommand('C:/Users/u/.claude.json', false);
    expect(cmd).toContain('Test-Path');
    expect(cmd).toContain('C:\\Users\\u\\.claude.json');
    expect(cmd).toContain('Get-Content -Raw');
    expect(cmd).toContain('-ErrorAction Stop');
    expect(cmd).not.toContain('SilentlyContinue');
  });
});

describe.each([['bash', true], ['powershell', false]] as const)('readMemberFile/readMemberJson (%s)', (_name, posix) => {
  it('missing file (empty output, exit 0) -> "" and {}', async () => {
    const exec = async () => ok('');
    expect(await readMemberFile(exec, '/x/.claude.json', posix)).toBe('');
    expect(await readMemberJson(exec, '/x/.claude.json', posix)).toEqual({});
  });

  it('existing but unreadable (non-zero exit) -> typed E-MEMBER-CONFIG-UNREADABLE', async () => {
    const exec = async () => ({ stdout: '', stderr: 'Permission denied', code: 1 });
    const err = await readMemberJson(exec, '/x/.claude.json', posix).catch(e => e);
    expect(err).toBeInstanceOf(MemberConfigUnreadableError);
    expect(err.code).toBe('E-MEMBER-CONFIG-UNREADABLE');
    expect(err.reason).toBe('member-config-unreadable');
    expect(err.message).toContain('/x/.claude.json');
  });

  it('non-JSON content -> typed E-MEMBER-CONFIG-NOT-JSON', async () => {
    const err = await readMemberJson(async () => ok('// jsonc\n{}'), '/x/o.json', posix).catch(e => e);
    expect(err).toBeInstanceOf(MemberConfigNotJsonError);
    expect(err.code).toBe('E-MEMBER-CONFIG-NOT-JSON');
  });
});
