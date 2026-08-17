import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbList } from '../../src/tools/kb-list.js';

// apra-fleet-b4g.1.5: a remote member's work folder path does not exist on
// this host, so getKbProviders must resolve the SAME project KB it would from
// a real local clone once repo_remote_url is supplied alongside repo_path.
// This file pins that end-to-end behaviour (slug, provider, and tool level),
// following the makeRepo/resetKbProviders/per-test-unique-remote fixture style
// of tests/knowledge/kb-repo-isolation.test.ts.

function makeRepo(root: string, name: string, remote: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'fixture.ts'), 'export const fixture = 1;\n');
  return dir;
}

let tmp: string;
let tok: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-remote-scope-'));
  tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
  resetKbProviders();
});

afterEach(() => {
  resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveProjectSlug: nonexistent path + remote URL', () => {
  it('a Windows-style path that does not exist on this host resolves via the SSH remote URL', () => {
    const fakePath = `C:\\Users\\member\\work\\apra-fleet-${tok}`;
    const slug = resolveProjectSlug(fakePath, `git@github.com:Apra-Labs/apra-fleet-${tok}.git`);
    expect(slug).toBe(`githubcom-apra-labs-apra-fleet-${tok}`);
  });

  // The regression pin: the same nonexistent path with NO url must NOT
  // silently resolve to that same slug -- it must fall through to 'default'.
  it('the same nonexistent path with NO url falls through to "default"', () => {
    const fakePath = `C:\\Users\\member\\work\\apra-fleet-${tok}`;
    expect(resolveProjectSlug(fakePath)).toBe('default');
  });

  it('the HTTPS form of the remote URL slugifies to the same value as the SSH form', () => {
    const fakePath = `C:\\Users\\member\\work\\apra-fleet-${tok}`;
    const sshSlug = resolveProjectSlug(fakePath, `git@github.com:Apra-Labs/apra-fleet-${tok}.git`);
    const httpsSlug = resolveProjectSlug(fakePath, `https://github.com/Apra-Labs/apra-fleet-${tok}.git`);
    expect(httpsSlug).toBe(sshSlug);
  });

  // apra-fleet-b4g.9: project-slug.ts:5-8 guards the remote-URL short-circuit
  // with `if (remoteUrl && remoteUrl.trim()) { const slug = slugify(remoteUrl);
  // if (slug) return slug; }` so a malformed remote_url degrades to local-path
  // derivation instead of ever producing an empty slug (which would name a
  // directory under FLEET_DIR/knowledge/). Pin both fallthrough paths against
  // a real clone.
  // NOTE on mutation coverage: this case is an input-level behaviour pin, not
  // a mutation pin. The `.trim()` sub-check in
  // `if (remoteUrl && remoteUrl.trim())` is behaviorally redundant given the
  // inner `if (slug) return slug` guard below it -- any whitespace-only
  // string survives `remoteUrl &&` (it is truthy) but slugify() reduces it to
  // '' regardless, so the inner guard alone already catches it. Relaxing the
  // outer check to `if (remoteUrl)` leaves this whole file green; only the
  // inner guard (pinned by the empty-slug case right below) is actually
  // mutation-detectable. Do not re-file this as an untested branch.
  it('a whitespace-only remote_url (caught by the .trim() guard) falls through to local-path derivation, never yielding an empty slug', () => {
    const remoteUrl = `git@github.com:acme/whitespace-fallthrough-${tok}.git`;
    const localClone = makeRepo(tmp, 'whitespace-fallthrough', remoteUrl);

    const slug = resolveProjectSlug(localClone, '   ');
    expect(slug).toBe(`githubcom-acme-whitespace-fallthrough-${tok}`);
    expect(slug).not.toBe('');
  });

  it('a remote_url that slugify reduces to an empty string (caught by the `if (slug) return slug` guard) falls through to local-path derivation, never yielding an empty slug', () => {
    const remoteUrl = `git@github.com:acme/empty-slug-fallthrough-${tok}.git`;
    const localClone = makeRepo(tmp, 'empty-slug-fallthrough', remoteUrl);

    // '!!!' has no alphanumeric/dash characters at all, so slugify() strips
    // it down to '' -- distinct from the .trim() guard above, this is caught
    // by the inner `if (slug) return slug` check.
    const slug = resolveProjectSlug(localClone, '!!!');
    expect(slug).toBe(`githubcom-acme-empty-slug-fallthrough-${tok}`);
    expect(slug).not.toBe('');
  });
});

describe('getKbProviders: nonexistent remote path matches the real local clone', () => {
  it('a nonexistent remote-style path + remote URL resolves the same slug and dbPath as a real local clone with that same origin', async () => {
    const remoteUrl = `git@github.com:acme/remote-scope-${tok}.git`;
    const fakeRemotePath = `/definitely/does/not/exist/member-work/${tok}`;
    const localClone = makeRepo(tmp, 'local-clone', remoteUrl);

    const fromRemote = await getKbProviders(fakeRemotePath, remoteUrl);
    const fromLocal = await getKbProviders(localClone);

    expect(fromRemote.projectSlug).toBe(fromLocal.projectSlug);
    expect((fromRemote.project as any).dbPath).toBe((fromLocal.project as any).dbPath);
  });
});

describe('kb_capture + kb_list: remote member work folder round trip', () => {
  it('captures and reads back an entry scoped by repo_path + repo_remote_url, and the entry is invisible without the URL', async () => {
    // Stand in for a remote member's work folder: a REAL tmpdir with no git
    // origin remote of its own, but a real source file for the capture basis
    // (sqlite-provider.ts:323 rejects any capture whose cited source files
    // cannot resolve under the provider's repoPath, so this can never be a
    // nonexistent path -- see apra-fleet-b4g.1.5's task description).
    const memberWorkFolder = path.join(tmp, 'member-work');
    fs.mkdirSync(path.join(memberWorkFolder, 'src'), { recursive: true });
    fs.writeFileSync(path.join(memberWorkFolder, 'src', 'fixture.ts'), 'export const fixture = 1;\n');
    const remoteUrl = `git@github.com:acme/member-round-trip-${tok}.git`;

    await kbCapture({
      type: 'knowledge',
      title: 'Remote member fact',
      summary: 'Captured from a work folder with no local git origin.',
      content: 'If this is not visible via repo_path+repo_remote_url, remote scoping is broken.',
      source_files: ['src/fixture.ts'],
      repo_path: memberWorkFolder,
      repo_remote_url: remoteUrl,
    } as any);

    const withUrl = JSON.parse(await kbList({ repo_path: memberWorkFolder, repo_remote_url: remoteUrl, limit: 50 } as any));
    expect(withUrl.results.some((e: any) => e.title === 'Remote member fact')).toBe(true);

    const withoutUrl = JSON.parse(await kbList({ repo_path: memberWorkFolder, limit: 50 } as any));
    expect(withoutUrl.results.some((e: any) => e.title === 'Remote member fact')).toBe(false);
  });
});

describe('backward compatibility: local-only call with no repo_remote_url', () => {
  it('still resolves via local derivation from repo_path alone', async () => {
    const remoteUrl = `git@github.com:acme/local-only-${tok}.git`;
    const localClone = makeRepo(tmp, 'local-only', remoteUrl);

    expect(resolveProjectSlug(localClone)).toBe(`githubcom-acme-local-only-${tok}`);

    const providers = await getKbProviders(localClone);
    expect(providers.projectSlug).toBe(`githubcom-acme-local-only-${tok}`);
  });
});
