import { execFileSync } from 'child_process';
import path from 'path';

export function resolveProjectSlug(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  // 1. git remote URL
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir, env, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const slug = slugify(remote);
    if (slug) return slug;
  } catch {}
  // 2. git repo root dir name
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, env, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const slug = slugify(path.basename(root));
    if (slug) return slug;
  } catch {}
  // 3. non-git dirs always get 'default'
  return 'default';
}

function slugify(s: string): string {
  return s
    // Strip userinfo ONLY when it is really there. `[^@]*@?` was greedy and
    // unbounded, so a URL with no '@' at all (plain HTTPS -- the common case)
    // had its entire remainder eaten, yielding '' and silently falling back to
    // the directory basename. Bound the match to the authority section.
    .replace(/^https?:\/\/(?:[^@/]*@)?/, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/[:/]/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
