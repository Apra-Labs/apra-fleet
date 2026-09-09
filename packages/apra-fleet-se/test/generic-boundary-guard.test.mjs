import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ALLOWED_EXCEPTIONS,
    PACKAGE_ROOT,
    REPO_ROOT,
    TARGET_FILE_CONTRACT,
    applyExceptions,
    extractStringLiterals,
    runEngineScan,
    scanSource,
} from '../scripts/check-generic-boundary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Generic-engine boundary guard (the "dogfood safety net").
//
// Invariant under test: nothing in the LLM-facing text of the generic
// fleet-sprint engine (fleet-sprint/**/*.{js,mjs} string literals with
// comments stripped, apra-pm/agents/**/*.md minus HTML comments) assumes the
// sprint target is apra-fleet -- its build artifacts, env vars, supervisor
// port, repo layout, tracker ids, or deploy.md/playbook sections beyond the
// documented target contract. See docs/generic-engine-boundary.md.
//
// The checker lives in ../scripts/check-generic-boundary.mjs, parameterizable
// by source text, so it can be pointed at a fixture that deliberately
// violates the invariant (the real Sandbox Deploy leak, vendored verbatim)
// -- proving the guard fails on the incident it was built for rather than
// passing vacuously -- WITHOUT mutating runner.js to manufacture it.
// =============================================================================

const fixture = (name) => path.join(__dirname, 'fixtures/generic-boundary', name);
const read = (p) => fs.readFileSync(p, 'utf8');
const check = (cond, msg) => assert.ok(cond, msg);

const idCounts = (findings) => {
    const counts = {};
    for (const f of findings) counts[f.id] = (counts[f.id] || 0) + 1;
    return counts;
};

test('generic-boundary guard passes on the current engine file set (no undeclared finding, no stale exception)', () => {
    const { files, violations, stale } = runEngineScan();
    check(files.length > 0, 'expected the engine file set to be non-empty');
    check(files.some((f) => f.rel === 'fleet-sprint/runner.js'), 'engine file set must include fleet-sprint/runner.js');
    check(files.some((f) => f.rel === 'apra-pm/agents/deployer.md'), 'engine file set must include apra-pm/agents/deployer.md');
    check(
        violations.length === 0,
        `Expected zero apra-fleet-specific assumptions in LLM-facing engine text, found:\n${JSON.stringify(violations, null, 2)}`
    );
    check(stale.length === 0, `Stale ALLOWED_EXCEPTIONS entries (cover no finding): ${stale.join(', ')}`);
});

