import { describe, it, expect } from 'vitest';
import {
  ALLOWED_EXCEPTIONS,
  ANCHOR_RE,
  applyExceptions,
  discoverPackageTestDirs,
  formatReport,
  runScan,
  scanFile,
} from '../scripts/check-bd-env-strip.mjs';

// Guards the BEADS_DIR leak fixed in my-beads-db-qy8.9 (and its follow-ups,
// my-beads-db-qy8.9.3): bd resolves BEADS_DIR before it ever looks at cwd, so
// any test harness that spawns the real bd CLI into a scratch/tempdir/toy-repo
// clone without stripping BEADS_DIR from the child env silently hits the
// operator's own ambient beads workspace instead -- this already rewrote a
// real beads remote twice via the f34 test before the fix landed. Nothing
// mechanically stops the NEXT contributor from adding one more unstripped
// real-bd spawn; this is that mechanical net. See
// scripts/check-bd-env-strip.mjs for the full rule, scanned file set, and the
// allowlist/exception mechanism.
describe('bd child-env strip check', () => {
  it('reports zero real bd child-process spawns that do not provably strip BEADS_DIR', () => {
    const { violations, stale } = runScan();
    expect(violations, formatReport(violations, stale)).toEqual([]);
    expect(stale, formatReport([], stale)).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Mutation self-checks: these fixture sources are fed directly to
  // scanFile() so the guard's own behavior is pinned, not just "the current
  // tree is clean" (which stays green even if the scanner silently becomes
  // a no-op -- the exact failure mode that let two real unstripped spawns,
  // spawnSync('bd dolt remote add origin file:///tmp/x', { shell: true })
  // and execFileSync('bd init --from-jsonl', { shell: true }), slip past an
  // earlier version of this guard).
  // ---------------------------------------------------------------------

  describe('flagged shapes: each callee the guard exists to catch', () => {
    it('argv-style callees with no env at all', () => {
      const cases: Array<[string, string]> = [
        ['execFile', "execFile('bd', ['list'], (err) => {});"],
        ['execFileSync', "execFileSync('bd', ['init'], { cwd });"],
        ['spawn', "spawn('bd', ['dolt', 'pull'], { cwd });"],
        ['spawnSync', "spawnSync('bd', ['--version'], { cwd });"],
      ];
      for (const [callee, src] of cases) {
        const findings = scanFile('fixture.mjs', src);
        expect(findings.map((f) => f.callee), `${callee}: ${JSON.stringify(findings)}`).toEqual([callee]);
      }
    });

    it('shell-string-style callees (exec/execSync) with no env at all', () => {
      const cases: Array<[string, string]> = [
        ['exec', "exec('bd dolt pull', { cwd }, cb);"],
        ['execSync', "execSync('bd list --json', { cwd });"],
      ];
      for (const [callee, src] of cases) {
        const findings = scanFile('fixture.mjs', src);
        expect(findings.map((f) => f.callee), `${callee}: ${JSON.stringify(findings)}`).toEqual([callee]);
      }
    });

    it('execBdSync/execBdAsync real (2-arg) invocations with no env', () => {
      for (const callee of ['execBdSync', 'execBdAsync']) {
        const src = `${callee}(['list', '--json'], { cwd });`;
        const findings = scanFile('fixture.mjs', src);
        expect(findings.map((f) => f.callee), JSON.stringify(findings)).toEqual([callee]);
      }
    });

    it('REGRESSION (my-beads-db-qy8.9.3 review item 1/2): an ARGV-style callee passed a full shell command string plus shell:true is still a real bd spawn and must be flagged', () => {
      // Exactly the two shapes the previous version of this scanner missed:
      // packages/apra-fleet-se/test/bd-replay-read-cache.test.mjs's
      // `spawnSync('bd --version', { shell: true })` and the sibling
      // `bd dolt remote add`/`bd init --from-jsonl` shapes named in review.
      const cases = [
        "spawnSync('bd dolt remote add origin file:///tmp/x', { cwd, shell: true });",
        "execFileSync('bd init --from-jsonl', { cwd, shell: true });",
        "spawnSync('bd --version', { encoding: 'utf8', timeout: 30000, shell: true });",
      ];
      for (const src of cases) {
        const findings = scanFile('fixture.mjs', src);
        expect(findings.length, `expected a finding for: ${src}`).toBe(1);
      }
    });

    it('an env: value that is a bare `{ ...process.env }` spread (no BEADS_DIR strip) is flagged, not treated as safe', () => {
      const src = "execFileSync('bd', ['init'], { cwd, env: { ...process.env } });";
      const findings = scanFile('fixture.mjs', src);
      expect(findings.length, JSON.stringify(findings)).toBe(1);
      expect(findings[0].reason).toMatch(/does not resolve to a bdChildEnv/);
    });

    it('no options object passed at all', () => {
      const src = "execFileSync('bd', ['init']);";
      const findings = scanFile('fixture.mjs', src);
      expect(findings.length, JSON.stringify(findings)).toBe(1);
      expect(findings[0].reason).toMatch(/no options object/);
    });
  });

  describe('passing shapes: the guard must not flag a provably safe spawn', () => {
    it('env: bdChildEnv() inline', () => {
      const src = "execFileSync('bd', ['init'], { cwd, env: bdChildEnv() });";
      expect(scanFile('fixture.mjs', src)).toEqual([]);
    });

    it('env: <identifier> where the identifier is declared as bdChildEnv() earlier in the file', () => {
      const src = [
        'const BD_CHILD_ENV = bdChildEnv();',
        "execFileSync('bd', ['init'], { cwd, env: BD_CHILD_ENV });",
      ].join('\n');
      expect(scanFile('fixture.mjs', src)).toEqual([]);
    });

    it('env: an inline expression containing an explicit delete ...BEADS_DIR', () => {
      const src = "execFileSync('bd', ['init'], { cwd, env: (() => { const e = { ...process.env }; delete e.BEADS_DIR; return e; })() });";
      expect(scanFile('fixture.mjs', src)).toEqual([]);
    });

    it('the whole options argument is an identifier resolving to an inline object literal with a safe env:', () => {
      const src = [
        'const opts = { cwd, env: bdChildEnv() };',
        "execFileSync('bd', ['init'], opts);",
      ].join('\n');
      expect(scanFile('fixture.mjs', src)).toEqual([]);
    });

    it('execBdSync/execBdAsync with an injected 3rd-positional test double is not a real spawn', () => {
      for (const callee of ['execBdSync', 'execBdAsync']) {
        const src = `${callee}(['list'], { cwd }, fakeExecFileImpl);`;
        expect(scanFile('fixture.mjs', src), callee).toEqual([]);
      }
    });

    it('execBdSync/execBdAsync defensive-guard calls with a non-array first arg throw before any subprocess, so they are not flagged', () => {
      for (const callee of ['execBdSync', 'execBdAsync']) {
        const src = `${callee}('not-an-array' as never, { cwd });`;
        expect(scanFile('fixture.mjs', src), callee).toEqual([]);
      }
    });

    it('a non-bd argv/shell command is ignored entirely', () => {
      const cases = [
        "execFileSync('git', ['status'], { cwd });",
        "exec('npm run build', { cwd });",
        "spawnSync('bdsomethingelse', ['x'], { cwd });",
      ];
      for (const src of cases) expect(scanFile('fixture.mjs', src), src).toEqual([]);
    });

    it('a dynamically-built command string cannot be judged statically and is left alone', () => {
      const src = [
        "const cmd = 'bd ' + sub;",
        'exec(cmd, { cwd });',
      ].join('\n');
      expect(scanFile('fixture.mjs', src)).toEqual([]);
    });

    it('comments mentioning a bd spawn do not produce a finding', () => {
      const src = "// execFileSync('bd', ['init'], {});\nconst x = 1;";
      expect(scanFile('fixture.mjs', src)).toEqual([]);
    });
  });

  describe('ALLOWED_EXCEPTIONS: the two-place mechanism, including the per-exception anchor fix (review item 4)', () => {
    it('every current entry (if any) must declare its own anchorRe', () => {
      for (const ex of ALLOWED_EXCEPTIONS) {
        expect(ex.anchorRe, `exception "${ex.name}" must set anchorRe`).toBeInstanceOf(RegExp);
      }
    });

    it('a missing BD-ENV-STRIP-EXCEPTION anchor is a hard error, not a silent pass', () => {
      const exceptions = [{ name: 'test-ex', file: 'fixture.mjs', anchorRe: /some reason/, window: 6 }];
      const contentsByRel = { 'fixture.mjs': 'const x = 1;\n' };
      expect(() => applyExceptions([], contentsByRel, exceptions)).toThrow(/no BD-ENV-STRIP-EXCEPTION anchor/);
    });

    it('an exception entry with no anchorRe at all is also a hard error (forces disambiguation, not a silent first-match)', () => {
      const exceptions = [{ name: 'test-ex', file: 'fixture.mjs', window: 6 }];
      const contentsByRel = { 'fixture.mjs': '// BD-ENV-STRIP-EXCEPTION: some reason\n' };
      expect(() => applyExceptions([], contentsByRel, exceptions)).toThrow(/must set anchorRe/);
    });

    it('an unused exception is reported stale', () => {
      const exceptions = [{ name: 'test-ex', file: 'fixture.mjs', anchorRe: /some reason/, window: 6 }];
      const contentsByRel = { 'fixture.mjs': '// BD-ENV-STRIP-EXCEPTION: some reason\n' };
      const { stale } = applyExceptions([], contentsByRel, exceptions);
      expect(stale).toEqual(['test-ex']);
    });

    it('REGRESSION (review item 4): two exceptions with two distinct anchors in the SAME file each resolve to their own anchor, not the file-wide first one', () => {
      const contentsByRel = {
        'fixture.mjs': [
          '// BD-ENV-STRIP-EXCEPTION: reason one',
          "execFileSync('bd', ['one'], { cwd, env: whatever1 });", // line 2 -- near exception one only
          '',
          '',
          '',
          '',
          '',
          '// BD-ENV-STRIP-EXCEPTION: reason two',
          "execFileSync('bd', ['two'], { cwd, env: whatever2 });", // line 9 -- near exception two only
        ].join('\n'),
      };
      const exceptions = [
        { name: 'ex-one', file: 'fixture.mjs', anchorRe: /reason one/, window: 2 },
        { name: 'ex-two', file: 'fixture.mjs', anchorRe: /reason two/, window: 2 },
      ];
      const findingOne = { file: 'fixture.mjs', line: 2, callee: 'execFileSync', excerpt: 'one', reason: 'r' };
      const findingTwo = { file: 'fixture.mjs', line: 9, callee: 'execFileSync', excerpt: 'two', reason: 'r' };
      const { violations, stale } = applyExceptions([findingOne, findingTwo], contentsByRel, exceptions);
      expect(violations, 'both findings should be absorbed by their own nearby anchor').toEqual([]);
      expect(stale, 'both exceptions were used, so neither is stale').toEqual([]);
    });

    it('a finding too far from its exception\'s anchor is still a violation', () => {
      const contentsByRel = {
        'fixture.mjs': [
          '// BD-ENV-STRIP-EXCEPTION: reason one',
          ...Array(10).fill(''),
          "execFileSync('bd', ['far'], { cwd });",
        ].join('\n'),
      };
      const exceptions = [{ name: 'ex-one', file: 'fixture.mjs', anchorRe: /reason one/, window: 2 }];
      const farFinding = { file: 'fixture.mjs', line: 12, callee: 'execFileSync', excerpt: 'far', reason: 'r' };
      const { violations } = applyExceptions([farFinding], contentsByRel, exceptions);
      expect(violations).toEqual([farFinding]);
    });
  });

  describe('discoverPackageTestDirs (review item 5): both `test` and `tests` package dirs are scanned', () => {
    it('includes packages/fleet-api-contract/tests (plural) in the current tree', () => {
      const dirs = discoverPackageTestDirs();
      expect(dirs).toContain('packages/fleet-api-contract/tests');
    });

    it('still includes a singular `test` package dir', () => {
      const dirs = discoverPackageTestDirs();
      expect(dirs.some((d) => /\/test$/.test(d)), JSON.stringify(dirs)).toBe(true);
    });
  });

  it('ANCHOR_RE matches the documented marker', () => {
    expect(ANCHOR_RE.test('// BD-ENV-STRIP-EXCEPTION: some reason')).toBe(true);
    expect(ANCHOR_RE.test('// nothing to see here')).toBe(false);
  });
});
