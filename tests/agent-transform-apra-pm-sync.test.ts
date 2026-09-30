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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformAgentForAgy, transformAgentForOpenCode } from '../src/cli/agent-transform.js';

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

// ---------------------------------------------------------------------------
// apra-fleet-oomh.11: BEHAVIOURAL cross-implementation guard.
//
// The literal guards above are source-TEXT checks -- nothing executes the
// mirrored code, so a drift in the marker RESOLVER itself (the six other
// symbols on agent-transform.ts's keep-in-sync list) would sail past them.
// This block feeds one shared fixture corpus through BOTH implementations and
// compares real outputs and real thrown messages.
//
// HOW THE TWO SIDES ARE MADE COMPARABLE (the adapter the naming/structure
// asymmetries force):
//
//  * NAMING: the .ts body resolver is resolveConditionalBody(text, isAvailable,
//    label); the .mjs equivalent is resolveAgentConditionals(content, llm,
//    label), which derives isAvailable from the provider internally.
//
//  * DIVISION OF LABOUR: .ts transformAgentForAgy/ForOpenCode resolve body
//    markers INSIDE the transform; the .mjs copies of those two functions do
//    NOT (install() resolves markers in a separate pass before calling them).
//    So the .mjs counterpart of the .ts transforms' marker behaviour is
//    resolveAgentConditionals, not the like-named .mjs transform.
//
//  * WHY FRONTMATTER-LESS FIXTURES: with no frontmatter, .ts
//    transformAgentForAgy(text, label) takes its early-return path, which is
//    exactly resolveConditionalBody(text, toolAvailability(null, <provider
//    tools>), label) -- byte-for-byte the computation .mjs
//    resolveAgentConditionals(text, 'agy', label) performs (its
//    readFrontmatterTools returns null for the same input). That makes the two
//    sides directly comparable through EXPORTED entry points only, so
//    CONDITIONAL_MARKER_RE, resolveConditionalBody, toolAvailability and
//    readFrontmatterTools are all driven transitively. No export is widened to
//    reach a private helper.
//
//  * ERROR CLASS: .ts throws ConditionalMarkerError, .mjs throws a plain Error
//    carrying the identical message. Assertions compare MESSAGE TEXT only -- an
//    instanceof assertion cannot pass on both sides.
//
// "Telepathy" is an invented tool name, so a LACKS case cannot pass by
// special-casing a real tool. Bash is present in BOTH agyToolMap and
// OPENCODE_NATIVE_TOOLS, so it is the shared HAS case.

interface MjsApi {
  resolveAgentConditionals: (content: string, llm: string, label: string) => string;
}

const MJS_MODULE_URL = pathToFileURL(MJS_SOURCE_PATH).href;

/** Providers whose availability rules BOTH implementations model. */
const SHARED_PROVIDERS = ['agy', 'opencode'] as const;
type SharedProvider = (typeof SHARED_PROVIDERS)[number];

const LABEL = 'fixture.md';

