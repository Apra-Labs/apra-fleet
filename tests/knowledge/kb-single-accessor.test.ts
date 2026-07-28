import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.join(process.cwd(), 'src');

// Files where a no-arg getKbProviders() call is legitimate: single-repo CLI
// entry points where process.cwd() IS the repo the command is about. Never
// legitimate for a server-handled tool call (see the getKbProviders doc
// comment at src/services/knowledge/kb-providers.ts:64-68) -- a new entry
// here must be a one-shot CLI command, not a src/tools/* handler.
const NO_ARG_ALLOWLIST = [
  'src/cli/kb-directives.ts', // runKbDirectives: `apra-fleet kb directives` and friends
  'src/index.ts', // the `apra-fleet kb invalidate` command
].sort();

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('kb single accessor guard', () => {
  const files = walkTsFiles(SRC_DIR);

  it('getKbProviders is the only route to a KB provider (no getKBService / class KBService under src/)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf-8');
      if (contents.includes('getKBService') || contents.includes('class KBService')) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no-arg getKbProviders() calls exist only in the documented single-repo CLI allowlist', () => {
    const noArgCallPattern = /getKbProviders\(\s*\)/;
    const found: string[] = [];
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf-8');
      if (noArgCallPattern.test(contents)) {
        found.push(path.relative(process.cwd(), file).split(path.sep).join('/'));
      }
    }
    expect(found.sort()).toEqual(NO_ARG_ALLOWLIST);
  });
});
