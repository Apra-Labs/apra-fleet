// Role prompt Step 0 contract (KB redesign).
//
// Every TOP-LEVEL role prompt in apra-pm/agents (non-recursive: _shared/ and
// schemas/ are not role prompts) except kb-reconciler.md -- which fleet-sprint
// never dispatches and whose whole job is KB curation -- must tell the role:
//   - use the kb_* and code_* tools directly when they are present (no
//     tool-discovery probe, no repository-path/scope argument);
//   - otherwise read the injected KNOWLEDGE BANK block;
//   - if a tool call fails, use the block if the prompt has one, otherwise
//     continue without KB -- never report the dispatch blocked over it.
// and must never instruct kb_feedback, a direct kb_capture call, repo_path on a
// kb_* call, or a tool name outside the shared member allowlist.
//
// The allowlist is imported from the built root module (no hardcoded copy):
// dist/services/member-tool-allowlist.js, produced by the root `npm run build`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { kbKnowledgeBlock } from '../fleet-sprint/kb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, '..', 'apra-pm', 'agents');
const SCHEMAS_DIR = path.join(AGENTS_DIR, 'schemas');
const PRE_REWRITE_FIXTURE = path.join(__dirname, 'fixtures', 'role-prompt-step0', 'doer.pre-rewrite.md');
const EXCLUDED = new Set(['kb-reconciler.md']);
const MIN_ROLE_FILES = 10;

const { MEMBER_ALLOWED_TOOLS } = await import('../../../dist/services/member-tool-allowlist.js');

/** Non-recursive: regular *.md files directly in dir, minus the excluded ones. Throws if dir is missing. */
function coveredRoleFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.md') && !EXCLUDED.has(d.name))
        .map((d) => d.name)
        .sort();
}

/** The enumeration guard: a moved directory throws, an empty one (or too few roles) fails. */
function assertRoleSet(dir) {
    const files = coveredRoleFiles(dir);
    assert.ok(
        files.length >= MIN_ROLE_FILES,
        `expected at least ${MIN_ROLE_FILES} covered role prompts in ${dir}, found ${files.length}: ${JSON.stringify(files)}`
    );
    return files;
}

/** The heading the engine-injected block opens with, read from kb.mjs (not hardcoded). */
function injectedBlockHeading() {
    const [block] = kbKnowledgeBlock([{ confidence: 'CONFIRMED', title: 't', summary: 's' }]);
    const m = /^(KNOWLEDGE BANK -- [^.]+)\./.exec(block);
    assert.ok(m, `kbKnowledgeBlock no longer opens with a "KNOWLEDGE BANK -- ..." heading: ${JSON.stringify(block.slice(0, 80))}`);
    return m[1];
}

/** Structured-output field names that start with kb_ (kb_captures, ...), read from the schemas. */
function kbOutputFieldNames() {
    const names = new Set();
    for (const f of fs.readdirSync(SCHEMAS_DIR)) {
        if (!f.endsWith('.json')) continue;
        for (const m of fs.readFileSync(path.join(SCHEMAS_DIR, f), 'utf8').matchAll(/"((?:kb|code)_[a-z_]+)"\s*:/g)) names.add(m[1]);
    }
    return names;
}

