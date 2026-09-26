/** A realistic mid-sprint run state, shaped like the sprint engine writes it. */
export const RUN_ID = '3f1c2a9e-7b44-4d2c-9a51-0c6f1e2d8b10';

export function makeRunState(now = Date.now()) {
  const t = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const ms = (minAgo: number) => now - minAgo * 60_000;
  const H = ['lz-shop-0', 'lz-shop-1', 'lz-shop-2'];
  const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, status: 'open', priority: 2, issue_type: 'task', parent: undefined as string | undefined, ready: true, placement: 'sprint', ...extra,
  });
  const sprintTasks = [
    task('shop-9x', 'Dark mode for the storefront', { issue_type: 'epic', priority: 1, description: 'Users want a dark theme.' }),
    task('shop-9x.1', 'Theme foundation', { issue_type: 'feature', parent: 'shop-9x', priority: 1 }),
    task('shop-9x.2', 'Settings and persistence', { issue_type: 'feature', parent: 'shop-9x', priority: 1 }),
    task('shop-9x.1.1', 'Define color tokens for light and dark', { parent: 'shop-9x.1', status: 'closed', priority: 1, closed_at: t(30), metadata: { model: 'cheap' } }),
    task('shop-9x.1.2', 'Swap hard-coded colors in components', { parent: 'shop-9x.1', status: 'in_progress', priority: 1, started_at: t(12), metadata: { model: 'standard' }, description: 'Replace every hex literal in src/components with a token.', acceptance_criteria: 'No hex colors left in src/components; snapshot tests pass.' }),
    task('shop-9x.1.3', 'Fix contrast on checkout buttons', { parent: 'shop-9x.1', issue_type: 'bug', priority: 0, status: 'in_progress', started_at: t(6), metadata: { model: 'standard' } }),
    task('shop-9x.2.1', 'Add the dark mode toggle to settings', { parent: 'shop-9x.2', priority: 1, metadata: { model: 'standard' } }),
    task('shop-9x.2.2', 'Remember the choice across visits', { parent: 'shop-9x.2', priority: 2, ready: false, dependencies: [{ issue_id: 'shop-9x.2.2', depends_on_id: 'shop-9x.2.1', type: 'blocks' }] }),
    task('shop-9x.2.3', 'Follow the system theme by default', { parent: 'shop-9x.2', priority: 2 }),
    task('shop-9x.3', 'Update screenshots in the docs', { parent: 'shop-9x', priority: 3, issue_type: 'chore' }),
  ];
  const act = (id: string, phase: string, label: string, member: string, startMin: number, extra: Record<string, unknown> = {}) => ({
    type: 'activity', id, data: { id, type: 'agent', phase, label, member, model: 'standard', startTime: ms(startMin), isRunning: false, ...extra },
  });
  return {
    workflowName: 'Fleet-Sprint',
    status: 'running',
    runId: RUN_ID,
    args: { members: H, targetIssues: ['shop-9x'], goal: 'P1/P2' },
    result: null,
    terminalReason: null,
    startedAt: t(48),
    updatedAt: t(0),
    endedAt: null,
    stats: { activitiesCount: 9, totalTokens: 812_400, totalCost: 3.87, durationMs: 48 * 60_000 },
    pause: { status: 'none', reason: null },
    tree: [
      {
        title: 'Cycle 1',
        phases: [
          { title: 'Initialization', phaseStartedAt: t(48), phaseEndedAt: t(47), events: [] },
          { title: 'Ensure Sprint Branch', phaseStartedAt: t(47), phaseEndedAt: t(47), events: [
            act('c1', 'Ensure Sprint Branch', 'Fetch main on member lz-shop-2', H[2], 47, { type: 'command', duration: 2000, success: true }),
          ] },
          {
            title: 'Plan C1 R1', phaseStartedAt: t(47), phaseEndedAt: t(36), events: [
              act('a1', 'Plan', 'Planner: shop-9x', H[0], 47, { duration: 7 * 60_000, success: true, cost: 0.92 }),
              act('a2', 'Plan', 'Plan review', H[1], 40, { duration: 4 * 60_000, success: true, cost: 0.31 }),
            ],
          },
          {
            title: 'Develop C1 R1', phaseStartedAt: t(36), phaseEndedAt: null, events: [
              act('a3', 'Develop', 'Streak Assignment', H[0], 36, { duration: 60_000, success: true, cost: 0.05, type: 'agent' }),
              act('a4', 'Develop', 'Streak shop-9x.1.1', H[1], 35, { duration: 5 * 60_000, success: true, cost: 0.4 }),
              act('a5', 'Develop', 'Review shop-9x.1.1', H[2], 29, { duration: 3 * 60_000, success: true, cost: 0.22 }),
              act('a6', 'Develop', 'Streak shop-9x.1.2', H[1], 12, { isRunning: true }),
              act('a7', 'Develop', 'Streak shop-9x.1.3', H[2], 6, { isRunning: true }),
              act('a8', 'Develop', 'Streak shop-9x.2.3', H[0], 20, { duration: 4 * 60_000, success: false, cost: 0.3 }),
              act('c2', 'Develop', 'bd close shop-9x.2.1 --reason done', H[0], 1, { type: 'command', isRunning: true }),
            ],
          },
        ],
      },
    ],
    extensions: { beads: { sprintTasks, goalMax: 2, decomposedParentIds: ['shop-9x', 'shop-9x.1', 'shop-9x.2'] } },
  };
}
