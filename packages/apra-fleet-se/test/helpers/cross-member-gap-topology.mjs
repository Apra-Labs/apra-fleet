// =============================================================================
// Mock-sprint topology for the verify gap-bug lookup ordering: the
// integ-test-runner runs on a DIFFERENT member from the backlog member, over
// one shared Dolt remote.
//
// The bd database itself is the scenario's single shared temp dir (the
// harness's supported shared-workspace mode), so a gap bug the integ handler
// creates is really there at once. This model adds the cross-member
// staleness on top: a gap bug the integ member filed is NOT visible to a
// `bd show <gap> --json` on the backlog member until the backlog member has
// issued a `bd dolt pull` after the gap was filed -- exactly what a real
// backlog clone sees before it D-pulls the integ member's push. With
// `missAfterPull` the lookup keeps failing after the pull too (a gap that
// never reaches the backlog clone).
//
// Every D-pull/D-push command is answered against a tiny model of ONE shared
// remote (refs/dolt/data), the same shape mock-sprint-dpush-false-success
// uses, so the engine's sync brackets run for real and each backlog
// `bd dolt pull` is counted, tagged with the workflow phase it ran under.
// =============================================================================

export const BACKLOG_MEMBER = 'local';
export const INTEG_MEMBER = 'integ';

const SYNC_REMOTE = 'git+https://example.invalid/org/beads.git';
const LS_REMOTE_RE = / ls-remote https:\/\/example\.invalid\/org\/beads\.git refs\/dolt\/data$/;
const BD_SHOW_RE = /^bd show (\S+) --json$/;

const exit0 = (stdout = '') => ({
    content: [{ type: 'text', text: `Exit code: 0\n${stdout}` }],
    structuredContent: { exitCode: 0, stdout, stderr: '' },
});
const exit1 = (stderr) => ({
    content: [{ type: 'text', text: `Exit code: 1\n${stderr}` }],
    structuredContent: { exitCode: 1, stdout: '', stderr },
});

/**
 * @param {{ missAfterPull?: boolean }} [options]
 * @returns {{
 *   state: { pulls: Array<{ member: string, phase: string|null }>, showMisses: string[] },
 *   onCommand: Function,
 *   onWorkflow: Function,
 *   fileGap: (id: string) => void,
 *   backlogPullsInPhase: (title: string) => number,
 *   roleMap: object,
 *   members: string[],
 * }}
 */
export function crossMemberGapTopology({ missAfterPull = false } = {}) {
    const state = {
        tip: 'a'.repeat(40),
        minted: 0,
        phase: null,
        pulls: [],
        showMisses: [],
    };
    // Filed by the integ member, not yet D-pulled by the backlog member.
    const unpulledGaps = new Set();
    // Every gap ever filed (missAfterPull keeps these failing on the backlog).
    const allGaps = new Set();

    const onCommand = ({ command, member_name: member }) => {
        if (/^bd config get sync\.remote/.test(command)) return exit0(JSON.stringify({ key: 'sync.remote', value: SYNC_REMOTE }));
        if (LS_REMOTE_RE.test(command)) return exit0(`${state.tip}\trefs/dolt/data\n`);
        if (command === 'bd dolt pull') {
            state.pulls.push({ member, phase: state.phase });
            if (member === BACKLOG_MEMBER) unpulledGaps.clear();
            return exit0('Pull complete.\n');
        }
        if (command === 'bd vc status --json') return exit0(JSON.stringify({ branch: 'main', commit: 'x', schema_version: 1 }));
        if (command === 'bd diff remotes/origin/main main --json') return exit0(JSON.stringify([{ IssueID: 'mock-1', DiffType: 'modified' }]));
        if (command === 'bd dolt push') {
            state.minted += 1;
            state.tip = String(state.minted).padStart(40, '0');
            return exit0('Push complete.\n');
        }
        const show = command.match(BD_SHOW_RE);
        if (show && member === BACKLOG_MEMBER && (unpulledGaps.has(show[1]) || (missAfterPull && allGaps.has(show[1])))) {
            state.showMisses.push(show[1]);
            return exit1(`Error: Issue ${show[1]} not found`);
        }
        return undefined;
    };

    const onWorkflow = (workflow) => {
        workflow.on('phase', (title) => { state.phase = String(title); });
    };

    return {
        state,
        onCommand,
        onWorkflow,
        fileGap: (id) => { unpulledGaps.add(id); allGaps.add(id); },
        backlogPullsInPhase: (title) => state.pulls.filter((p) => p.member === BACKLOG_MEMBER && p.phase === title).length,
        members: [BACKLOG_MEMBER, INTEG_MEMBER],
        roleMap: { backlog: [BACKLOG_MEMBER], 'integ-test-runner': [INTEG_MEMBER] },
    };
}
