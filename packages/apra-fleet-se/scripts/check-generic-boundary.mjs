#!/usr/bin/env node
/**
 * check-generic-boundary.mjs -- the "dogfood safety net".
 *
 * fleet-sprint is a GENERIC product: the engine in fleet-sprint/ and the role
 * prompts in apra-pm/agents/ drive a sprint against ANY target repo. apra-fleet
 * also uses fleet-sprint to build ITSELF, and that dogfooding creates constant
 * pressure to hardcode apra-fleet's own build/deploy/runtime details into the
 * engine ("make the thing building apra-fleet work" is concrete; "stay generic
 * for another target" is abstract). This scanner mechanically catches the
 * detectable slice of that leak class. See docs/generic-engine-boundary.md for
 * the rule, the rationale, and the deliberate-exception mechanism.
 *
 * What it scans: LLM-FACING TEXT ONLY --
 *   - JS/MJS in the engine file set: string literals with comments stripped
 *     (an identifier like `process.env.APRA_FLEET_DATA_DIR` in engine code is
 *     the product configuring ITSELF and is fine; a prompt string telling a
 *     deployer to set APRA_FLEET_DATA_DIR assumes the TARGET is apra-fleet).
 *   - Role-prompt markdown (apra-pm/agents/**): the whole file minus HTML
 *     comments.
 * This mirrors the repo's existing bead-id rule ("never cite a bead id in any
 * LLM-facing text; comments and docs are fine") and keeps the baseline noise
 * at zero -- a raw grep of the engine finds ~1000 legitimate "apra-fleet"
 * mentions in comments, imports and design docs.
 *
 * Exports are consumed by test/generic-boundary-guard.test.mjs. Run directly
 * to scan arbitrary files (used to prove the guard catches a known incident):
 *   node scripts/check-generic-boundary.mjs                  # engine file set
 *   node scripts/check-generic-boundary.mjs path/to/file.js  # explicit files
 * Exit code 1 on any undeclared finding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
export const DESIGN_DOC = 'docs/generic-engine-boundary.md';

/**
 * The generic engine file set, relative to packages/apra-fleet-se. Everything
 * here ships to EVERY fleet-sprint target, so nothing in its LLM-facing text
 * may assume the target is apra-fleet.
 */
export const ENGINE_FILE_SET = [
    { dir: 'fleet-sprint', match: /\.(?:js|mjs|cjs)$/, kind: 'js' },
    { dir: 'apra-pm/agents', match: /\.md$/, kind: 'md' },
];

/**
 * Target-owned files: the engine may name them (their existence is the
 * documented contract) but must treat their CONTENT as opaque, conditionally
 * present, target-authored text beyond the sections listed here.
 *
 * `required` sections are guaranteed by every conforming target and are
 * checked against the vendored reference target (fleet-e2e-toy) fixture;
 * `optional` sections may be named only in conditional phrasing. Both lists
 * must match docs/fleet-sprint-getting-started.md (the test enforces that).
 */
export const TARGET_FILE_CONTRACT = {
    'deploy.md': { required: ['Deploy', 'Smoke test'], optional: ['Permissions'] },
    'integ-test-playbook.md': { required: [], optional: ['Permissions', 'Setup', 'Reset', 'Teardown'] },
    'regression-test-playbook.md': { required: [], optional: ['Permissions', 'Setup', 'Teardown'] },
};

const TARGET_FILE_NAMES = Object.keys(TARGET_FILE_CONTRACT);
const CONTRACT_HEADINGS = new Set(
    Object.values(TARGET_FILE_CONTRACT).flatMap((c) => [...c.required, ...c.optional]).map((h) => h.toLowerCase())
);

/**
 * Signal patterns: each is a thing ONLY apra-fleet-the-target has, so its
 * presence in LLM-facing engine text means the engine is assuming its target
 * is apra-fleet. `belongs` is the educational half of the failure message:
 * where that content should live instead.
 */