const WELL_FORMED: Array<{ name: string; text: string }> = [
  {
    name: 'if/else block for a tool the provider HAS (Bash)',
    text: 'head\n<!-- if-tool: Bash -->\nuse-bash\n<!-- else-tool: Bash -->\nno-bash\n<!-- end-tool: Bash -->\ntail\n',
  },
  {
    name: 'if/else block for a tool the provider LACKS (Telepathy)',
    text: 'head\n<!-- if-tool: Telepathy -->\nuse-tp\n<!-- else-tool: Telepathy -->\nno-tp\n<!-- end-tool: Telepathy -->\ntail\n',
  },
  {
    name: 'else-less if block for a tool the provider HAS (Bash)',
    text: 'head\n<!-- if-tool: Bash -->\nkeep\n<!-- end-tool: Bash -->\ntail\n',
  },
  {
    name: 'else-less if block for a tool the provider LACKS (Telepathy)',
    text: 'head\n<!-- if-tool: Telepathy -->\ndrop\n<!-- end-tool: Telepathy -->\ntail\n',
  },
  {
    name: 'nested blocks (HAS outside, LACKS inside)',
    text: 'a\n<!-- if-tool: Bash -->\nb\n<!-- if-tool: Telepathy -->\nc\n<!-- else-tool: Telepathy -->\nd\n<!-- end-tool: Telepathy -->\ne\n<!-- end-tool: Bash -->\nf\n',
  },
  {
    name: 'nested blocks (LACKS outside, HAS inside -- inner must be discarded with the outer if-branch)',
    text: 'a\n<!-- if-tool: Telepathy -->\nb\n<!-- if-tool: Bash -->\nc\n<!-- end-tool: Bash -->\nd\n<!-- else-tool: Telepathy -->\ne\n<!-- end-tool: Telepathy -->\nf\n',
  },
  {
    name: 'repeated blocks for the same tool',
    text: '<!-- if-tool: Bash -->\none\n<!-- end-tool: Bash -->\nmid\n<!-- if-tool: Bash -->\ntwo\n<!-- else-tool: Bash -->\nnope\n<!-- end-tool: Bash -->\n',
  },
  {
    name: 'repeated blocks for the same LACKED tool',
    text: '<!-- if-tool: Telepathy -->\none\n<!-- else-tool: Telepathy -->\nalt1\n<!-- end-tool: Telepathy -->\nmid\n<!-- if-tool: Telepathy -->\ntwo\n<!-- else-tool: Telepathy -->\nalt2\n<!-- end-tool: Telepathy -->\n',
  },
  {
    name: 'no markers at all (pass-through)',
    text: 'plain prose with no markers\nand a second line\n',
  },
];

const MALFORMED: Array<{ name: string; text: string }> = [
  {
    name: 'else-tool with no open if-tool',
    text: 'a\n<!-- else-tool: Bash -->\nb\n',
  },
  {
    name: 'end-tool whose tool name does not match the open if-tool',
    text: '<!-- if-tool: Bash -->\na\n<!-- end-tool: Telepathy -->\n',
  },
  {
    name: 'duplicate else-tool inside one block',
    text: '<!-- if-tool: Bash -->\na\n<!-- else-tool: Bash -->\nb\n<!-- else-tool: Bash -->\nc\n<!-- end-tool: Bash -->\n',
  },
  {
    name: 'if-tool still unclosed at end of file',
    text: '<!-- if-tool: Bash -->\na\n',
  },
];

/** Thin adapter: run the .ts resolver for `provider` over a frontmatter-less fixture. */
function tsResolve(provider: SharedProvider, text: string, label: string): string {
  return provider === 'agy'
    ? transformAgentForAgy(text, label)
    : transformAgentForOpenCode(text, label);
}

