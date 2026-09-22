// apra-fleet-oomh.7: packages/apra-fleet-se/apra-pm/install.mjs is NOT an npm
// workspace (see the comment at its own agyToolMap/OPENCODE_NATIVE_TOOLS), so it
// carries its own hand-copied mirrors of two literals declared in
// src/cli/agent-transform.ts: agyToolMap and OPENCODE_NATIVE_TOOLS. Those two
// literals decide, per provider, which tools survive a transformed agent's
// frontmatter AND which <!-- if-tool --> body prose resolves to the if-branch
// (see resolveAgentConditionals/toolAvailability in both files) -- if the mjs
// copy drifts from the .ts source, an agy- or opencode-provider install can
// silently keep body prose for a tool its own frontmatter just dropped, which is
// exactly the split-brain bug apra-fleet-oomh was filed to fix one level up.
//
// This is a cheap source-text guard, not an executed-code guard: it extracts
// each literal's text out of both files with a regex and parses it with `new
// Function(...)` (safe here -- the extracted text is a plain object/array
// literal from a file already checked into this repo, not external input) so a
// human edit to one side without the other fails this suite instead of shipping.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TS_SOURCE_PATH = path.join(__dirname, '..', 'src', 'cli', 'agent-transform.ts');
const MJS_SOURCE_PATH = path.join(
  __dirname,
  '..',
  'packages',
  'apra-fleet-se',
  'apra-pm',
  'install.mjs'
);

/** Pulls the literal assigned to `const <varName> = <literal>;` (optionally `export const`, optionally TS-annotated) out of raw source text. */
function extractLiteralSource(source: string, varName: string): string {
  const re = new RegExp(
    `(?:export )?const\\s+${varName}(?:\\s*:\\s*[^=]+)?\\s*=\\s*([\\s\\S]*?);`
  );
  const match = source.match(re);
  if (!match) {
    throw new Error(`could not find "const ${varName} = ..." in source`);
  }
  return match[1];
}

/** Parses an extracted object/array literal string into a real JS value. */
function parseLiteral(literalText: string): unknown {
  // eslint-disable-next-line no-new-func -- trusted, already-checked-in source text, not external input
  return new Function(`return (${literalText});`)();
}

describe('agent-transform.ts <-> apra-pm/install.mjs mirrored literals stay in sync', () => {
  const tsSource = fs.readFileSync(TS_SOURCE_PATH, 'utf-8');
  const mjsSource = fs.readFileSync(MJS_SOURCE_PATH, 'utf-8');

  it('agyToolMap is byte-identical (as parsed values) between the two files', () => {
    const tsValue = parseLiteral(extractLiteralSource(tsSource, 'agyToolMap'));
    const mjsValue = parseLiteral(extractLiteralSource(mjsSource, 'agyToolMap'));
    expect(mjsValue).toEqual(tsValue);
  });

  it('OPENCODE_NATIVE_TOOLS is byte-identical (as parsed values) between the two files', () => {
    const tsValue = parseLiteral(extractLiteralSource(tsSource, 'OPENCODE_NATIVE_TOOLS'));
    const mjsValue = parseLiteral(extractLiteralSource(mjsSource, 'OPENCODE_NATIVE_TOOLS'));
    expect(mjsValue).toEqual(tsValue);
  });
});
