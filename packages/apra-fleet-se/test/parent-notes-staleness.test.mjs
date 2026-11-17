import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    notesLastUpdatedAtFromHistory,
    computeParentNotesStalenessNote,
    formatStalenessBlock,
    collectParentNotesStalenessNotes,
} from '../fleet-sprint/parent-notes-staleness.mjs';

// =============================================================================
// apra-fleet-fsxg -- unit coverage for the tooling-computed parent-NOTES
// staleness signal. The signal fires when a bead's NOTES were last updated
// AFTER its most recently created child (an existing decomposition that may
// predate a later NOTES correction), and must NOT fire otherwise (no children,
// notes predating children, no notes at all). These tests pin both the pure
// decision core and the impure collector's bd-command wiring against a stub.
// =============================================================================

// A `bd history <id> --json` snapshot: newest first, each carrying the whole
// issue including its notes text at that commit.
function hist(entries) {
    // entries: [{ date, notes }] in NEWEST-first order (matching real `bd history`).
    return entries.map(({ date, notes }) => ({
        CommitHash: `${date}-hash`,
        CommitDate: date,
        Issue: { id: 'x', notes },
    }));
}

describe('notesLastUpdatedAtFromHistory', () => {
    test('returns null for empty / non-array history', () => {
        assert.strictEqual(notesLastUpdatedAtFromHistory([]), null);
        assert.strictEqual(notesLastUpdatedAtFromHistory(null), null);
        assert.strictEqual(notesLastUpdatedAtFromHistory(undefined), null);
    });

    test('returns null when the bead never carried notes', () => {
        const history = hist([
            { date: '2026-09-15T12:00:00Z', notes: '' },
            { date: '2026-09-15T10:00:00Z', notes: undefined },
        ]);
        assert.strictEqual(notesLastUpdatedAtFromHistory(history), null);
    });

    test('returns the commit date at which notes last actually changed', () => {
        // Oldest -> newest: notes set at 10:00, unchanged at 11:00, appended at 13:00.
        const history = hist([
            { date: '2026-09-15T14:00:00Z', notes: 'first\nsecond' }, // carried forward, no change
            { date: '2026-09-15T13:00:00Z', notes: 'first\nsecond' }, // <-- last real change
            { date: '2026-09-15T11:00:00Z', notes: 'first' },         // carried forward
            { date: '2026-09-15T10:00:00Z', notes: 'first' },         // introduced
        ]);
        assert.strictEqual(notesLastUpdatedAtFromHistory(history), '2026-09-15T13:00:00Z');
    });

    test('ignores bead-level churn that does not touch notes text', () => {
        // Status/priority commits after the notes were set must not count.
        const history = hist([
            { date: '2026-09-15T18:00:00Z', notes: 'the note' }, // status change, notes unchanged
            { date: '2026-09-15T17:00:00Z', notes: 'the note' }, // claim, notes unchanged
            { date: '2026-09-15T09:00:00Z', notes: 'the note' }, // notes introduced
        ]);
        assert.strictEqual(notesLastUpdatedAtFromHistory(history), '2026-09-15T09:00:00Z');
    });

    test('returns null when notes were cleared back to empty in the newest commit', () => {
        const history = hist([
            { date: '2026-09-15T15:00:00Z', notes: '' },        // cleared
            { date: '2026-09-15T12:00:00Z', notes: 'had note' },
        ]);
        assert.strictEqual(notesLastUpdatedAtFromHistory(history), null);
    });
});

describe('computeParentNotesStalenessNote', () => {
    const children = [
        { id: 'c1', created_at: '2026-09-15T10:00:00Z' },
        { id: 'c2', created_at: '2026-09-15T11:00:00Z' }, // most recent child
    ];

    test('fires when notes are strictly newer than the most recent child', () => {
        const note = computeParentNotesStalenessNote({
            id: 'p1',
            notesUpdatedAt: '2026-09-15T12:00:00Z',
            children,
        });
        assert.ok(note, 'expected a staleness note');
        assert.match(note, /Bead p1/);
        assert.match(note, /2026-09-15T12:00:00Z/); // notes timestamp
        assert.match(note, /c2, created 2026-09-15T11:00:00Z/); // most recent child
        assert.match(note, /authoritative/i);
    });

    test('does NOT fire when notes predate the most recent child (common case)', () => {
        assert.strictEqual(
            computeParentNotesStalenessNote({
                id: 'p1',
                notesUpdatedAt: '2026-09-15T10:30:00Z', // before c2
                children,
            }),
            null
        );
    });

    test('does NOT fire when notes are exactly co-timed with the last child', () => {
        assert.strictEqual(
            computeParentNotesStalenessNote({
                id: 'p1',
                notesUpdatedAt: '2026-09-15T11:00:00Z',
                children,
            }),
            null
        );
    });

    test('does NOT fire with no children', () => {
        assert.strictEqual(
            computeParentNotesStalenessNote({ id: 'p1', notesUpdatedAt: '2026-09-15T12:00:00Z', children: [] }),
            null
        );
    });

    test('does NOT fire with no notes-updated timestamp', () => {
        assert.strictEqual(
            computeParentNotesStalenessNote({ id: 'p1', notesUpdatedAt: null, children }),
            null
        );
    });

    test('ignores children with missing/unparseable created_at', () => {
        const messy = [
            { id: 'c1', created_at: 'not-a-date' },
            { id: 'c2' },
            { id: 'c3', created_at: '2026-09-15T09:00:00Z' },
        ];
        const note = computeParentNotesStalenessNote({
            id: 'p1',
            notesUpdatedAt: '2026-09-15T10:00:00Z',
            children: messy,
        });
        assert.ok(note);
        assert.match(note, /c3, created 2026-09-15T09:00:00Z/);
    });
});

