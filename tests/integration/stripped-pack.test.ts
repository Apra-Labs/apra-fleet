import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { extractTgz } from '../helpers/tgz.js';
import { stripComments, countLines } from '../../scripts/lib/strip-comments.mjs';
import { isExempt, shouldStrip, packStripped } from '../../scripts/pack-stripped.mjs';

// apra-fleet-kc3e.4 part A: proves the comment-stripped npm package from REPO
// SOURCES ONLY. CI runs `npm run build` then `npm test` but never
// `npm run dist-pm`, so nothing here may need dist/, dist/workflows or a real
// `npm pack` of the repo. The built-repo proof is the gated sibling
// tests/integration/stripped-pack-install.test.ts (APRA_RUN_PACK_INSTALL=1).

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const JS_RE = /\.(?:js|mjs|cjs)$/;
const AUTO_SPRINT = 'packages/apra-fleet-se/apra-pm/.claude/workflows/auto-sprint.js';

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function rel(p: string): string {
  return path.relative(repoRoot, p).split(path.sep).join('/');
}

/** Shipped JS that needs no build, as repo-relative paths. */
function shippedSources(): string[] {
  const roots = [
    'packages/apra-fleet-se/fleet-sprint',
    'packages/apra-fleet-se/src',
    'packages/apra-fleet-se/bin',
    'hooks',
  ];
  const files = roots.flatMap((r) => walk(path.join(repoRoot, r))).map(rel).filter((f) => JS_RE.test(f));
  files.push('scripts/agy-transcript-reader.js', AUTO_SPRINT);
  return files.filter((f) => fs.existsSync(path.join(repoRoot, f)));
}

/** In-process syntax check: TypeScript's parser diagnostics for a JS file. */
function syntaxErrors(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

function read(f: string): string {
  return fs.readFileSync(path.join(repoRoot, f), 'utf-8');
}

describe('stripped pack, repo-source proof (apra-fleet-kc3e.4 part A)', () => {
  const sources = shippedSources();

  it('finds a meaningful set of shipped sources', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources).toContain(AUTO_SPRINT);
    expect(sources).toContain('packages/apra-fleet-se/bin/cli.mjs');
  });

  it('A1: every shipped source keeps its line count and parses with ZERO errors once stripped', () => {
    const problems: string[] = [];
    for (const f of sources) {
      const text = read(f);
      const out = stripComments(text, { fileName: f });
      if (countLines(out) !== countLines(text)) problems.push(`${f}: line count ${countLines(text)} -> ${countLines(out)}`);
      const after = syntaxErrors(f, out);
      if (after.length > 0) problems.push(`${f}: ${after.length} parse error(s) after stripping: ${after.join('; ')}`);
      if (stripComments(out, { fileName: f }) !== out) problems.push(`${f}: not idempotent`);
    }
    expect(problems).toEqual([]);
  }, 120000);

  it('A2: every file under the client and workflow packages is exempt from stripping', () => {
    const exemptRoots = ['packages/apra-fleet-client', 'packages/apra-fleet-workflow'];
    const files = exemptRoots.flatMap((r) => walk(path.join(repoRoot, r))).map(rel);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(isExempt(f), f).toBe(true);
      expect(shouldStrip(f), f).toBe(false);
    }
    // Non-exempt JS is stripped; non-JS never is.
    expect(shouldStrip('packages/apra-fleet-se/bin/cli.mjs')).toBe(true);
    expect(shouldStrip('dist/index.js')).toBe(true);
    expect(shouldStrip('dist/index.d.ts')).toBe(false);
    expect(shouldStrip('skills/pm/doc.md')).toBe(false);
  });

  it('A3: shebang, license comments and the PURE_FUNCTIONS block survive', () => {
    const cli = 'packages/apra-fleet-se/bin/cli.mjs';
    const cliOut = stripComments(read(cli), { fileName: cli });
    expect(cliOut.startsWith('#!/usr/bin/env node')).toBe(true);

    const lic = stripComments('/*! keep */\n/** @license MIT */\n// drop\nvar a = 1;\n', { fileName: 'l.js' });
    expect(lic).toContain('/*! keep */');
    expect(lic).toContain('@license MIT');
    expect(lic).not.toContain('drop');

    const wf = stripComments(read(AUTO_SPRINT), { fileName: AUTO_SPRINT });
    // Same extraction as src/cli/install.ts (about line 2050).
    const blockStart = wf.indexOf('// PURE_FUNCTIONS_BEGIN');
    const blockEndIdx = wf.indexOf('// PURE_FUNCTIONS_END');
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEndIdx).toBeGreaterThan(blockStart);
    const block = wf.slice(blockStart, blockEndIdx + '// PURE_FUNCTIONS_END'.length);
    const exportsObj = new Function(
      `${block}\nreturn { DEFAULT_CALIBRATION, computeSprintQuote, computeSprintAnalysis, accumulateBucketTokens, computeUpdatedCalibration, buildSprintSummary, buildExecutionSummary, reviewerModelFor };`,
    )();
    expect(typeof exportsObj.computeSprintQuote).toBe('function');
    expect(typeof exportsObj.reviewerModelFor).toBe('function');
    expect(exportsObj.DEFAULT_CALIBRATION).toBeTruthy();
  });

  it('A4: stripping strictly reduces the total size of the shipped sources', () => {
    let before = 0;
    let after = 0;
    for (const f of sources) {
      const text = read(f);
      before += Buffer.byteLength(text);
      after += Buffer.byteLength(stripComments(text, { fileName: f }));
    }
    expect(after).toBeLessThan(before);
  }, 120000);
});

