import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlanPhase } from '../fleet-sprint/phases/plan.mjs';
import { runReplanPhase } from '../fleet-sprint/phases/replan.mjs';
import { buildPlannerPrompt, buildPlanReviewerPrompt, formatScopeMembershipBlock } from '../fleet-sprint/prompts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '../apra-pm/agents');
const HEADER = 'SPRINT SCOPE MEMBERSHIP (orchestrator-computed, every depth)';

// Fixture graph: root -> feat -> task -> subtask (depth 3), plus one closed bead.
const baseBeads = () => [
    { id: 'root', issue_type: 'epic', status: 'open', title: 'Root' },
    { id: 'root.feat', issue_type: 'feature', status: 'open', parent: 'root', title: 'Feature' },
    { id: 'root.feat.task', issue_type: 'task', status: 'open', parent: 'root.feat', title: 'Task' },
    { id: 'root.feat.task.sub', issue_type: 'task', status: 'open', parent: 'root.feat.task', title: 'Subtask' },
    { id: 'root.done', issue_type: 'task', status: 'closed', parent: 'root', title: 'Done' },
];

// Harness: bdListScoped behaves like the real one -- it serves a CACHED
// snapshot until invalidateAllBeadsCache() is called -- so a missing explicit
// invalidation before the plan-reviewer snapshot is observable. The dispatch
// ctx's own invalidate hook is a deliberate no-op so only the phase's explicit
// invalidation can refresh the cache.
function makeHarness({ onPlannerDispatch, failSnapshot = false } = {}) {
    const db = baseBeads();
    let cache = null;
    const prompts = [];
    const logs = [];
    const bdListScoped = async (rest) => {
        assert.strictEqual(rest, '');
        if (failSnapshot) throw new Error('bd exploded');
        if (!cache) cache = db.map((b) => ({ ...b }));
        return cache;
    };
    const invalidateAllBeadsCache = () => { cache = null; };
    const proxy = (v) => new Proxy({}, { get: () => v });
    const dispatchCtx = {
        agent: async (prompt, opts) => {
            prompts.push({ role: opts.agentType || opts.label, prompt, label: opts.label });
            if (opts.agentType === 'planner' || /plan/i.test(opts.label || '') && !/review/i.test(opts.label || '')) {
                if (onPlannerDispatch) onPlannerDispatch(db);
                return 'planned';
            }
            return { verdict: 'APPROVED', notes: null };
        },
        withGitSync: async (_m, _p, invoke) => invoke(),
        withDispatchWatchdog: (p) => p,
        log: (m) => logs.push(m),
        getMemberForRole: () => 'local',
        memberSessionGuard: () => {},
        onLlmAuthFailure: async () => false,
        fixedRoleTier: proxy('standard'),
        budgets: proxy(1),
        schemas: proxy({}),
        steps: proxy(async () => undefined),
        invalidateAllBeadsCache: () => {},
        isNoMutationDispatchFailure: () => false,
    };
    return { db, prompts, logs, bdListScoped, invalidateAllBeadsCache, dispatchCtx };
}

async function runPlan(h) {
    return runPlanPhase({
        phase: () => {}, log: (m) => h.logs.push(m),
        command: async () => { throw new Error('no bd in this harness'); },
        dispatchCtx: h.dispatchCtx,
        cycle: 1, validated: { goal: 'P1' }, targetIssues: ['root'], requirementsContent: null,
        backlogMember: 'local', getMemberForRole: () => 'local',
        sprintState: {}, gitSync: {}, args: {},
        verifySetThisCycle: [],
        roundSessions: { resumeArgFor: () => false, record: () => {} },
        pendingRejectedNewTasks: [],
        resolveSettleShell: async () => 'posix',
        parseBdJson: (r) => r,
        extractContestedBeadIds: () => [],
        reconcilePendingRejectedNewTasks: (p) => p,
        stageCommandBodyMemberSide: async () => {},
        updateDashboard: async () => {},
        bdListScoped: h.bdListScoped,
        invalidateAllBeadsCache: h.invalidateAllBeadsCache,
    });
}

const plannerPromptOf = (h) => h.prompts.find((p) => p.role === 'planner').prompt;
const reviewerPromptOf = (h) => h.prompts.find((p) => p.role === 'plan-reviewer').prompt;

