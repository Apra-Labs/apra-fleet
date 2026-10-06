import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeOwedTriage, formatOwedTriageLines } from '../fleet-sprint/owed-triage.mjs';

// =============================================================================
// Pure owed-triage collector: four categories, each with a positive and a
// negative case, plus the total/empty contract and the no-I/O contract.
// ASCII only.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(__dirname, '..', 'fleet-sprint', 'owed-triage.mjs');

const task = (id, extra = {}) => ({ id, title: `Task ${id}`, status: 'open', issue_type: 'task', ...extra });
const childOf = (parent, id, status) => ({
    id, title: `Child ${id}`, status, issue_type: 'task', parent,
    metadata: { streak: 's', model: 'standard' },
});

describe('unroutedFollowUps', () => {
    test('open task missing streak or model is listed', () => {
        const t = computeOwedTriage({
            scopeBeads: [
                task('T-1'),
                task('T-2', { metadata: { streak: 'a' } }),
                task('T-3', { metadata: JSON.stringify({ model: 'premium' }) }),
            ],
        });
        assert.deepEqual(t.unroutedFollowUps.map((x) => x.id), ['T-1', 'T-2', 'T-3']);
        assert.match(t.unroutedFollowUps[0].reason, /streak and model/);
        assert.match(t.unroutedFollowUps[1].reason, /missing model/);
        assert.match(t.unroutedFollowUps[2].reason, /missing streak/);
        assert.equal(t.unroutedFollowUps[0].title, 'Task T-1');
    });

    test('task WITH both streak and model is not unrouted; closed or non-task beads are ignored', () => {
        const t = computeOwedTriage({
            scopeBeads: [
                task('T-1', { metadata: { streak: 'a', model: 'standard' } }),
                task('T-2', { status: 'closed' }),
                task('B-1', { issue_type: 'bug' }),
                task('T-3', { status: 'deferred' }),
            ],
        });
        assert.deepEqual(t.unroutedFollowUps, []);
        assert.equal(t.total, 0);
    });
});

describe('strandedRollups', () => {
    test('open parent whose children are all closed is listed, with an optional reason', () => {
        const t = computeOwedTriage({
            scopeBeads: [
                { id: 'F-1', title: 'Feature one', status: 'open', issue_type: 'feature' },
                childOf('F-1', 'F-1.1', 'closed'),
                childOf('F-1', 'F-1.2', 'closed'),
                // Linked via dependencies rather than the parent field.
                { id: 'E-1', title: 'Epic', status: 'open', issue_type: 'epic' },
                {
                    id: 'E-1.1', title: 'dep child', status: 'closed', issue_type: 'task',
                    dependencies: [{ issue_id: 'E-1.1', depends_on_id: 'E-1', type: 'parent-child' }],
                },
            ],
            strandedReasons: { 'F-1': 'integration test skipped' },
        });
        assert.deepEqual(t.strandedRollups.map((x) => x.id), ['F-1', 'E-1']);
        assert.match(t.strandedRollups[0].reason, /integration test skipped/);
        assert.match(t.strandedRollups[0].reason, /all 2 child/);
    });

    test('parent with one open child is not stranded; a closed parent is not stranded', () => {
        const t = computeOwedTriage({
            scopeBeads: [
                { id: 'F-1', title: 'Feature one', status: 'open', issue_type: 'feature' },
                childOf('F-1', 'F-1.1', 'closed'),
                childOf('F-1', 'F-1.2', 'open'),
                { id: 'F-2', title: 'Done feature', status: 'closed', issue_type: 'feature' },
                childOf('F-2', 'F-2.1', 'closed'),
            ],
        });
        assert.deepEqual(t.strandedRollups, []);
        // An open task with children is a container, never an unrouted follow-up.
        assert.deepEqual(t.unroutedFollowUps, []);
    });
});

test('the sprint target ids are never reported as unrouted or stranded', () => {
    const t = computeOwedTriage({
        targetIds: ['ROOT', 'T-9'],
        scopeBeads: [
            { id: 'ROOT', title: 'Sprint root', status: 'open', issue_type: 'epic' },
            childOf('ROOT', 'ROOT.1', 'closed'),
            task('T-9'),
        ],
    });
    assert.equal(t.total, 0);
    const control = computeOwedTriage({ scopeBeads: [
        { id: 'ROOT', title: 'Sprint root', status: 'open', issue_type: 'epic' },
        childOf('ROOT', 'ROOT.1', 'closed'),
        task('T-9'),
    ] });
    assert.equal(control.total, 2, 'non-vacuity: without targetIds both are listed');
});

describe('rejectedFindings', () => {
    test('each rejectedNewTasks entry is listed with its title, reason and cycle', () => {
        const t = computeOwedTriage({
            rejectedNewTasks: [
                { cycle: 2, reason: 'priority out of range', raw: { title: 'Fix the flaky\nretry' } },
                { cycle: 'final', reason: 'missing title', raw: { description: 'x' } },
            ],
        });
        assert.equal(t.rejectedFindings.length, 2);
        assert.equal(t.rejectedFindings[0].title, 'Fix the flaky retry');
        assert.equal(t.rejectedFindings[0].reason, 'priority out of range');
        assert.equal(t.rejectedFindings[0].cycle, 2);
        assert.equal(t.rejectedFindings[1].title, '(untitled finding)');
        assert.equal(t.total, 2);
    });

    test('no rejected entries yields an empty list', () => {
        assert.deepEqual(computeOwedTriage({ rejectedNewTasks: [] }).rejectedFindings, []);
        assert.deepEqual(computeOwedTriage({ rejectedNewTasks: undefined }).rejectedFindings, []);
    });
});