export const SIGNAL_PATTERNS = [
    {
        id: 'apra-fleet-build-artifact',
        re: /dist\/index\.js|npm run build:binary|\bbuild:binary\b|install --force|\bapra-fleet install\b|~\/bin\/apra-fleet/g,
        why: "names apra-fleet's own build output / installer -- another target has no dist/index.js or `install --force`",
        belongs: "the target repo's deploy.md (its ## Deploy section is the ONLY place build/launch commands live); the engine just tells the deployer to follow deploy.md",
    },
    {
        id: 'apra-fleet-env-var',
        re: /\b(?:APRA_FLEET|FLEET_SE)_[A-Z0-9_]+\b/g,
        why: 'names an environment variable only the apra-fleet server/supervisor reads -- another target has no such variable',
        belongs: "the target repo's deploy.md (runtime configuration is deploy-runbook content); engine code may still READ its own env vars as identifiers (process.env.X), just never tell an agent about them",
    },
    {
        id: 'apra-fleet-service-endpoint',
        re: /\blocalhost:8787\b|127\.0\.0\.1:8787|\bport 8787\b/g,
        why: "names apra-fleet's supervisor endpoint -- another target's app listens somewhere else (or nowhere)",
        belongs: "the target repo's deploy.md / integ-test-playbook.md ('how to reach the deployed app' is playbook content)",
    },
    {
        id: 'apra-fleet-repo-internals',
        re: /packages\/apra-fleet-se\b|packages\/apra-fleet-client\b|\bapra-pm\/(?:agents|skills)\b|\bsrc\/tools\/|\bfeat\/pm-reorg\b/g,
        why: "names apra-fleet's own source layout -- an agent developing another repo would be lectured about apra-fleet internals",
        belongs: "the target repo's CLAUDE.md / AGENTS.md (repo-layout guidance is target-authored context the agent already reads)",
    },
    {
        id: 'bead-id-in-llm-text',
        // apra-fleet-417.2.1, apra-fleet-eft.37.5, apra-fleet-5co8 -- an
        // issue id from THIS repo's tracker. The standing CLAUDE.md rule:
        // bead ids are fine in code comments and docs/, never in prompts,
        // playbooks, schema descriptions, or runtime strings.
        // Shape of a real `bd` id: a hash-like token (has a digit, or is a
        // 3-4 letter stem) optionally followed by .N child suffixes. Product
        // package names (apra-fleet-se, apra-fleet-client, apra-fleet-workflow)
        // are the product's own identity and do NOT match this shape.
        re: /\bapra-fleet-(?:[a-z0-9]*[0-9][a-z0-9]*|[a-z]{3,4})(?:\.[0-9]+)*\b(?!-)/g,
        why: "cites an apra-fleet tracker id -- meaningless (and confusing) to an agent working on another target, and forbidden in LLM-facing text by this repo's CLAUDE.md",
        belongs: 'a code comment next to the logic (provenance) or docs/; never the string itself',
    },
];

/** Inline heading mention: `## Foo` (or ###) that is NOT the whole literal / not at line start. */
const HEADING_MENTION_RE = /#{2,3}\s+([^\n'"`)]+?)(?=\s*(?:\(|'|"|`|section|$))/g;
const HEADING_PROXIMITY_LINES = 8;

// ---------------------------------------------------------------------------
// JS tokenizer: extract string-literal segments with comments stripped.
// ---------------------------------------------------------------------------

/**
 * Walks JS source and returns the text of every string literal (single,
 * double, and the raw text of template literals -- `${...}` interpolations
 * are skipped, and nested literals inside them are collected recursively),
 * each tagged with its 1-based start line and whether the literal was the
 * whole content (used by the heading rule). Comments are never emitted.
 * Regex literals are recognised heuristically (a `/` in operand position)
 * so a pattern like /^-\s*`([^`]+)`/ cannot open a phantom template literal.
 */