describe('formatStalenessBlock', () => {
    test('returns null for empty input (prompt unchanged in the common case)', () => {
        assert.strictEqual(formatStalenessBlock([]), null);
        assert.strictEqual(formatStalenessBlock(null), null);
    });

    test('renders a numbered, advisory block with a header', () => {
        const block = formatStalenessBlock(['Bead p1: ...', 'Bead p2: ...']);
        assert.match(block, /TOOLING-COMPUTED STALENESS SIGNAL/);
        assert.match(block, /ADVISORY ONLY/);
        assert.match(block, /1\. Bead p1/);
        assert.match(block, /2\. Bead p2/);
    });

    test('block text is product-generic (no bead-id/target-repo literals in source output)', () => {
        const block = formatStalenessBlock(['note']);
        // The header itself must never name a specific tracker id or target.
        assert.ok(!/apra-fleet-[a-z0-9]/i.test(block.split('note')[0]));
    });
});

describe('collectParentNotesStalenessNotes', () => {
    // Minimal stub of the injected command() + parseBdJson() seam. `command`
    // dispatches by inspecting the label; parseBdJson just returns the value
    // the stub stored for that label.
    function makeStub({ childrenById, historyById }) {
        const calls = [];
        const command = async (label, opts) => {
            calls.push({ label, opts });
            if (label.startsWith('bd list --parent ')) {
                const id = label.split(' ')[3];
                return { __kind: 'children', value: childrenById[id] || [] };
            }
            if (label.startsWith('bd history ')) {
                const id = label.split(' ')[2];
                return { __kind: 'history', value: historyById[id] || [] };
            }
            throw new Error(`unexpected label: ${label}`);
        };
        const parseBdJson = (raw) => raw.value;
        return { command, parseBdJson, calls };
    }

    test('surfaces a note only for a stale scope bead, and both bd calls name member_name', async () => {
        const { command, parseBdJson, calls } = makeStub({
            childrenById: {
                stale: [{ id: 'stale.1', created_at: '2026-09-15T10:00:00Z' }],
                fresh: [{ id: 'fresh.1', created_at: '2026-09-15T20:00:00Z' }],
                leaf: [],
            },
            historyById: {
                stale: hist([{ date: '2026-09-15T12:00:00Z', notes: 'CORRECTION: do X not Y' }]),
                fresh: hist([{ date: '2026-09-15T09:00:00Z', notes: 'early note' }]),
            },
        });

        const notes = await collectParentNotesStalenessNotes({
            command,
            member: 'orchestrator',
            rootIds: ['stale', 'fresh', 'leaf'],
            parseBdJson,
        });

        assert.strictEqual(notes.length, 1, 'only the stale bead should produce a note');
        assert.match(notes[0], /Bead stale/);

        // The leaf (no children) must be probed for children but never for history.
        assert.ok(calls.some((c) => c.label === 'bd list --parent leaf --json'));
        assert.ok(!calls.some((c) => c.label === 'bd history leaf --json'));

        // Every dispatched command names member_name explicitly.
        for (const c of calls) {
            assert.strictEqual(c.opts.member_name, 'orchestrator');
        }
    });

    test('is non-fatal on a bd failure: skips the bead, keeps going, never throws', async () => {
        const command = async (label, opts) => {
            if (label === 'bd list --parent boom --json') throw new Error('bd exploded');
            if (label.startsWith('bd list --parent ')) return { value: [{ id: 'ok.1', created_at: '2026-09-15T10:00:00Z' }] };
            if (label.startsWith('bd history ')) return { value: hist([{ date: '2026-09-15T12:00:00Z', notes: 'later' }]) };
            throw new Error('unexpected');
        };
        const parseBdJson = (raw) => raw.value;
        const logs = [];

        const notes = await collectParentNotesStalenessNotes({
            command,
            member: 'm',
            rootIds: ['boom', 'ok'],
            parseBdJson,
            log: (m) => logs.push(m),
        });

        assert.strictEqual(notes.length, 1);
        assert.match(notes[0], /Bead ok/);
        assert.ok(logs.some((m) => /boom/.test(m) && /FAILED/.test(m)));
    });

    test('empty / non-array rootIds yields no notes and no commands', async () => {
        const { command, parseBdJson, calls } = makeStub({ childrenById: {}, historyById: {} });
        assert.deepStrictEqual(await collectParentNotesStalenessNotes({ command, member: 'm', rootIds: [], parseBdJson }), []);
        assert.deepStrictEqual(await collectParentNotesStalenessNotes({ command, member: 'm', rootIds: null, parseBdJson }), []);
        assert.strictEqual(calls.length, 0);
    });
});
