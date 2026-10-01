import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKbWorkClient } from '../fleet-sprint/runner.js';

// The KB read tools default to CONFIRMED undisputed entries only. Every caller
// that needs non-CONFIRMED entries must therefore pass an explicit confidence
// list. The three prompt files are read verbatim (they ARE the caller: an LLM
// follows them), and the engine's promotion listing is exercised through an
// injected fake callTool that captures the kb_list args.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const EXPLICIT_ALL = 'confidence: ["CONFIRMED", "INFERRED", "UNVERIFIED"]';

describe('callers needing non-CONFIRMED KB entries pass an explicit confidence list', () => {
    test('agents/kb-reconciler.md passes an explicit tier list on kb_query/kb_list lookups', () => {
        const md = read('apra-pm/agents/kb-reconciler.md');
        assert.ok(md.includes(EXPLICIT_ALL), 'kb-reconciler.md must show an explicit confidence list');
        assert.match(md, /kb_list\(\{ confidence: \[/);
        assert.match(md, /flagged_only` is exempt/);
    });

    test('skills/pm/kb-review.md passes an explicit tier list for non-flagged lookups', () => {
        const md = read('apra-pm/skills/pm/kb-review.md');
        assert.ok(md.includes(EXPLICIT_ALL), 'kb-review.md must show an explicit confidence list');
        assert.match(md, /flagged_only` is exempt/);
    });

    test('skills/pm/kb-reconcile.md passes an explicit tier list on pair lookups', () => {
        const md = read('apra-pm/skills/pm/kb-reconcile.md');
        assert.ok(md.includes(EXPLICIT_ALL), 'kb-reconcile.md must show an explicit confidence list');
        assert.match(md, /flagged_only: true \}\)` is exempt/);
    });

    test('kb.mjs promotion listing passes confidence as an array including INFERRED', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            return { content: [{ type: 'text', text: JSON.stringify({ results: [], total: 0 }) }] };
        };
        const client = createKbWorkClient({ callTool, log: () => {} });
        await client.promotionCandidates('/srv/repo');

        const listCall = calls.find((c) => c.name === 'kb_list');
        assert.ok(listCall, 'kb_list was never called');
        assert.ok(Array.isArray(listCall.args.confidence), 'confidence must be an explicit array');
        assert.ok(listCall.args.confidence.includes('INFERRED'), 'must include the tier it promotes');
        assert.ok(!listCall.args.confidence.includes('CONFIRMED') || listCall.args.confidence.length > 1);
    });
});