export function extractStringLiterals(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    let line = 1;
    // Stack frames: {mode:'code', braceDepth} | {mode:'squote'|'dquote'|'template', start, startLine, buf}
    const stack = [{ mode: 'code', braceDepth: null }];
    const top = () => stack[stack.length - 1];
    let lastSignificant = ''; // last non-space char in code mode, for regex detection

    const advance = (k = 1) => {
        for (let j = 0; j < k && i < n; j += 1) {
            if (src[i] === '\n') line += 1;
            i += 1;
        }
    };
    const closeLiteral = (frame) => {
        out.push({ text: frame.buf, line: frame.startLine, endLine: line });
        stack.pop();
    };

    while (i < n) {
        const frame = top();
        const c = src[i];
        const c2 = i + 1 < n ? src[i + 1] : '';

        if (frame.mode === 'squote' || frame.mode === 'dquote') {
            const quote = frame.mode === 'squote' ? '\'' : '"';
            if (c === '\\') { frame.buf += c2; advance(2); continue; }
            if (c === quote) { closeLiteral(frame); advance(); continue; }
            frame.buf += c;
            advance();
            continue;
        }

        if (frame.mode === 'template') {
            if (c === '\\') { frame.buf += c2; advance(2); continue; }
            if (c === '`') { closeLiteral(frame); advance(); continue; }
            if (c === '$' && c2 === '{') {
                frame.buf += ' ';
                stack.push({ mode: 'code', braceDepth: 1 });
                advance(2);
                lastSignificant = '{';
                continue;
            }
            // A template that embeds a served client-side script (the
            // dashboard extension's `js:` block) carries that script's OWN
            // comments as template text. An own-line `//` comment or a
            // `/* */` block there is client-JS commentary, not prompt text,
            // so it is skipped -- same treatment the workflow package's
            // boundary test gives its HTML_TEMPLATE. Only own-line `//` is
            // stripped so a URL mid-sentence in a real prompt survives.
            if (c === '/' && c2 === '/' && /(?:^|\n)[ \t]*$/.test(frame.buf)) {
                while (i < n && src[i] !== '\n') advance();
                continue;
            }
            if (c === '/' && c2 === '*') {
                advance(2);
                while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') frame.buf += '\n'; advance(); }
                advance(2);
                continue;
            }
            frame.buf += c;
            advance();
            continue;
        }

        // code mode
        if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') advance(); continue; }
        if (c === '/' && c2 === '*') {
            advance(2);
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) advance();
            advance(2);
            continue;
        }
        if (c === '/' && isRegexStart(lastSignificant, src, i)) {
            // consume regex literal
            advance();
            let inClass = false;
            while (i < n) {
                const r = src[i];
                if (r === '\\') { advance(2); continue; }
                if (r === '\n') break;
                if (inClass) { if (r === ']') inClass = false; advance(); continue; }
                if (r === '[') { inClass = true; advance(); continue; }
                if (r === '/') { advance(); break; }
                advance();
            }
            while (i < n && /[a-z]/.test(src[i])) advance(); // flags
            lastSignificant = ')'; // a regex literal is an operand
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            stack.push({ mode: c === '\'' ? 'squote' : c === '"' ? 'dquote' : 'template', startLine: line, buf: '' });
            advance();
            lastSignificant = ')'; // a literal is an operand
            continue;
        }
        if (frame.braceDepth !== null) {
            if (c === '{') frame.braceDepth += 1;
            else if (c === '}') {
                frame.braceDepth -= 1;
                if (frame.braceDepth === 0) { stack.pop(); advance(); lastSignificant = ')'; continue; }
            }
        }
        if (!/\s/.test(c)) lastSignificant = c;
        advance();
    }
    if (stack.length !== 1) {
        throw new Error(`extractStringLiterals: unbalanced literal at EOF (stack depth ${stack.length}); the tokenizer could not follow this file`);
    }
    return out;
}

const REGEX_PRECEDING_KEYWORDS = /(?:^|[^A-Za-z0-9_$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)\s*$/;
function isRegexStart(lastSignificant, src, i) {
    if (lastSignificant === '' ) return true;
    if ('(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant)) return true;
    if (/[A-Za-z0-9_$)\]]/.test(lastSignificant)) {
        // identifier/number/close-paren before `/` -> division, except after a keyword
        const before = src.slice(Math.max(0, i - 12), i);
        return REGEX_PRECEDING_KEYWORDS.test(before);
    }
    return false;
}

