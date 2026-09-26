import { describe, it, expect } from 'vitest';
import { findMilestoneViolations, parseArgs, parseExport } from '../scripts/check-bead-milestones.mjs';

const bead = (id: string, labels: string[], extra: Record<string, unknown> = {}) => ({ id, title: id, status: 'open', labels, ...extra });

describe('findMilestoneViolations', () => {
    it('accepts exactly one known milestone label', () => {
        expect(findMilestoneViolations([bead('a', ['milestone:v0.4.4', 'fleet-sprint'])])).toEqual([]);
    });

    it('flags missing, multiple and unknown milestone labels', () => {
        const v = findMilestoneViolations([
            bead('a', ['v0.4.3']),
            bead('b', ['milestone:v0.4.3', 'milestone:v0.5']),
            bead('c', ['milestone:v9']),
        ]);
        expect(v.map((x) => [x.id, x.problem])).toEqual([['a', 'missing'], ['b', 'multiple'], ['c', 'unknown']]);
    });

    it('--known overrides the default milestone set', () => {
        const v = findMilestoneViolations([bead('a', ['milestone:v0.6']), bead('b', ['milestone:v0.4.4'])], { known: ['v0.6'] });
        expect(v.map((x) => [x.id, x.problem])).toEqual([['b', 'unknown']]);
    });

    it('ignores closed beads', () => {
        expect(findMilestoneViolations([bead('a', [], { status: 'closed' })])).toEqual([]);
    });

    it('--assignee keeps unassigned and matching beads only', () => {
        const v = findMilestoneViolations(
            [bead('a', []), bead('b', [], { assignee: 'me' }), bead('c', [], { assignee: 'other' })],
            { assignees: ['me'] },
        );
        expect(v.map((x) => x.id)).toEqual(['a', 'b']);
    });
});

describe('parseExport / parseArgs', () => {
    it('drops non-issue records such as memories', () => {
        const text = '{"_type":"issue","id":"a"}\r\n{"_type":"memory","key":"k"}\n';
        expect(parseExport(text).map((o: { id: string }) => o.id)).toEqual(['a']);
    });

    it('parses repeatable --assignee and rejects unknown args', () => {
        expect(parseArgs(['--assignee', 'x', '--assignee', 'y', '--json'])).toMatchObject({ assignees: ['x', 'y'], json: true });
        expect(parseArgs(['--known', 'v1, v2']).known).toEqual(['v1', 'v2']);
        expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    });
});
