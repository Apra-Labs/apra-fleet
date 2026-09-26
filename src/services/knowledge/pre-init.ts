// ---------------------------------------------------------------------------
// KB pre-init phase: code-intel provider availability detection and repo
// index-size estimation. Used to build the informed opt-in prompt shown
// before a repo is indexed for the first time (see apra-fleet-t0d.2.1).
// Both functions are pure best-effort: they never throw, degrading to a
// structured "not available" / zeroed result on any error.
// ---------------------------------------------------------------------------

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export interface ProviderAvailability {
  available: boolean;
  provider: string;
  version?: string;
  error?: string;
}

export interface IndexSizeEstimate {
  fileCount: number;
  estimatedSizeBytes: number;
  estimatedTimeSeconds: number;
}

// The code-intel provider binary this fleet indexes with (see
// src/tools/code-intelligence-codebase-memory.ts).
const PROVIDER_BINARY = 'codebase-memory-mcp';

// Rough throughput assumption for projecting indexing time from repo size.
// Deliberately conservative; only used to give the user a ballpark figure.
const ESTIMATED_BYTES_PER_SECOND = 200_000;

// Directories that are excluded from the size/file-count estimate regardless
// of .gitignore content -- these are never meaningful to index.
const DEFAULT_EXCLUDES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache', 'vendor']);

// Detect whether the codebase-memory-mcp binary is installed and executable.
// Never throws: any spawn failure (ENOENT, non-zero exit, timeout) degrades
// to a structured { available: false, error } result.
export function detectProviderAvailability(): ProviderAvailability {
  try {
    const output = execFileSync(PROVIDER_BINARY, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { available: true, provider: PROVIDER_BINARY, version: output || undefined };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { available: false, provider: PROVIDER_BINARY, error };
  }
}

function loadGitignorePatterns(repoPath: string): string[] {
  const gitignorePath = join(repoPath, '.gitignore');
  if (!existsSync(gitignorePath)) return [];
  try {
    return readFileSync(gitignorePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

// Minimal glob -> RegExp: '**' matches any depth, '*' matches within a
// segment, '?' matches one non-slash char. Not a full gitignore spec
// implementation, but covers the common patterns repos actually use.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesGitignorePattern(relPath: string, name: string, pattern: string): boolean {
  let p = pattern;
  if (p.endsWith('/')) p = p.slice(0, -1);
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.length === 0) return false;

  const regex = globToRegExp(p);
  if (anchored) return regex.test(relPath);
  // Unanchored pattern with a slash: match against the full relative path or
  // as a path suffix. Unanchored pattern without a slash: match the basename.
  if (p.includes('/')) return regex.test(relPath) || relPath.endsWith(`/${p}`);
  return regex.test(name);
}

function isExcluded(relPath: string, name: string, patterns: string[]): boolean {
  if (DEFAULT_EXCLUDES.has(name)) return true;
  return patterns.some((pattern) => matchesGitignorePattern(relPath, name, pattern));
}

function walk(dir: string, repoRoot: string, patterns: string[], acc: { fileCount: number; bytes: number }): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(repoRoot, fullPath).split(sep).join('/');
    if (isExcluded(relPath, entry.name, patterns)) continue;

    if (entry.isDirectory()) {
      walk(fullPath, repoRoot, patterns, acc);
    } else if (entry.isFile()) {
      try {
        acc.bytes += statSync(fullPath).size;
        acc.fileCount++;
      } catch {
        // Unreadable file (permissions, race with deletion) -- skip it.
      }
    }
  }
}

// Estimate index size for a repo: walks the tree (respecting .gitignore and
// the default excludes above) and projects an indexing time from total
// bytes. Never throws -- any walk failure degrades to a zeroed estimate.
export function estimateIndexSize(repoPath: string): IndexSizeEstimate {
  const acc = { fileCount: 0, bytes: 0 };
  try {
    const patterns = loadGitignorePatterns(repoPath);
    walk(repoPath, repoPath, patterns, acc);
  } catch {
    // Fall through to the zeroed/partial accumulator below.
  }

  return {
    fileCount: acc.fileCount,
    estimatedSizeBytes: acc.bytes,
    estimatedTimeSeconds: acc.bytes > 0 ? Math.max(1, Math.round(acc.bytes / ESTIMATED_BYTES_PER_SECOND)) : 0,
  };
}
