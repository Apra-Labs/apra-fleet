import { describe, it, expect } from 'vitest';
import path from 'node:path';

/**
 * Demonstrates the bug: path.posix.resolve does NOT handle Windows drive-letter paths correctly.
 *
 * When a Windows member reports work_folder as C:\Users\..., the SFTP transport layer
 * uses path.posix.resolve to compute remote paths. This function treats the Windows
 * drive letter as a relative path and prepends the local process CWD, producing garbage.
 *
 * These tests document the fundamental bug and serve as a bisect oracle.
 */

describe('path.posix.resolve bug with Windows drive-letter paths', () => {
  it('shows path.posix.resolve breaks Windows drive-letter work folders', () => {
    const windowsWorkFolder = 'C:/Users/Kashyap/repos';
    const subPath = '_staging';

    // This is what the buggy code does (using path.posix.resolve)
    const result = path.posix.resolve(windowsWorkFolder, subPath);

    // path.posix.resolve does NOT understand Windows drive letters.
    // Since 'C:/Users/...' does NOT start with '/', it's treated as relative.
    // The function prepends the local process CWD, producing garbage.
    expect(result).not.toBe('C:/Users/Kashyap/repos/_staging');
    expect(result).toContain('C:/Users/Kashyap/repos');
    expect(result).toMatch(/^\/.*\/C:\/Users\/Kashyap\/repos\/_staging/);
  });

  it('shows path.posix.resolve works correctly with Linux absolute paths', () => {
    const linuxWorkFolder = '/home/user/repos';
    const subPath = '_staging';

    // With Linux paths starting with '/', path.posix.resolve works as expected
    const result = path.posix.resolve(linuxWorkFolder, subPath);

    expect(result).toBe('/home/user/repos/_staging');
  });

  it('demonstrates the bug with dotted relative paths (Case 1 variant)', () => {
    const windowsWorkFolder = 'C:/Users/Kashyap/repos';
    const dotPath = '.claude/skills/mapper/SKILL.md';

    const result = path.posix.resolve(windowsWorkFolder, dotPath);

    // Should produce something like:
    // /home/kashyap/repos/apra/apra-fleet/C:/Users/Kashyap/repos/.claude/skills/mapper/SKILL.md
    expect(result).not.toBe('C:/Users/Kashyap/repos/.claude/skills/mapper/SKILL.md');
    expect(result).toMatch(/^\/.*\/C:\/Users\/Kashyap\/repos\/\.claude/);
  });

  it('demonstrates the bug with non-dotted relative paths (Case 2 variant)', () => {
    const windowsWorkFolder = 'C:/Users/Kashyap/repos';
    const relativePath = '_staging/SKILL.md';

    const result = path.posix.resolve(windowsWorkFolder, relativePath);

    // Should NOT be C:/Users/Kashyap/repos/_staging/SKILL.md
    expect(result).not.toBe('C:/Users/Kashyap/repos/_staging/SKILL.md');
    expect(result).toMatch(/C:\/Users\/Kashyap\/repos\/_staging\/SKILL\.md/);
  });

  it('demonstrates the bug with absolute Windows paths (Case 3 variant)', () => {
    const windowsAbsolutePath = 'C:\\Users\\Kashyap\\bkp\\source\\repos\\incytes-app-30\\_staging\\SKILL.md';
    const subPath = '_staging';

    // Windows absolute paths with backslashes also fail with path.posix.resolve
    const result = path.posix.resolve(windowsAbsolutePath, subPath);

    // The backslashes are treated literally (not as path separators by posix)
    expect(result).not.toBe('C:\\Users\\Kashyap\\bkp\\source\\repos\\incytes-app-30\\_staging\\_staging\\SKILL.md');
  });

  it('shows Linux paths work correctly with all path styles', () => {
    const linuxWorkFolder = '/home/user/repos';

    // All these should work correctly with path.posix.resolve
    const case1 = path.posix.resolve(linuxWorkFolder, '.claude/skills/mapper/SKILL.md');
    const case2 = path.posix.resolve(linuxWorkFolder, '_staging/SKILL.md');
    const case3 = path.posix.resolve(linuxWorkFolder, '/absolute/path/SKILL.md');

    expect(case1).toBe('/home/user/repos/.claude/skills/mapper/SKILL.md');
    expect(case2).toBe('/home/user/repos/_staging/SKILL.md');
    expect(case3).toBe('/absolute/path/SKILL.md');
  });

  it('verifies the core issue: Windows paths with drive letters need special handling', () => {
    // The fix must detect Windows drive letters and handle them correctly.
    // A Windows path like C:/Users/... should be detectable and joined without path.posix.resolve.

    const windowsPath = 'C:/Users/Kashyap/repos';
    const hasDriveLetter = /^[A-Za-z]:/.test(windowsPath);

    expect(hasDriveLetter).toBe(true);
    expect(/^[A-Za-z]:/.test('/home/user/repos')).toBe(false);
  });
});
