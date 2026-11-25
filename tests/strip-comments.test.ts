import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { stripComments, countLines } from '../scripts/lib/strip-comments.mjs';

// ECMAScript line terminators U+2028 / U+2029, built so this file stays ASCII.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const CR = 13;
const LF = 10;

function lineCount(s: string): number {
  // Independent of countLines on purpose, so a broken shared helper cannot
  // make both sides of the comparison agree. CRLF counts once.
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CR && s.charCodeAt(i + 1) === LF) continue;
    if (c === LF || c === CR || c === 0x2028 || c === 0x2029) n++;
  }
  return n;
}

/** Parse as a classic script (shebang allowed by wrapping check), throws on error. */
function assertParses(src: string): void {
  const body = src.startsWith('#!') ? '//' + src : src;
  // eslint-disable-next-line no-new
  new vm.Script(body);
}

function strip(src: string): string {
  const out = stripComments(src, { fileName: 'fixture.js' });
  expect(lineCount(out)).toBe(lineCount(src));
  assertParses(out);
  expect(stripComments(out, { fileName: 'fixture.js' })).toBe(out); // idempotent
  return out;
}

describe('stripComments', () => {
  it('removes JSDoc blocks and // line comments', () => {
    const src = '/**\n * Doc\n * @param {string} a\n */\nfunction f(a) {\n  return a; // trailing\n}\n// whole line\n';
    const out = strip(src);
    expect(out).not.toContain('Doc');
    expect(out).not.toContain('trailing');
    expect(out).not.toContain('whole line');
    expect(out).toContain('function f(a) {');
    expect(out).toContain('return a;');
  });

  it('keeps identifiers separated when a block comment sat between them', () => {
    const out = strip('let/**/x = 1;\nvar a = typeof/* c */b;\n');
    expect(out).toContain('let x = 1;');
    expect(out).toContain('typeof b');
  });

  it('preserves ASI: a multi-line block comment still acts as a line terminator', () => {
    const src = 'var a = 1/*\n*/var b = 2\n';
    const out = strip(src);
    expect(out).toContain('1\nvar b');
  });

  it('keeps a regex literal containing /* and // intact', () => {
    const src = 'var r = /\\/\\*|\\/\\/x/g; // c\nvar s = /[/*]/.test("a");\n';
    const out = strip(src);
    expect(out).toContain('/\\/\\*|\\/\\/x/g');
    expect(out).toContain('/[/*]/.test("a")');
    expect(out).not.toContain('// c');
  });

  it('treats division next to a comment as division', () => {
    const out = strip('var a = 4 /* c */ / 2; // d\nvar b = a / 2 / 1;\n');
    expect(out).toMatch(/4 +\/ 2;/);
    expect(out).toContain('a / 2 / 1');
  });

  it('keeps // and /* inside strings and template literals (URLs included)', () => {
    const src = [
      "var a = 'http://example.com/*x*/';",
      'var b = "// not a comment /* nor this */";',
      'var c = `https://x.y/z // w /* v */`;',
      '',
    ].join('\n');
    expect(strip(src)).toBe(src);
  });

  it('handles nested template literals with comments inside ${...}', () => {
    const src = 'var t = `a ${ /* c1 */ b + `x ${ c // c2\n } y` } z // keep`;\n';
    const out = strip(src);
    expect(out).not.toContain('c1');
    expect(out).not.toContain('c2');
    expect(out).toContain(' z // keep`');
    expect(out).toContain('x ${');
  });

  it('keeps the shebang line', () => {
    const src = '#!/usr/bin/env node\n// gone\nconsole.log(1);\n';
    const out = strip(src);
    expect(out.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(out).not.toContain('gone');
  });

  it('keeps /*! and @license/@preserve/@copyright comments', () => {
    const src = '/*! bundled by x */\n/** @license MIT */\n/* @preserve keep */\n/* @copyright me */\n/* drop me */\nvar a = 1;\n';
    const out = strip(src);
    expect(out).toContain('/*! bundled by x */');
    expect(out).toContain('@license MIT');
    expect(out).toContain('@preserve keep');
    expect(out).toContain('@copyright me');
    expect(out).not.toContain('drop me');
  });

  it('keeps the PURE_FUNCTIONS markers (read at install time) and strips prose mentioning them', () => {
    const src = [
      '// PURE_FUNCTIONS_BEGIN -- extracted by tests',
      '// helper doc',
      'function f() { return 1; }',
      '// PURE_FUNCTIONS_END',
      '// note: stays below PURE_FUNCTIONS_END only in prose',
      '',
    ].join('\n');
    const out = strip(src);
    expect(out).toContain('// PURE_FUNCTIONS_BEGIN -- extracted by tests');
    expect(out).toContain('// PURE_FUNCTIONS_END');
    expect(out).not.toContain('helper doc');
    expect(out).not.toContain('in prose');
    // The same extraction src/cli/install.ts performs still works.
    const s = out.indexOf('// PURE_FUNCTIONS_BEGIN');
    const e = out.indexOf('// PURE_FUNCTIONS_END');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(e).toBeGreaterThan(s);
  });

  it('preserves CRLF line terminators', () => {
    const src = '/* a\r\n b\r\n c */\r\nvar x = 1; // t\r\nvar y = 2;\r\n';
    const out = strip(src);
    expect(out).toBe('\r\n\r\n\r\nvar x = 1;\r\nvar y = 2;\r\n');
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('keeps U+2028 / U+2029 line terminators inside a multi-line block comment', () => {
    const src = 'var a = 1;/* x' + LS + 'y' + PS + 'z */var b = 2;\n';
    expect(lineCount(src)).toBe(4);
    const out = strip(src);
    expect(out).toBe('var a = 1;' + LS + PS + 'var b = 2;\n');
  });

  it('ends a // comment at U+2028', () => {
    const src = 'var a = 1; // c' + LS + 'var b = 2;\n';
    expect(strip(src)).toBe('var a = 1;' + LS + 'var b = 2;\n');
  });

  it('countLines counts CRLF once and LS/PS, and ignores the digits 2028/2029', () => {
    expect(countLines('a\r\nb\rc\nd' + LS + 'e' + PS + 'f')).toBe(6);
    const src = '// fixed in 2028 and 2029\nvar a = 1;\n';
    expect(countLines(src)).toBe(3);
    expect(countLines(stripComments(src))).toBe(countLines(src));
  });

  it('does not touch comment-free input', () => {
    const src = 'const a = { b: 1 };\nexport default a;\n';
    expect(stripComments(src, { fileName: 'x.mjs' })).toBe(src);
  });

  it('actually removes comments (fails if the module were an identity function)', () => {
    const src = '// one\n/* two */\nvar a = 1; /* three */\n';
    const out = stripComments(src, { fileName: 'x.js' });
    expect(out).not.toMatch(/one|two|three/);
    expect(out.length).toBeLessThan(src.length);
  });
});