describe('planner / plan-reviewer prompts carry the every-depth scope', () => {
    test('1. depth-3 subtask id appears in the membership block of BOTH prompts, matching bdListScoped', async () => {
        const h = makeHarness();
        await runPlan(h);
        const expected = (await h.bdListScoped('')).filter((b) => b.status !== 'closed').map((b) => b.id);
        for (const prompt of [plannerPromptOf(h), reviewerPromptOf(h)]) {
            assert.ok(prompt.includes(HEADER), 'membership header present');
            const block = prompt.slice(prompt.indexOf(HEADER)).split('\n\n')[0];
            for (const id of expected) assert.ok(block.includes(`${id} |`), `block lists ${id}`);
            assert.ok(block.includes('root.feat.task.sub | task | open | root.feat.task | Subtask'));
            assert.ok(!block.includes('root.done |'), 'closed beads are a count only');
            assert.ok(block.includes('Closed beads in scope: 1'));
        }
    });

    test('2. a bead created by the planner this round appears in the plan-reviewer block (cache invalidated)', async () => {
        const h = makeHarness({
            onPlannerDispatch: (db) => db.push({ id: 'root.feat.new', issue_type: 'task', status: 'open', parent: 'root.feat', title: 'Created mid-round' }),
        });
        await runPlan(h);
        assert.ok(!plannerPromptOf(h).includes('root.feat.new'), 'planner snapshot predates the creation');
        assert.ok(reviewerPromptOf(h).includes('root.feat.new | task | open | root.feat | Created mid-round'));
    });

    test('3. snapshot fetch failure: dispatch still happens, no block, WARN logged', async () => {
        const h = makeHarness({ failSnapshot: true });
        await runPlan(h);
        assert.strictEqual(h.prompts.length, 2);
        assert.ok(!plannerPromptOf(h).includes(HEADER));
        assert.ok(!reviewerPromptOf(h).includes(HEADER));
        assert.ok(h.logs.some((l) => l.includes('WARN') && l.includes('scope snapshot')), 'WARN line logged');
    });

    test('replan path: scoped planner and scoped plan-reviewer prompts both carry the block', async () => {
        const h = makeHarness();
        await runReplanPhase({
            phase: () => {}, log: (m) => h.logs.push(m), dispatchCtx: h.dispatchCtx,
            cycle: 1, validated: { goal: 'P1' }, targetIssues: ['root'], requirementsContent: null,
            backlogMember: 'local',
            gitSync: { syncBeadsAfter: async () => {} }, updateDashboard: async () => {},
            verifySetThisCycle: [], pendingRejectedNewTasks: [],
            devRounds: 1, eligibleReplan: [{ id: 'root.feat.task' }],
            replanIds: new Set(['root.feat.task']), replannedThisCycle: new Set(),
            perBeadFeedback: new Map(),
            bdListScoped: h.bdListScoped, invalidateAllBeadsCache: h.invalidateAllBeadsCache,
        });
        assert.strictEqual(h.prompts.length, 2);
        for (const p of h.prompts) {
            assert.ok(p.prompt.includes(HEADER), `${p.label} carries the block`);
            assert.ok(p.prompt.includes('root.feat.task.sub |'));
        }
    });

    test('no snapshot -> both builders output is byte-identical to the no-argument output', () => {
        const pOpts = { isDeltaCycle: false, targetIssues: ['r'], goal: 'P1', requirementsFile: undefined, requirementsContent: null, feedback: null };
        const rOpts = { targetIssues: ['r'], goal: 'P1' };
        for (const snap of [undefined, null, []]) {
            assert.strictEqual(buildPlannerPrompt({ ...pOpts, scopeSnapshot: snap }), buildPlannerPrompt(pOpts));
            assert.strictEqual(buildPlanReviewerPrompt({ ...rOpts, scopeSnapshot: snap }), buildPlanReviewerPrompt(rOpts));
        }
        assert.ok(!buildPlanReviewerPrompt(rOpts).includes(HEADER));
        assert.ok(buildPlanReviewerPrompt(rOpts).includes('Sprint root / scope to review'), 'distinct from the pre-existing scope clause');
    });

    test('block caps at 300 non-closed entries, states the omitted count, strips non-ASCII', () => {
        const many = Array.from({ length: 305 }, (_, i) => ({ id: `b${String(i).padStart(3, "0")}`, issue_type: 'task', status: 'open', title: i === 0 ? 'caf\u00e9 \u2014 x' : 't' }));
        const block = formatScopeMembershipBlock(many);
        assert.ok(block.includes("b299 |") && !block.includes("b300 |"));
        assert.ok(block.includes('5 further non-closed bead(s) omitted'));
        assert.ok(/^[\x00-\x7f]*$/.test(block));
        assert.ok(block.includes('caf  x') || block.includes('caf x'));
    });
});

describe('role docs state that bd list --parent returns direct children only', () => {
    for (const f of ['planner.md', 'plan-reviewer.md', '_shared/GRAPH-SEMANTICS.md']) {
        test(f, () => {
            const text = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
            assert.ok(/DIRECT children only/.test(text), `${f} mentions direct children only`);
            assert.ok(text.includes('SPRINT SCOPE MEMBERSHIP'), `${f} names the membership block`);
        });
    }
});
