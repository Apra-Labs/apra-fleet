import { describe, it, expect } from 'vitest';
import { getOsCommands } from '../src/os/index.js';

const windows = getOsCommands('windows');

describe('Windows gitCredentialHelperWrite', () => {
  it('produces valid PowerShell without here-string delimiters', () => {
    const cmd = windows.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghu_test123');
    // Must not use PowerShell here-string syntax (= @' ... '@)
    expect(cmd).not.toMatch(/= @'/);
    expect(cmd).not.toContain("\n'@");
    // Must still contain the credential data and git config
    expect(cmd).toContain('github.com');
    expect(cmd).toContain('x-access-token');
    expect(cmd).toContain('ghu_test123');
    expect(cmd).toContain('credential.https://github.com.helper');
    expect(cmd).toContain('fleet-git-credential');
    expect(cmd).toContain('Set-Content');
  });

  it('handles tokens with single quotes', () => {
    const cmd = windows.gitCredentialHelperWrite('github.com', 'x-access-token', "tok'en");
    // Single quotes must be escaped as '' for PowerShell single-quoted strings
    expect(cmd).toContain("tok''en");
    expect(cmd).not.toContain("tok'en");
  });

  it('handles tokens with double quotes', () => {
    const cmd = windows.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok"en');
    expect(cmd).toContain('tok"en');
  });

  it('handles tokens with dollar signs (literal in PS single-quoted strings)', () => {
    const cmd = windows.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok$en');
    expect(cmd).toContain('tok$en');
  });

  it('handles tokens with backticks (literal in PS single-quoted strings)', () => {
    const cmd = windows.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok`en');
    expect(cmd).toContain('tok`en');
  });

  it('uses -join to build multi-line bat content', () => {
    const cmd = windows.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghs_abc');
    // The -join operator with `r`n creates proper CRLF line endings
    expect(cmd).toContain('-join');
    expect(cmd).toContain('@echo off');
    expect(cmd).toContain('echo protocol=https');
  });

  it('escapes cmd.exe metacharacters in host via escapeWindowsArg', () => {
    const cmd = windows.gitCredentialHelperWrite('host&inject', 'user', 'token');
    // & should be escaped as ^& for cmd.exe safety
    expect(cmd).toContain('host^&inject');
  });
});