/** Markdown: strip HTML comments (keeping newlines), return whole text as one segment per line. */
export function extractMarkdownText(src) {
    const stripped = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    return stripped.split('\n').map((text, idx) => ({ text, line: idx + 1, endLine: idx + 1, mdLine: true }));
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * @param {string} relFile  file path for reporting
 * @param {string} src      file content
 * @param {'js'|'md'} kind
 * @returns {Array<{file,line,id,match,excerpt,why,belongs}>}
 */
export function scanSource(relFile, src, kind) {
    const segments = kind === 'js' ? extractStringLiterals(src) : extractMarkdownText(src);
    const findings = [];
    const excerptOf = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 140);

    // Lines (1-based) on which a target-owned file is named in LLM-facing text.
    const targetFileLines = [];
    for (const seg of segments) {
        if (TARGET_FILE_NAMES.some((f) => seg.text.includes(f))) targetFileLines.push(seg.line);
    }

    for (const seg of segments) {
        for (const p of SIGNAL_PATTERNS) {
            p.re.lastIndex = 0;
            let m;
            while ((m = p.re.exec(seg.text)) !== null) {
                findings.push({ file: relFile, line: seg.line, id: p.id, match: m[0], excerpt: excerptOf(seg.text), why: p.why, belongs: p.belongs });
            }
        }

        // Heading rule: the engine may only rely on the documented sections of
        // a target-owned file. A whole-literal heading (engine-authored report
        // output like '## Progress') is not a mention; a markdown line that IS
        // a heading (the role prompt's own structure) is not a mention either.
        const wholeLiteralHeading = /^\s*#{2,3}\s+[^\n]+$/.test(seg.text) && !seg.text.includes('\n');
        if (wholeLiteralHeading || (seg.mdLine && /^\s*#{1,6}\s/.test(seg.text))) continue;
        HEADING_MENTION_RE.lastIndex = 0;
        let h;
        while ((h = HEADING_MENTION_RE.exec(seg.text)) !== null) {
            const heading = h[1].trim();
            if (CONTRACT_HEADINGS.has(heading.toLowerCase())) continue;
            const nearTargetFile = seg.text.includes('.md')
                || targetFileLines.some((l) => Math.abs(l - seg.line) <= HEADING_PROXIMITY_LINES);
            if (!nearTargetFile) continue;
            findings.push({
                file: relFile,
                line: seg.line,
                id: 'undocumented-target-section',
                match: `## ${heading}`,
                excerpt: excerptOf(seg.text),
                why: `requires a target-owned file to contain a '## ${heading}' section, which the documented target contract does not guarantee (the reference target fleet-e2e-toy has no such section)`,
                belongs: "the target repo's own deploy.md / playbook: add the section THERE, and have the engine (or the role prompt) refer to it conditionally -- 'if deploy.md offers a sandbox section, use it' -- never by name as a requirement. If the section is genuinely universal, add it to TARGET_FILE_CONTRACT and docs/fleet-sprint-getting-started.md and prove the reference target satisfies it",
            });
        }
    }
    return findings;
}

/** Enumerate the engine file set. Returns [{abs, rel, kind}]. */
export function listEngineFiles(packageRoot = PACKAGE_ROOT) {
    const files = [];
    for (const entry of ENGINE_FILE_SET) {
        const base = path.join(packageRoot, entry.dir);
        if (!fs.existsSync(base)) continue;
        const walk = (dir) => {
            for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, d.name);
                if (d.isDirectory()) { if (d.name !== 'node_modules') walk(full); continue; }
                if (entry.match.test(d.name)) {
                    files.push({ abs: full, rel: path.relative(packageRoot, full).split(path.sep).join('/'), kind: entry.kind });
                }
            }
        };
        walk(base);
    }
    return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Deliberate exceptions. An exception needs BOTH an entry here (so it shows
 * up in this file's diff for review) AND a `GENERIC-BOUNDARY-EXCEPTION:`
 * anchor comment in the source within `window` lines of the finding, stating
 * the reason. A finding covered by no entry fails; an entry covering no
 * finding fails too (stale allowlist). `ids` limits which pattern ids the
 * entry may absorb, so an exception for one thing cannot silently cover
 * another.
 */
export const ALLOWED_EXCEPTIONS = [
    {
        name: 'contracts.mjs version-pin error names the vendored-schema package',
        file: 'fleet-sprint/contracts.mjs',
        ids: ['apra-fleet-repo-internals'],
        anchorRe: /developer-facing Error about this product's own vendored schema/,
        window: 8,
        reason: 'a thrown Error read by an apra-fleet DEVELOPER (never dispatched to a sprint agent) that must name the package whose vendored schema drifted; it describes the product, not a target',
    },
];

export const ANCHOR_RE = /GENERIC-BOUNDARY-EXCEPTION:/;

export function applyExceptions(findings, contentsByRel, exceptions = ALLOWED_EXCEPTIONS) {
    const resolved = exceptions.map((ex) => {
        const content = contentsByRel[ex.file];
        if (!content) throw new Error(`ALLOWED_EXCEPTIONS entry "${ex.name}" names a file not in the engine set: ${ex.file}`);
        const idx = content.split('\n').findIndex((l) => ANCHOR_RE.test(l) && ex.anchorRe.test(l));
        if (idx === -1) throw new Error(`ALLOWED_EXCEPTIONS entry "${ex.name}" has no GENERIC-BOUNDARY-EXCEPTION anchor matching ${ex.anchorRe} in ${ex.file}`);
        return { ...ex, anchorLine: idx + 1, hits: 0 };
    });
    const violations = [];
    for (const f of findings) {
        const cover = resolved.find((ex) => ex.file === f.file && ex.ids.includes(f.id) && Math.abs(ex.anchorLine - f.line) <= ex.window);
        if (cover) cover.hits += 1;
        else violations.push(f);
    }
    const stale = resolved.filter((ex) => ex.hits === 0).map((ex) => ex.name);
    return { violations, stale };
}

export function formatViolation(v) {
    return [
        `${v.file}:${v.line}  [${v.id}]  matched "${v.match}"`,
        `    text:    ${v.excerpt}`,
        `    why:     ${v.why}`,
        `    belongs: ${v.belongs}`,
    ].join('\n');
}

export function formatReport(violations, stale = []) {
    const parts = [];
    if (violations.length) {
        parts.push(
            `GENERIC ENGINE BOUNDARY: ${violations.length} apra-fleet-specific assumption(s) found in LLM-facing engine text.`,
            'fleet-sprint runs sprints for ANY target repo; apra-fleet building itself with it is the build METHOD, not the product scope.',
            "Each finding below tells you where the target-specific content belongs instead. Rule + exception mechanism: " + DESIGN_DOC,
            '',
            ...violations.map(formatViolation),
            '',
            'Deliberate exception? It takes two visible edits (never a one-line silence): a GENERIC-BOUNDARY-EXCEPTION: <reason> comment beside the text',
            'AND a matching ALLOWED_EXCEPTIONS entry in scripts/check-generic-boundary.mjs, so the exception is reviewed in the diff.',
        );
    }
    if (stale.length) {
        parts.push(`Stale ALLOWED_EXCEPTIONS (cover no finding any more -- remove them): ${stale.join(', ')}`);
    }
    return parts.join('\n');
}

export function scanFiles(files) {
    const contentsByRel = {};
    const findings = [];
    for (const f of files) {
        const src = fs.readFileSync(f.abs, 'utf8');
        contentsByRel[f.rel] = src;
        findings.push(...scanSource(f.rel, src, f.kind));
    }
    return { findings, contentsByRel };
}

export function runEngineScan(packageRoot = PACKAGE_ROOT) {
    const files = listEngineFiles(packageRoot);
    const { findings, contentsByRel } = scanFiles(files);
    const { violations, stale } = applyExceptions(findings, contentsByRel);
    return { files, findings, violations, stale };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    let result;
    if (args.length === 0) {
        result = runEngineScan();
        console.log(`Scanned ${result.files.length} engine file(s).`);
    } else {
        const files = args.map((a) => ({ abs: path.resolve(a), rel: a.split(path.sep).join('/'), kind: /\.md$/.test(a) ? 'md' : 'js' }));
        const { findings } = scanFiles(files);
        result = { violations: findings, stale: [] };
        console.log(`Scanned ${files.length} explicit file(s) (no exceptions applied).`);
    }
    if (result.violations.length || result.stale.length) {
        console.log(formatReport(result.violations, result.stale));
        process.exit(1);
    }
    console.log('OK: no apra-fleet-specific assumptions in LLM-facing engine text.');
}