function stripFrontmatter(content) {
    return content.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/**
 * Prose units: paragraphs, split again at each list item, whitespace-collapsed,
 * then split into sentences. Prompt markdown hard-wraps sentences, so a
 * physical line is not a unit of meaning.
 */
function sentences(content) {
    const out = [];
    for (const para of stripFrontmatter(content).split(/\n\s*\n/)) {
        for (const item of para.split(/\n(?=\s*(?:\d+\.|[-*])\s)/)) {
            const collapsed = item.replace(/\s+/g, ' ').trim();
            if (collapsed) out.push(...collapsed.split(/(?<=[.!?])\s+(?=[A-Z*`"(])/));
        }
    }
    return out;
}

const collapse = (s) => s.replace(/\s+/g, ' ');

// Required instructions (whitespace-collapsed match).
const TOOLS_WHEN_PRESENT_RE = /If the `kb_\*` and `code_\*` tools are present in your session, use them directly/;
const NO_DISCOVERY_NO_SCOPE_RE = /no tool-discovery step is needed, and they always act on your own work folder, so never pass a repository path or other scope argument to them/;
const blockOtherwiseRe = (heading) => new RegExp(`Otherwise, read the injected "${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" block`);
const FALLBACK_RE = /If a KB or code tool call fails, use that block if your prompt has one; otherwise continue without KB\./;
const NEVER_BLOCKED_RE = /never report this dispatch as blocked because of it/;

// Forbidden instructions.
// Token starts use a lookbehind, not \b: in mcp__server__kb_feedback the "_"
// before "kb" is a word character, so \bkb_ would miss a prefixed name.
const KB_FEEDBACK_RE = /(?<![A-Za-z0-9])kb_feedback\b/;
const KB_CAPTURE_TOOL_RE = /(?<![A-Za-z0-9])kb_capture\b/; // the tool, not the kb_captures output field
const NEGATED_KB_CAPTURE_RE = /\b(?:never|do not|don't)\b[^.]{0,80}(?<![A-Za-z0-9])kb_capture\b/i;
const KB_TOOL_TOKEN_RE = /(?<![A-Za-z0-9])kb_[a-z][a-z_]*/;
const BLOCK_VERB_RE = /\b(?:blocked|stop|halt|abort|cannot proceed)\b/i;
const KB_SUBJECT_RE = /\b(?:KB|kb_[a-z_]+|code_[a-z_]+|knowledge bank|code tools?|MCP server)\b/i;
const FAILURE_RE = /\b(?:fail\w*|unavailable|not available|not running|missing|errors?|absent|no KB tools)\b/i;
const NEGATED_BLOCK_RE = /\bnever\b[^.]{0,30}\b(?:report|stop|block)|\b(?:do not|don't)\s+(?:report|stop|block)|\bnot\s+a\s+reason\s+to\s+stop/i;
const TOOL_NAME_RE = /(?<![A-Za-z0-9])((?:kb|code)_[a-z][a-z_]*)\b/g;

/**
 * Every Step 0 contract violation in one role prompt's content.
 * @returns {string[]} human-readable violations (empty = conforming)
 */
function step0Violations(content, { heading, allowed, outputFields }) {
    const v = [];
    const flat = collapse(content);
    if (!TOOLS_WHEN_PRESENT_RE.test(flat)) v.push('missing tools-when-present instruction');
    if (!NO_DISCOVERY_NO_SCOPE_RE.test(flat)) v.push('missing no-discovery / no-scope-argument instruction');
    if (!blockOtherwiseRe(heading).test(flat)) v.push(`missing block-otherwise instruction naming "${heading}"`);
    if (!FALLBACK_RE.test(flat)) v.push('missing conditional fallback (use the block if present, otherwise continue without KB)');
    if (!NEVER_BLOCKED_RE.test(flat)) v.push('missing never-report-blocked instruction');
    if (/\bToolSearch\b/.test(stripFrontmatter(content))) v.push('instructs a ToolSearch tool-discovery probe');

    for (const s of sentences(content)) {
        if (KB_FEEDBACK_RE.test(s)) v.push(`instructs kb_feedback: ${JSON.stringify(s)}`);
        if (KB_CAPTURE_TOOL_RE.test(s) && !NEGATED_KB_CAPTURE_RE.test(s)) v.push(`instructs a direct kb_capture call: ${JSON.stringify(s)}`);
        if (/\brepo_path\b/.test(s) && KB_TOOL_TOKEN_RE.test(s)) v.push(`passes repo_path on a kb_* call: ${JSON.stringify(s)}`);
        if (BLOCK_VERB_RE.test(s) && KB_SUBJECT_RE.test(s) && FAILURE_RE.test(s) && !NEGATED_BLOCK_RE.test(s)) {
            v.push(`reports blocked on a KB/code tool failure: ${JSON.stringify(s)}`);
        }
    }
    for (const m of stripFrontmatter(content).matchAll(TOOL_NAME_RE)) {
        const name = m[1];
        if (outputFields.has(name)) continue;
        if (!allowed.includes(name)) v.push(`names a tool outside the member allowlist: ${name}`);
    }
    return [...new Set(v)];
}

function contractContext() {
    return { heading: injectedBlockHeading(), allowed: MEMBER_ALLOWED_TOOLS, outputFields: kbOutputFieldNames() };
}

test('enumeration: non-recursive, at least 10 role prompts, kb-reconciler excluded, subfolders excluded', () => {
    const files = assertRoleSet(AGENTS_DIR);
    assert.ok(!files.includes('kb-reconciler.md'), 'kb-reconciler.md must be excluded');
    assert.ok(fs.existsSync(path.join(AGENTS_DIR, 'kb-reconciler.md')), 'premise: kb-reconciler.md exists, so the exclusion is real');
    assert.ok(fs.statSync(path.join(AGENTS_DIR, '_shared')).isDirectory(), 'premise: _shared/ exists and holds .md files');
    for (const f of files) assert.ok(!f.includes('/') && !f.includes(path.sep), `${f} is not top-level`);
    const sharedMd = fs.readdirSync(path.join(AGENTS_DIR, '_shared')).filter((f) => f.endsWith('.md'));
    assert.ok(sharedMd.length > 0, 'premise: _shared/ has .md files');
    for (const f of sharedMd) assert.ok(!files.includes(f) || fs.existsSync(path.join(AGENTS_DIR, f)), `${f} came from _shared/`);
});

test('enumeration: a moved (missing) directory fails', () => {
    assert.throws(() => assertRoleSet(path.join(AGENTS_DIR, '..', 'agents-moved-away')), /ENOENT/);
});

test('enumeration: an empty directory fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-step0-empty-'));
    try {
        assert.throws(() => assertRoleSet(dir), /at least 10 covered role prompts/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the shared member allowlist is imported, not copied, and is non-empty', () => {
    assert.ok(Array.isArray(MEMBER_ALLOWED_TOOLS) && MEMBER_ALLOWED_TOOLS.includes('kb_session_prime'));
    assert.ok(!MEMBER_ALLOWED_TOOLS.includes('execute_prompt'));
});

for (const file of coveredRoleFiles(AGENTS_DIR)) {
    test(`${file}: conforms to the Step 0 contract`, () => {
        const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
        const violations = step0Violations(content, contractContext());
        assert.deepEqual(violations, [], `${file} violates the Step 0 contract:\n- ${violations.join('\n- ')}`);
    });
}

// ---------------------------------------------------------------------------
// Non-vacuity: the checker must reject what it exists to reject.
// ---------------------------------------------------------------------------

test('a pre-rewrite role prompt (fixture copy) fails the contract on every forbidden/missing point', () => {
    const content = fs.readFileSync(PRE_REWRITE_FIXTURE, 'utf8');
    const violations = step0Violations(content, contractContext());
    const has = (re) => violations.some((x) => re.test(x));
    assert.ok(has(/missing tools-when-present/), `expected missing tools-when-present, got ${JSON.stringify(violations)}`);
    assert.ok(has(/missing block-otherwise/), 'expected missing block-otherwise');
    assert.ok(has(/missing conditional fallback/), 'expected missing conditional fallback');
    assert.ok(has(/instructs kb_feedback/), 'expected kb_feedback');
    assert.ok(has(/direct kb_capture/), 'expected direct kb_capture');
    assert.ok(has(/repo_path on a kb_\* call/), 'expected repo_path');
    assert.ok(has(/ToolSearch/), 'expected ToolSearch probe');
});

const CTX_FIXTURE = () => contractContext();

test('report-blocked pattern: a stop-on-KB-tool-failure instruction is caught; the never-blocked wording is not', () => {
    const bad = [
        '## Step 0 -- Knowledge Bank',
        '',
        '1. If the KB tools are not available (MCP server not running), stop and report that',
        '   the work cannot proceed.',
    ].join('\n');
    assert.ok(step0Violations(bad, CTX_FIXTURE()).some((x) => /reports blocked/.test(x)));
    const bad2 = 'If a code tool call fails, return status BLOCKED.';
    assert.ok(step0Violations(bad2, CTX_FIXTURE()).some((x) => /reports blocked/.test(x)));
    const good = 'A missing or failing KB or code tool is never a reason to stop: never report this dispatch as blocked because of it.';
    assert.ok(!step0Violations(good, CTX_FIXTURE()).some((x) => /reports blocked/.test(x)));
});

test('direct kb_capture: an instruction is caught, a prohibition and the kb_captures field are not', () => {
    assert.ok(step0Violations('When you find a gotcha, call `kb_capture` with type "learning".', CTX_FIXTURE()).some((x) => /direct kb_capture/.test(x)));
    assert.ok(!step0Violations('Do not call `kb_capture` yourself.', CTX_FIXTURE()).some((x) => /direct kb_capture/.test(x)));
    assert.ok(!step0Violations('Add it to the `kb_captures` array.', CTX_FIXTURE()).some((x) => /direct kb_capture/.test(x)));
});

test('allowlist: a kb_/code_ tool name the member allowlist lacks is caught; output fields are not', () => {
    assert.ok(!MEMBER_ALLOWED_TOOLS.includes('code_reindex'), 'premise: code_reindex is not registered');
    const v = step0Violations('When present, call `code_reindex` first, then `kb_query`.', CTX_FIXTURE());
    assert.ok(v.includes('names a tool outside the member allowlist: code_reindex'), JSON.stringify(v));
    assert.ok(!v.some((x) => /kb_query/.test(x)));
    const fields = step0Violations('Return `kb_captures` and `kb_promotions`.', CTX_FIXTURE());
    assert.ok(!fields.some((x) => /allowlist/.test(x)), JSON.stringify(fields));
});
