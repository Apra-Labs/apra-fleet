import { describe, it, expect } from 'vitest';
import { mapKey, selectScopedMemories } from '../scripts/lib/beads-memory-keys.mjs';
import { mapKey as rekeyMapKey } from '../scripts/rekey-beads-memories.mjs';

describe('mapKey (old -> role-delimited beads memory keys)', () => {
    it.each([
        ['role:all:multi-llm-providers', '+all+:multi-llm-providers'],
        ['doer:secret-syntax', '+doer+:secret-syntax'],
        ['doer:reviewer:secret-syntax', '+doer+reviewer+:secret-syntax'],
        ['doer:doer:dup-role', '+doer+:dup-role'],
        ['backlog-groomer:dedup-rule', '+groomer+:dedup-rule'],
        ['groomer-heuristic-stale-p0', '+groomer+:stale-p0'],
        ['plan-reviewer:dag-size', '+plan-reviewer+:dag-size'],
    ])('maps %s -> %s', (from, to) => {
        expect(mapKey(from)).toEqual({ kind: 'map', to });
    });

    it.each(['+all+:x', '+doer+reviewer+:x', '+orchestrator+:sprint-launch'])('leaves already-new key %s alone', (key) => {
        expect(mapKey(key)).toEqual({ kind: 'new' });
    });

    it.each(['ci:flake', 'random-key', 'doer:', 'all:doer:mixed', 'unknown-role:slug'])('reports %s as unparsed', (key) => {
        expect(mapKey(key)).toEqual({ kind: 'unparsed' });
    });

    it('can map two different old keys onto one target (the script refuses that as a duplicate)', () => {
        expect(mapKey('role:all:x')).toEqual({ kind: 'map', to: '+all+:x' });
        expect(mapKey('all:x')).toEqual({ kind: 'map', to: '+all+:x' });
        expect(mapKey('backlog-groomer:y')).toEqual(mapKey('groomer:y'));
    });

    it('is re-exported unchanged by the rekey script', () => {
        expect(rekeyMapKey).toBe(mapKey);
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
        expect(selectScopedMemories(memories, ['+all+', '+orchestrator+'])).toEqual([
            ['+all+:a', 'universal'],
            ['+doer+orchestrator+:c', 'shared'],
            ['+orchestrator+:b', 'orch'],
        ]);
    });

    it('delimits role tokens: +reviewer+ does not match +plan-reviewer+', () => {
        expect(selectScopedMemories(memories, ['+reviewer+']).map(([k]) => k)).toEqual(['+reviewer+:e']);
    });

    it('is case-insensitive and returns nothing for an unknown scope', () => {
        expect(selectScopedMemories({ '+All+:x': 'v' }, ['+all+'])).toEqual([['+All+:x', 'v']]);
        expect(selectScopedMemories(memories, ['+nobody+'])).toEqual([]);
    });
});
