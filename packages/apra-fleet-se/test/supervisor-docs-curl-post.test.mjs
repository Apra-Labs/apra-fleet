import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static docs check: every documented `curl ... -X POST` to a supervisor
// /api/ route must carry a JSON Content-Type header AND a body (-d / --data),
// because the supervisor's request guard refuses a mutating request without a
// JSON content type.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

function docFiles() {
    const files = [
        'packages/apra-fleet-se/fleet-sprint/skills/fleet-supervisor/SKILL.md',
        'deploy.md',
        'regression-test-playbook.md',
        'integ-test-playbook.md',
    ];
    const docsDir = path.join(root, 'docs');
    for (const f of fs.readdirSync(docsDir)) if (f.endsWith('.md')) files.push(`docs/${f}`);
    return files.filter((f) => fs.existsSync(path.join(root, f)));
}

/** Join backslash-continued lines, returning {line, text} per curl command. */
export function extractCurlPosts(src) {
    const lines = src.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!/\bcurl(\.exe)?\b/.test(lines[i])) continue;
        let text = lines[i];
        let j = i;
        while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) {
            j += 1;
            text = text.replace(/\\\s*$/, ' ') + lines[j];
        }
        if (/-X\s+POST\b/.test(text) && /\/api\//.test(text)) out.push({ line: i + 1, text });
    }
    return out;
}

export function violations(text) {
    const v = [];
    if (!/-H\s+["']Content-Type:\s*application\/json["']/i.test(text)) v.push('missing JSON Content-Type header');
    if (!/\s(-d|--data(-raw|-binary)?)\s/.test(text)) v.push('missing -d body');
    return v;
}

test('documented curl POSTs to supervisor /api/ routes send a JSON content type and a body', () => {
    const bad = [];
    let seen = 0;
    for (const f of docFiles()) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        for (const { line, text } of extractCurlPosts(src)) {
            seen += 1;
            const v = violations(text);
            if (v.length) bad.push(`${f}:${line}: ${v.join(', ')}: ${text.trim()}`);
        }
    }
    assert.ok(seen > 0, 'expected to find documented curl POST commands');
    assert.deepStrictEqual(bad, []);
});

test('the checker flags a bare shutdown line', () => {
    assert.ok(violations('curl -s -X POST http://localhost:8787/api/shutdown').length === 2);
    assert.ok(violations(`curl -s -X POST http://localhost:8787/api/shutdown -H "Content-Type: application/json"`).length === 1);
    assert.deepStrictEqual(violations(`curl -s -X POST http://x/api/shutdown -H "Content-Type: application/json" -d '{}'`), []);
});