describe('pack-stripped mechanics on a fixture package (apra-fleet-kc3e.4 part A5)', () => {
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  let sandbox: string | undefined;

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of walk(dir)) out[path.relative(dir, f)] = fs.readFileSync(f, 'utf-8');
    return out;
  }

  it('stages, strips JS, keeps the exempt file byte-identical, leaves the source untouched and cleans up', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stripped-pack-fixture-'));
    const src = path.join(sandbox, 'src-pkg');
    const outDir = path.join(sandbox, 'out');
    const tmp = path.join(sandbox, 'tmp');
    fs.mkdirSync(tmp);
    fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(src, 'packages', 'apra-fleet-client', 'src'), { recursive: true });

    const jsWithComments = '// header comment\n/**\n * Doc block\n */\nexport function f() {\n  return 1; /* inline */\n}\n';
    const exemptText = '/**\n * @typedef {object} Keep\n */\nexport const k = 1; // keep me\n';
    fs.writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({
        name: 'fixture-pkg',
        version: '1.2.3',
        files: ['dist/', 'packages/apra-fleet-client/src/'],
        scripts: { prepare: 'node -v', prepack: 'node -v', postinstall: 'node -v' },
      }),
    );
    fs.writeFileSync(path.join(src, 'dist', 'index.js'), jsWithComments);
    fs.writeFileSync(path.join(src, 'dist', 'notes.md'), '// not js, untouched\n');
    fs.writeFileSync(path.join(src, 'packages', 'apra-fleet-client', 'src', 'client.js'), exemptText);
    const before = snapshot(src);

    // Point the script's temp staging at the sandbox so a leftover is detectable.
    process.env.TMPDIR = tmp;
    process.env.TEMP = tmp;
    process.env.TMP = tmp;

    const res = packStripped({ root: src, outDir });
    expect(res.stagingDir).toBeNull();
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('apra-pack-stripped-'))).toEqual([]); // no leftover staging dir
    expect(res.strippedCount).toBe(1);
    expect(res.afterSize).toBeLessThan(res.beforeSize);

    const ex = path.join(sandbox, 'extracted');
    fs.mkdirSync(ex);
    extractTgz(res.tarball, ex);
    const pkg = path.join(ex, 'package');
    const stripped = fs.readFileSync(path.join(pkg, 'dist', 'index.js'), 'utf-8');
    expect(stripped).not.toContain('header comment');
    expect(stripped).not.toContain('Doc block');
    expect(stripped).not.toContain('inline');
    expect(stripped.split('\n').length).toBe(jsWithComments.split('\n').length);
    expect(stripped).toContain('export function f()');
    expect(fs.readFileSync(path.join(pkg, 'dist', 'notes.md'), 'utf-8')).toBe('// not js, untouched\n');
    expect(fs.readFileSync(path.join(pkg, 'packages', 'apra-fleet-client', 'src', 'client.js'))).toEqual(
      Buffer.from(exemptText),
    );
    // Pack-time lifecycle scripts are dropped from the staged package.json; install-time ones stay.
    expect(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf-8')).scripts).toEqual({ postinstall: 'node -v' });

    expect(snapshot(src)).toEqual(before); // fixture source unchanged
  }, 120000);

  it('fails loudly, leaving no tarball, when the build precondition file is missing', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stripped-pack-fixture-'));
    const src = path.join(sandbox, 'src-pkg');
    const outDir = path.join(sandbox, 'out');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    expect(() => packStripped({ root: src, outDir })).toThrow(/dist\/index\.js is missing/);
    expect(fs.existsSync(outDir)).toBe(false);
  });
});