test('mutation self-check: the vendored Sandbox Deploy leak (commit 002c0632) yields exactly the six real findings', () => {
    const src = read(fixture('sandbox-deploy-leak.runner-excerpt.js'));
    const findings = scanSource('fleet-sprint/runner.js', src, 'js');
    const counts = idCounts(findings);
    assert.deepStrictEqual(
        counts,
        { 'undocumented-target-section': 1, 'apra-fleet-build-artifact': 2, 'apra-fleet-env-var': 3 },
        `unexpected finding mix: ${JSON.stringify(findings, null, 2)}`
    );
    const matches = findings.map((f) => f.match).sort();
    assert.deepStrictEqual(
        matches,
        ['## Sandbox Deploy', 'APRA_FLEET_DATA_DIR', 'APRA_FLEET_PORT', 'FLEET_SE_DATA_DIR', 'dist/index.js', 'install --force'].sort()
    );
    // The documented '## Deploy' section named in the same prompt is NOT a finding.
    check(!findings.some((f) => f.match === '## Deploy'), "the contract heading '## Deploy' must never be flagged");
    // Every finding is educational: it says where the content belongs instead.
    for (const f of findings) {
        check(typeof f.why === 'string' && f.why.length > 20, `finding ${f.id} must explain why`);
        check(typeof f.belongs === 'string' && /deploy\.md|CLAUDE\.md|docs\//.test(f.belongs), `finding ${f.id} must say where the content belongs`);
    }
});

test('mutation self-check: a clean deployer prompt that names only contract sections yields zero findings', () => {
    const src = [
        'const deployerPrompt =',
        "    'Deploy to test env using deploy.md.\\n' +",
        "    \"Execute its '## Deploy' section, then run '## Smoke test'. \" +",
        "    'If deploy.md offers a sandbox section, prefer it; otherwise use the production one.';",
    ].join('\n');
    const findings = scanSource('fleet-sprint/runner.js', src, 'js');
    check(findings.length === 0, `expected no findings for a contract-only prompt, got: ${JSON.stringify(findings, null, 2)}`);
});

test('mutation self-check: the pre-incident deployer.md role prompt yields zero findings', () => {
    const src = read(path.join(PACKAGE_ROOT, 'apra-pm/agents/deployer.md'));
    const findings = scanSource('apra-pm/agents/deployer.md', src, 'md');
    check(findings.length === 0, `deployer.md must be clean, got: ${JSON.stringify(findings, null, 2)}`);
});

test('the leak is only a leak in LLM-facing positions: the same strings in comments and identifiers are ignored', () => {
    const src = [
        '// deploy.md ## Sandbox Deploy uses dist/index.js with APRA_FLEET_DATA_DIR (apra-fleet-5co8.37)',
        '/* install --force on localhost:8787, packages/apra-fleet-se */',
        'const dataDir = process.env.APRA_FLEET_DATA_DIR || defaults.APRA_FLEET_PORT;',
        "const port = 8787; // localhost:8787",
    ].join('\n');
    const findings = scanSource('fleet-sprint/runner.js', src, 'js');
    check(findings.length === 0, `comments/identifiers must never be findings, got: ${JSON.stringify(findings, null, 2)}`);
});

test('bead ids are findings in runtime strings but package names are not', () => {
    const bad = "throw new Error('see apra-fleet-417.5 and apra-fleet-eft.37.5 and apra-fleet-5co8');";
    const good = "import x from '@apralabs/apra-fleet-workflow'; const p = 'packages/apra-fleet-client-ish'; const s = 'apra-fleet-se';";
    const badFindings = scanSource('fleet-sprint/x.mjs', bad, 'js').filter((f) => f.id === 'bead-id-in-llm-text');
    assert.deepStrictEqual(badFindings.map((f) => f.match), ['apra-fleet-417.5', 'apra-fleet-eft.37.5', 'apra-fleet-5co8']);
    const goodFindings = scanSource('fleet-sprint/x.mjs', good, 'js').filter((f) => f.id === 'bead-id-in-llm-text');
    check(goodFindings.length === 0, `package names must not match the bead-id shape, got: ${JSON.stringify(goodFindings)}`);
});

test('reference target: every required contract heading exists as a `## ` line in the vendored fleet-e2e-toy files', () => {
    const fixtureFor = {
        'deploy.md': 'fleet-e2e-toy.deploy.md',
        'integ-test-playbook.md': 'fleet-e2e-toy.integ-test-playbook.md',
    };
    for (const [file, contract] of Object.entries(TARGET_FILE_CONTRACT)) {
        if (!fixtureFor[file]) continue; // fleet-e2e-toy ships no regression playbook (the phase is optional)
        const headings = read(fixture(fixtureFor[file]))
            .split('\n')
            .filter((l) => /^## /.test(l))
            .map((l) => l.replace(/^## /, '').trim().toLowerCase());
        for (const h of contract.required) {
            check(headings.includes(h.toLowerCase()), `${file}: required heading '## ${h}' is missing from the reference target ${fixtureFor[file]} -- the engine may not require it`);
        }
    }
});

test('contract-vs-docs: every required heading is documented in docs/fleet-sprint-getting-started.md as the target contract', () => {
    const doc = read(path.join(REPO_ROOT, 'docs/fleet-sprint-getting-started.md'));
    for (const [file, contract] of Object.entries(TARGET_FILE_CONTRACT)) {
        for (const h of contract.required) {
            check(doc.includes('`## ' + h + '`'), `${file}: required heading '## ${h}' is not documented in docs/fleet-sprint-getting-started.md`);
        }
        // Optional headings may be named only conditionally; they must at least
        // be a section the docs or the reference target shows a target writing.
        const referenceHeadings = ['fleet-e2e-toy.deploy.md', 'fleet-e2e-toy.integ-test-playbook.md']
            .flatMap((f) => read(fixture(f)).split('\n').filter((l) => /^## /.test(l)).map((l) => l.replace(/^## /, '').trim()));
        for (const h of contract.optional) {
            check(
                doc.includes('`## ' + h + '`') || referenceHeadings.includes(h),
                `${file}: optional heading '## ${h}' appears neither in docs/fleet-sprint-getting-started.md nor in the reference target`
            );
        }
    }
});

test('ALLOWED_EXCEPTIONS: every entry is anchored in its file and covers at least one finding (two-place mechanism)', () => {
    check(ALLOWED_EXCEPTIONS.length >= 1, 'expected at least the contracts.mjs developer-facing Error exception');
    for (const ex of ALLOWED_EXCEPTIONS) {
        check(Array.isArray(ex.ids) && ex.ids.length > 0, `exception "${ex.name}" must limit the pattern ids it absorbs`);
        check(ex.anchorRe instanceof RegExp && typeof ex.reason === 'string', `exception "${ex.name}" needs anchorRe + reason`);
    }
    // A missing anchor is a hard error, not a silent pass.
    const contentsWithoutAnchor = { 'fleet-sprint/contracts.mjs': 'export const x = 1;\n' };
    assert.throws(
        () => applyExceptions([], contentsWithoutAnchor, ALLOWED_EXCEPTIONS.filter((e) => e.file === 'fleet-sprint/contracts.mjs')),
        /no GENERIC-BOUNDARY-EXCEPTION anchor/
    );
    // An entry that covers nothing is reported as stale.
    const contentsWithAnchor = {
        'fleet-sprint/contracts.mjs': '// GENERIC-BOUNDARY-EXCEPTION: developer-facing Error about this product\'s own vendored schema\n',
    };
    const { stale } = applyExceptions([], contentsWithAnchor, ALLOWED_EXCEPTIONS.filter((e) => e.file === 'fleet-sprint/contracts.mjs'));
    check(stale.length === 1, `expected the unused exception to be reported stale, got: ${JSON.stringify(stale)}`);
    // An exception only absorbs its declared ids and only within its window.
    const ex = ALLOWED_EXCEPTIONS.find((e) => e.file === 'fleet-sprint/contracts.mjs');
    const near = { file: ex.file, line: 1, id: ex.ids[0], match: 'x' };
    const wrongId = { file: ex.file, line: 1, id: 'bead-id-in-llm-text', match: 'apra-fleet-1' };
    const far = { file: ex.file, line: 1 + ex.window + 1, id: ex.ids[0], match: 'x' };
    const res = applyExceptions([near, wrongId, far], contentsWithAnchor, [ex]);
    assert.deepStrictEqual(res.violations, [wrongId, far]);
});

test('tokenizer: walks runner.js end to end, strips comments, and does not open a phantom template literal on a regex containing backticks', () => {
    const runner = read(path.join(PACKAGE_ROOT, 'fleet-sprint/runner.js'));
    const segments = extractStringLiterals(runner);
    check(segments.length > 100, `expected many string literals in runner.js, got ${segments.length}`);

    const snippet = [
        "const re = /^-\\s*`([^`]+)`/gm; // a `backtick` in a comment",
        "const a = 'one'; /* 'not a literal' */ const b = \"two\";",
        'const t = `tpl ${a + `inner`} done`;',
        "const d = x / y / 2; const s = 'three';",
    ].join('\n');
    const texts = extractStringLiterals(snippet).map((s) => s.text);
    check(texts.includes('one') && texts.includes('two') && texts.includes('three'), `expected one/two/three, got ${JSON.stringify(texts)}`);
    check(texts.includes('inner'), `expected the nested template literal to be collected, got ${JSON.stringify(texts)}`);
    check(!texts.some((t) => t.includes('not a literal')), 'block-comment text must never be emitted');
    check(!texts.some((t) => t.includes('backtick')), 'a regex literal with backticks must not open a template literal');
});

test('tokenizer: own-line // and /* */ comments inside a template literal are stripped, but a URL mid-sentence survives', () => {
    const snippet = [
        'const js = `',
        '    // apra-fleet-eft.37.3: client-side comment mentioning dist/index.js',
        '    /* block comment: APRA_FLEET_PORT */',
        '    function f() { return 1; }',
        '    See http://localhost:3001/health for the smoke test.',
        '`;',
    ].join('\n');
    const [seg] = extractStringLiterals(snippet);
    check(!seg.text.includes('apra-fleet-eft.37.3') && !seg.text.includes('dist/index.js'), `own-line // comment must be stripped: ${seg.text}`);
    check(!seg.text.includes('APRA_FLEET_PORT'), `block comment must be stripped: ${seg.text}`);
    check(seg.text.includes('http://localhost:3001/health'), `a mid-sentence URL must survive: ${seg.text}`);
    check(seg.text.includes('function f()'), `non-comment template text must survive: ${seg.text}`);
    const findings = scanSource('fleet-sprint/x.mjs', snippet, 'js');
    check(findings.length === 0, `comment text inside a template literal must not produce findings, got: ${JSON.stringify(findings, null, 2)}`);
});