/** Captures a thrown message, or null when the call returned normally. */
function thrownMessage(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe('agent-transform.ts <-> apra-pm/install.mjs resolve conditional bodies identically', () => {
  let mjs: MjsApi;

  beforeAll(async () => {
    mjs = (await import(MJS_MODULE_URL)) as unknown as MjsApi;
  });

  it('exposes the exported entry points both sides of the comparison need', () => {
    expect(typeof mjs.resolveAgentConditionals).toBe('function');
    expect(typeof transformAgentForAgy).toBe('function');
    expect(typeof transformAgentForOpenCode).toBe('function');
  });

  for (const provider of SHARED_PROVIDERS) {
    for (const fixture of WELL_FORMED) {
      it(`${provider}: byte-identical output -- ${fixture.name}`, () => {
        const tsOut = tsResolve(provider, fixture.text, LABEL);
        const mjsOut = mjs.resolveAgentConditionals(fixture.text, provider, LABEL);
        expect(mjsOut).toBe(tsOut);
      });
    }

    for (const fixture of MALFORMED) {
      it(`${provider}: both sides reject with the same message -- ${fixture.name}`, () => {
        const tsMsg = thrownMessage(() => tsResolve(provider, fixture.text, LABEL));
        const mjsMsg = thrownMessage(() => mjs.resolveAgentConditionals(fixture.text, provider, LABEL));

        // Both must actually throw -- a silent pass-through on either side is
        // the failure mode this case exists to catch.
        expect(tsMsg, `.ts side must reject: ${fixture.name}`).not.toBeNull();
        expect(mjsMsg, `.mjs side must reject: ${fixture.name}`).not.toBeNull();
        // Message text only: .ts throws ConditionalMarkerError, .mjs a plain Error.
        expect(mjsMsg).toBe(tsMsg);
        expect(tsMsg).toContain(LABEL);
      });
    }
  }

  it('the corpus actually discriminates: a HAS fixture and a LACKS fixture resolve differently', () => {
    // Guards the guard -- if availability ever became a constant-true/false on
    // both sides in the same way, every comparison above would still pass.
    const has = mjs.resolveAgentConditionals(WELL_FORMED[0].text, 'agy', LABEL);
    const lacks = mjs.resolveAgentConditionals(WELL_FORMED[1].text, 'agy', LABEL);
    expect(has).toContain('use-bash');
    expect(has).not.toContain('no-bash');
    expect(lacks).toContain('no-tp');
    expect(lacks).not.toContain('use-tp');
  });

  it('no marker syntax survives on either side, for either provider', () => {
    for (const provider of SHARED_PROVIDERS) {
      for (const fixture of WELL_FORMED) {
        const out = mjs.resolveAgentConditionals(fixture.text, provider, LABEL);
        expect(out, `${provider}: ${fixture.name}`).not.toMatch(
          /<!--\s*(if-tool|else-tool|end-tool):/
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// apra-fleet-oomh.15: extend the behavioural guard to the DECLARED frontmatter
// tools path and the WILDCARD case.
//
// Every fixture above is frontmatter-less, so toolAvailability(declared,
// supported) is only ever exercised on its `declared === null` branch (every
// tool the provider supports counts as available). This block adds real
// `tools:` frontmatter declarations so two more branches get driven on BOTH
// sides:
//   - the INTERSECTION branch: the intersection of declared tools and provider-supported tools
//     (a tool the provider can express but the agent did not declare must
//     still resolve to its else-branch);
//   - the WILDCARD branch: `tools: [*]` means "everything this provider has",
//     decided by isWildcardTools() in agent-transform.ts (~line 234) and the
//     inlined `declared.some(t => t === '*')` in install.mjs's
//     toolAvailability -- two independent expressions of the same rule that
//     could silently diverge (e.g. one side stops treating a bare '*' entry
//     inside a longer declared list as a wildcard).
//
// COMPARABILITY PROBLEM AND FIX: with frontmatter present, the .ts entry
// points (transformAgentForAgy/transformAgentForOpenCode) also REWRITE the
// frontmatter (name/description echoing, Claude-name -> provider-tool-name
// mapping, the agy auto-approve rules block), while .mjs's
// resolveAgentConditionals only ever resolves body markers and never touches
// frontmatter (see the file-level comment on agent-transform.ts: the .mjs
// transformAgentForAgy/ForOpenCode do that rewriting in a SEPARATE, later
// pass in install()'s loop). Comparing whole outputs would fail on that
// unrelated, already-documented frontmatter-rewrite drift (e.g. install.mjs's
// opencode frontmatter carries an extra `external_directory: allow` line the
// .ts side does not emit) and would prove nothing about toolAvailability.
//
// So each fixture body is wrapped in unique sentinel strings, and both
// outputs are sliced down to the sentinel-delimited substring before
// comparing. That isolates exactly the marker-resolution computation under
// test and is inert to whatever either side does to the frontmatter or
// appends after the body (e.g. agy's auto-approve rules block).

const BODY_START = '@@FIXTURE-BODY-START@@';
const BODY_END = '@@FIXTURE-BODY-END@@';

/** Slices `s` down to the sentinel-delimited body region (sentinels included, so either side dropping a sentinel is itself a visible failure rather than a silent no-op). */
function extractSentinelBody(s: string, context: string): string {
  const start = s.indexOf(BODY_START);
  const end = s.indexOf(BODY_END);
  if (start === -1 || end === -1) {
    throw new Error(`${context}: sentinel missing from output (start=${start}, end=${end})`);
  }
  return s.slice(start, end + BODY_END.length);
}

/** Wraps a WELL_FORMED-style marker fixture body in the extraction sentinels. */
function wrapBody(text: string): string {
  return `${BODY_START}\n${text}${BODY_END}\n`;
}

/** Thin adapter: run the .ts resolver for `provider` over content that HAS a real frontmatter block. */
function tsResolveWithFrontmatter(
  provider: SharedProvider,
  content: string,
  label: string
): string {
  return provider === 'agy'
    ? transformAgentForAgy(content, label)
    : transformAgentForOpenCode(content, label);
}

interface DeclaredFixture {
  name: string;
  /** Raw frontmatter `tools:` value, in Claude tool names. */
  toolsDecl: string;
  /** A WELL_FORMED-style marker body (sentinels are added by wrapBody). */
  body: string;
  expectContains: string[];
  expectExcludes: string[];
}

const DECLARED_FIXTURES: DeclaredFixture[] = [
  {
    name: 'declared list intersects provider support (tools: [Read, Bash] -- Bash is declared AND supported)',
    toolsDecl: '[Read, Bash]',
    body: WELL_FORMED[0].text, // if/else block on Bash
    expectContains: ['use-bash'],
    expectExcludes: ['no-bash'],
  },
  {
    name: 'declared list withholds a tool the provider otherwise supports (tools: [Read] -- Bash not declared)',
    toolsDecl: '[Read]',
    body: WELL_FORMED[0].text, // if/else block on Bash
    expectContains: ['no-bash'],
    expectExcludes: ['use-bash'],
  },
  {
    name: 'wildcard tools (tools: [*]) grants every provider-supported tool (Bash)',
    toolsDecl: '[*]',
    body: WELL_FORMED[0].text, // if/else block on Bash
    expectContains: ['use-bash'],
    expectExcludes: ['no-bash'],
  },
  {
    name: 'wildcard tools (tools: [*]) does not grant a tool the provider fundamentally lacks (Telepathy)',
    toolsDecl: '[*]',
    body: WELL_FORMED[1].text, // if/else block on Telepathy
    expectContains: ['no-tp'],
    expectExcludes: ['use-tp'],
  },
];

describe('agent-transform.ts <-> apra-pm/install.mjs resolve conditional bodies identically with declared frontmatter tools', () => {
  let mjs: MjsApi;

  beforeAll(async () => {
    mjs = (await import(MJS_MODULE_URL)) as unknown as MjsApi;
    // The wildcard fixture declares `tools: [*]`, which is not a key in
    // agyToolMap -- both transformAgentForAgy implementations log a "dropping
    // tools with no Antigravity equivalent" warning for it. That warning is
    // expected noise for this fixture, not a signal this suite checks.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  for (const provider of SHARED_PROVIDERS) {
    for (const fixture of DECLARED_FIXTURES) {
      it(`${provider}: byte-identical resolved body -- ${fixture.name}`, () => {
        const content = `---\ntools: ${fixture.toolsDecl}\n---\n${wrapBody(fixture.body)}`;

        const tsOut = tsResolveWithFrontmatter(provider, content, LABEL);
        const mjsOut = mjs.resolveAgentConditionals(content, provider, LABEL);

        const tsBody = extractSentinelBody(tsOut, `.ts ${provider}`);
        const mjsBody = extractSentinelBody(mjsOut, `.mjs ${provider}`);

        expect(mjsBody).toBe(tsBody);
        for (const expected of fixture.expectContains) {
          expect(tsBody, `${provider}: ${fixture.name}`).toContain(expected);
        }
        for (const excluded of fixture.expectExcludes) {
          expect(tsBody, `${provider}: ${fixture.name}`).not.toContain(excluded);
        }
      });
    }
  }
});