describe('blockedClosures', () => {
    const start = '2026-10-01T00:00:00Z';
    test('bead closed during the sprint with a blocked: reason (any case) is listed', () => {
        const t = computeOwedTriage({
            sprintStartedAt: start,
            scopeBeads: [
                task('C-1', { status: 'closed', closed_at: '2026-10-02T00:00:00Z', close_reason: 'blocked: missing secret TOKEN' }),
                task('C-2', { status: 'closed', closed_at: '2026-10-02T00:00:00Z', close_reason: 'BLOCKED: waiting on vendor' }),
            ],
        });
        assert.deepEqual(t.blockedClosures.map((x) => x.id), ['C-1', 'C-2']);
        assert.equal(t.blockedClosures[0].reason, 'blocked: missing secret TOKEN');
    });

    test('closed bead with a non-blocked reason, or closed before the sprint, is not listed', () => {
        const t = computeOwedTriage({
            sprintStartedAt: start,
            scopeBeads: [
                task('C-1', { status: 'closed', closed_at: '2026-10-02T00:00:00Z', close_reason: 'Done; not blocked: at all' }),
                task('C-2', { status: 'closed', closed_at: '2026-09-01T00:00:00Z', close_reason: 'blocked: old' }),
                task('C-3', { status: 'open', close_reason: 'blocked: stale field on an open bead' , metadata: { streak: 'a', model: 'b' } }),
            ],
        });
        assert.deepEqual(t.blockedClosures, []);
        assert.equal(t.total, 0);
    });
});

test('closedAtStartIds is authoritative over sprintStartedAt for blocked closures', () => {
    const beads = [
        task('C-1', { status: 'closed', closed_at: '2020-01-01T00:00:00Z', close_reason: 'blocked: closed this sprint, stale clock' }),
        task('C-2', { status: 'closed', closed_at: '2030-01-01T00:00:00Z', close_reason: 'blocked: was already closed at start' }),
    ];
    const t = computeOwedTriage({ scopeBeads: beads, closedAtStartIds: ['C-2'], sprintStartedAt: '2026-10-01T00:00:00Z' });
    assert.deepEqual(t.blockedClosures.map((x) => x.id), ['C-1']);
    const byTime = computeOwedTriage({ scopeBeads: beads, sprintStartedAt: '2026-10-01T00:00:00Z' });
    assert.deepEqual(byTime.blockedClosures.map((x) => x.id), ['C-2'], 'control: the clock fallback alone picks the other one');
    assert.deepEqual(computeOwedTriage({ scopeBeads: beads, closedAtStartIds: new Set() }).blockedClosures.length, 2);
});

describe('total and formatting', () => {
    test('total equals the sum of the four list lengths', () => {
        const t = computeOwedTriage({
            scopeBeads: [
                task('T-1'),
                { id: 'F-1', title: 'F', status: 'open', issue_type: 'feature' },
                childOf('F-1', 'F-1.1', 'closed'),
                task('C-1', { status: 'closed', close_reason: 'blocked: x' }),
            ],
            rejectedNewTasks: [{ cycle: 1, reason: 'bad', raw: { title: 'R' } }],
        });
        const sum = t.unroutedFollowUps.length + t.strandedRollups.length
            + t.rejectedFindings.length + t.blockedClosures.length;
        assert.equal(t.total, sum);
        assert.equal(t.total, 4);
        const lines = formatOwedTriageLines(t);
        assert.match(lines[0], /^owed triage: 4 item\(s\)/);
        for (const needle of ['T-1', 'F-1', 'cycle 1: R', 'C-1']) {
            assert.ok(lines.some((l) => l.includes(needle)), `expected a line naming ${needle}`);
        }
        for (const l of lines) assert.match(l, /^[\x20-\x7E]*$/, `non-ASCII or control char in: ${l}`);
    });

    test('empty input yields total 0 and no formatted lines', () => {
        const t = computeOwedTriage({});
        assert.equal(t.total, 0);
        assert.deepEqual(formatOwedTriageLines(t), []);
        assert.deepEqual(formatOwedTriageLines(computeOwedTriage()), []);
        assert.deepEqual(formatOwedTriageLines(undefined), []);
    });
});

test('module performs no I/O: no bd/child_process/fs/net imports', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l) || /\bimport\s*\(/.test(l));
    for (const l of importLines) {
        assert.doesNotMatch(l, /child_process|node:fs|['"]fs['"]|node:net|node:http|dolt|bd-|beads-scope|member-call/,
            `I/O import found: ${l}`);
    }
    // Pin the current shape exactly: the module imports nothing at all.
    assert.deepEqual(importLines, []);
});
