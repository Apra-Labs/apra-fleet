import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Inline the link-parsing logic from gen-llms-full.mjs so we can unit-test it
// without spawning a subprocess.
function parseLocalLinks(llmsTxt: string): Array<{ title: string; path: string; desc: string }> {
  const LINK_RE = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.+))?/gm;
  const seen = new Set<string>();
  const results: Array<{ title: string; path: string; desc: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(llmsTxt)) !== null) {
    const title = match[1].trim();
    const rawUrl = match[2].trim();
    const desc = match[3] ? match[3].trim() : '';

    if (/^https?:\/\//i.test(rawUrl) || /^mailto:/i.test(rawUrl)) continue;

    const urlNoFragment = rawUrl.replace(/#.*$/, '');
    if (!urlNoFragment) continue;

    const resolvedPath = join(root, urlNoFragment);
    if (!existsSync(resolvedPath)) continue;
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);

    results.push({ title, path: urlNoFragment, desc });
  }
  return results;
}

describe('gen-llms-full: link parser', () => {
  const llmsTxt = readFileSync(join(root, 'llms.txt'), 'utf-8');
  const docs = parseLocalLinks(llmsTxt);

  it('extracts exactly 17 local docs from llms.txt', () => {
    expect(docs).toHaveLength(17);
  });

  it('skips http/https external links', () => {
    for (const doc of docs) {
      expect(doc.path).not.toMatch(/^https?:\/\//);
    }
  });

  it('all parsed paths exist on disk', () => {
    for (const doc of docs) {
      expect(existsSync(join(root, doc.path)), `missing: ${doc.path}`).toBe(true);
    }
  });

  it('docs appear in the required order', () => {
    const expectedOrder = [
      'README.md',
      'docs/vocabulary.md',
      'docs/architecture.md',
      'docs/install.md',
      'docs/features/update.md',
      'docs/ssh-setup.md',
      'docs/features/oob-auth.md',
      'docs/design-git-auth.md',
      'docs/provider-guide.md',
      'docs/cloud-compute.md',
      'docs/writing-skills.md',
      'vendor/apra-pm/skills/pm/SKILL.md',
      'docs/beads.md',
      'docs/FAQ.md',
      'docs/troubleshooting.md',
      'ROADMAP.md',
      'CONTRIBUTING.md',
    ];
    expect(docs.map(d => d.path)).toEqual(expectedOrder);
  });
});

describe('gen-llms-full: llms-full.txt output', () => {
  const llmsTxt = readFileSync(join(root, 'llms.txt'), 'utf-8');
  const docs = parseLocalLinks(llmsTxt);

  it('llms-full.txt exists', () => {
    expect(existsSync(join(root, 'llms-full.txt'))).toBe(true);
  });

  it('llms-full.txt contains one <doc> element per local link, in order', () => {
    const full = readFileSync(join(root, 'llms-full.txt'), 'utf-8');
    const titleRE = /<doc title="([^"]+)"/g;
    const embeddedTitles: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = titleRE.exec(full)) !== null) embeddedTitles.push(m[1]);

    expect(embeddedTitles).toHaveLength(docs.length);
    for (let i = 0; i < docs.length; i++) {
      expect(embeddedTitles[i]).toBe(docs[i].title);
    }
  });

  it('llms-full.txt does not embed any external community links as doc elements', () => {
    const full = readFileSync(join(root, 'llms-full.txt'), 'utf-8');
    expect(full).not.toMatch(/<doc title="GitHub/);
    expect(full).not.toMatch(/<doc title="Releases/);
    expect(full).not.toMatch(/<doc title="Issues/);
  });
});
