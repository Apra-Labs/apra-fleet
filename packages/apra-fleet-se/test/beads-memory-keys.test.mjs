import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapKey, selectScopedMemories } from '../scripts/lib/beads-memory-keys.mjs';
import { mapKey as rekeyMapKey } from '../scripts/rekey-beads-memories.mjs';

describe('mapKey (old -> role-delimited beads memory keys)', () => {
    for (const [from, to] of [
        ['role:all:multi-llm-providers', '+all+:multi-llm-providers'],
        ['doer:secret-syntax', '+doer+:secret-syntax'],
        ['doer:reviewer:secret-syntax', '+doer+reviewer+:secret-syntax'],
        ['doer:doer:dup-role', '+doer+:dup-role'],
        ['backlog-groomer:dedup-rule', '+groomer+:dedup-rule'],
        ['groomer-heuristic-stale-p0', '+groomer+:stale-p0'],
        ['plan-reviewer:dag-size', '+plan-reviewer+:dag-size'],
    ]) {
        it(`maps ${from} -> ${to}`, () => {
            assert.deepEqual(mapKey(from), { kind: 'map', to });
        });
    }

    for (const key of ['+all+:x', '+doer+reviewer+:x', '+orchestrator+:sprint-launch']) {
        it(`leaves already-new key ${key} alone`, () => {
            assert.deepEqual(mapKey(key), { kind: 'new' });
        });
    }

    for (const key of ['ci:flake', 'random-key', 'doer:', 'all:doer:mixed', 'unknown-role:slug']) {
        it(`reports ${key} as unparsed`, () => {
            assert.deepEqual(mapKey(key), { kind: 'unparsed' });
        });
    }

    it('can map two different old keys onto one target (the script refuses that as a duplicate)', () => {
        assert.deepEqual(mapKey('role:all:x'), { kind: 'map', to: '+all+:x' });
        assert.deepEqual(mapKey('all:x'), { kind: 'map', to: '+all+:x' });
        assert.deepEqual(mapKey('backlog-groomer:y'), mapKey('groomer:y'));
    });

    it('is re-exported unchanged by the rekey script', () => {
        assert.equal(rekeyMapKey, mapKey);
    });
});

describe('selectScopedMemories (session hook reader)', () => {
    const memories = {
        '+all+:a': 'universal',
        '+orchestrator+:b': 'orch',
        '+doer+orchestrator+:c': 'shared',
        '+plan-reviewer+:d': 'pr',
        '+reviewer+:e': 'mentions +orchestrator+ in its value',
        'legacy-unscoped': 'old',
        schema_version: 2,
    };

    it('selects by key scope only, in token order, each key once', () => {
        assert.deepEqual(selectScopedMemories(memories, ['+all+', '+orchestrator+']), [
            ['+all+:a', 'universal'],
            ['+doer+orchestrator+:c', 'shared'],
            ['+orchestrator+:b', 'orch'],
        ]);
    });

    it('delimits role tokens: +reviewer+ does not match +plan-reviewer+', () => {
        assert.deepEqual(selectScopedMemories(memories, ['+reviewer+']).map(([k]) => k), ['+reviewer+:e']);
    });

    it('is case-insensitive and returns nothing for an unknown scope', () => {
        assert.deepEqual(selectScopedMemories({ '+All+:x': 'v' }, ['+all+']), [['+All+:x', 'v']]);
        assert.deepEqual(selectScopedMemories(memories, ['+nobody+']), []);
    });
});
