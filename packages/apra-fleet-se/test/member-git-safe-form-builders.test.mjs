import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncMemberBefore, syncMemberAfter } from '../fleet-sprint/member-sync.mjs';
import { alignMembersToBase } from '../fleet-sprint/member-align.mjs';
import { runEnsureSprintBranchPhase } from '../fleet-sprint/phases/ensure-sprint-branch.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import {
    findExposedGitForms,
    gitProgramTokens,
    isSafeGitProgramToken,
    memberCommandLayers,
} from './helpers/member-git-safe-form.mjs';

// =============================================================================
// Windows-member engine git commands use the safe form for PowerShell and Git
// Bash (apra-fleet-rx6b.4).
//
// Drives the REAL engine builders that emit member git commands -- the G-pull
// bracket (fetch + ff-only merge, and the retry reset-to-remote-tip path with
// its salvage reads), the G-push bracket (push -u + landed check), launch
// alignment, the Ensure Sprint Branch phase, and the per-shell
// se-os-commands builders -- for a Windows PowerShell, Windows Git Bash, linux
// and macOS member, collecting every emitted command string through an
// injected command() stub.
//
// The safe-form rule (decided and evidenced in member-git-cwd-guard.test.mjs):
// PowerShell and Git Bash resolve a BARE `git` from PATH only, never from the
// work folder, so on a Windows member every git program token must be bare
// `git` (or an absolute path) and no command may use cmd /c git, .\git, ./git
// or a git.cmd/git.bat shim. POSIX member strings are pinned exactly.
// =============================================================================

const BRANCH = 'feat/rx-test';
const BASE = 'main';
const SHA = 'a'.repeat(40);

const MEMBERS = [
    { name: 'win-ps', target: { os: 'windows', shell: 'powershell5' }, windows: true },
    { name: 'win-gb', target: { os: 'windows', shell: 'gitbash' }, windows: true },
    { name: 'lin', target: { os: 'linux', shell: 'bash' }, windows: false },
    { name: 'mac', target: { os: 'darwin', shell: 'zsh' }, windows: false },
];

/** A command() stub mirroring the engine's contract (failSoft -> {ok,output,error}, else the bare output string). */
function recordingCommand(issued) {
    return async (cmd, opts = {}) => {
        issued.push({ member: opts.member_name, cmd });
        let output = '';
        let ok = true;
        let error = 'unexpected failure';
        if (/^git rev-parse HEAD \S+\/\S+/.test(cmd)) output = `${SHA}\n${SHA}\n`;
        else if (/^git rev-parse HEAD$/.test(cmd)) output = `${SHA}\n`;
        else if (/^git rev-parse --abbrev-ref HEAD/.test(cmd)) output = `${BASE}\n`;
        else if (/^git rev-parse --verify --quiet refs\/heads\//.test(cmd)) ok = false;
        else if (/^git ls-remote /.test(cmd)) output = `${SHA}\trefs/heads/${BRANCH}\n`;
        else if (/^git rev-list --count/.test(cmd)) output = '0\n';
        else if (/^git remote get-url origin/.test(cmd)) output = 'https://example.invalid/o/r.git\n';
        else if (/^git fetch origin \S+ --quiet$/.test(cmd) && cmd.includes(BRANCH)) {
            ok = false;
            error = `fatal: couldn't find remote ref ${BRANCH}`;
        }
        const result = ok ? { ok: true, output, error: null } : { ok: false, output: '', error };
        return opts.failSoft ? result : (ok ? output : (() => { throw new Error(result.error); })());
    };
}

/** Every command string the real builders emit for `member`. */
async function collectEngineGitCommands(member) {
    const issued = [];
    const command = recordingCommand(issued);
    const noop = () => {};
    await syncMemberBefore(member, { command, branch: BRANCH });
    await syncMemberBefore(member, { command, branch: BRANCH, resetToRemoteTip: true });
    await syncMemberAfter(member, { command, branch: BRANCH, setUpstream: true });
    await alignMembersToBase({
        members: [member], baseBranch: BASE, branch: BRANCH,
        runGit: (cmd, m) => command(cmd, { member_name: m, failSoft: true }),
    });
    await runEnsureSprintBranchPhase({
        command, log: noop, group: noop, phase: noop, endGroup: noop, publishState: noop,
        branchEnsureMembers: [member],
        validated: { branch: BRANCH, baseBranch: BASE, goal: 'g', maxCycles: 1 },
    });
    for (const i of issued) assert.equal(i.member, member);
    return issued.map((i) => i.cmd);
}

/** The per-shell builder outputs for `target`. */
function seBuilderCommands(target) {
    const cmds = getSeCommands(target);
    return [cmds.ensureGitExcluded('.apra-call/'), cmds.gitLsRemoteProbe()];
}

/** Assert the safe-form rule on every layer of every command; returns the git token count. */
function assertSafeForm(label, commandStrings) {
    let gitTokens = 0;
    for (const cmd of commandStrings) {
        const text = memberCommandLayers(cmd).join('\n');
        assert.deepEqual(findExposedGitForms(text), [], `${label}: exposed git form in: ${text}`);
        for (const token of gitProgramTokens(text)) {
            gitTokens += 1;
            assert.ok(isSafeGitProgramToken(token), `${label}: git token '${token}' is not the safe form in: ${text}`);
        }
    }
    return gitTokens;
}

// The exact strings the OS-agnostic engine builders emit (identical for every
// member OS/shell: execute_command's own shell resolves the bare git).
const EXPECTED_ENGINE_COMMANDS = [
    // G-pull bracket (ff-only)
    `git fetch origin ${BRANCH}`,
    `git merge --ff-only origin/${BRANCH}`,
    // G-pull bracket, retry reset-to-remote-tip with salvage reads
    `git fetch origin ${BRANCH}`,
    `git rev-parse HEAD origin/${BRANCH}`,
    'git -c user.name=fleet-salvage -c user.email=fleet-salvage.invalid stash create',
    `git reset --hard origin/${BRANCH}`,
    // G-push bracket (Publish PR's -u spelling) + landed check
    `git push -u origin ${BRANCH}`,
    'git rev-parse HEAD',
    `git ls-remote origin refs/heads/${BRANCH}`,
    // launch alignment
    'git remote get-url origin',
    `git fetch origin ${BASE} --quiet`,
    `git fetch origin ${BRANCH} --quiet`,
    `git rev-parse --verify --quiet refs/heads/${BRANCH}`,
    'git status --porcelain',
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse --short HEAD',
    `git checkout -B ${BRANCH} origin/${BASE}`,
    'git rev-parse --short HEAD',
    // Ensure Sprint Branch phase
    `git fetch origin ${BASE} --quiet`,
    `git fetch origin ${BRANCH} --quiet`,
    `git rev-parse --verify --quiet refs/heads/${BRANCH}`,
    `git checkout -B ${BRANCH} origin/${BASE}`,
];

test('engine git command strings are unchanged for every member, POSIX included (pinned exactly)', async () => {
    for (const m of MEMBERS) {
        // The engine builders take no OS: every member, Windows included,
        // gets these exact strings.
        assert.deepEqual(await collectEngineGitCommands(m.name), EXPECTED_ENGINE_COMMANDS, m.name);
    }
    const posix = seBuilderCommands({ os: 'linux', shell: 'bash' });
    assert.deepEqual(seBuilderCommands({ os: 'darwin', shell: 'zsh' }), posix);
    assert.equal(posix[1], 'GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git ls-remote origin HEAD');
    assert.match(posix[0], /^if excl=\$\(git rev-parse --git-path info\/exclude 2>\/dev\/null\) && \[ -n "\$excl" \]; then /);
});

test('every collected git invocation for PowerShell and Git Bash members uses the safe form', async () => {
    for (const m of MEMBERS) {
        const emitted = [...await collectEngineGitCommands(m.name), ...seBuilderCommands(m.target)];
        const gitTokens = assertSafeForm(m.name, emitted);
        // Non-vacuous: the run really did collect git invocations, including
        // from the per-shell builders' decoded -EncodedCommand layers.
        assert.ok(gitTokens >= EXPECTED_ENGINE_COMMANDS.length + 2, `${m.name}: only ${gitTokens} git invocations collected`);
    }
    // The PowerShell member's builders really are PowerShell-encoded, and the
    // git inside them is the bare PATH-resolved token.
    const [excl, probe] = seBuilderCommands({ os: 'windows', shell: 'powershell5' });
    assert.match(memberCommandLayers(excl).join('\n'), /@\(git rev-parse --git-path info\/exclude 2>\$null\)/);
    assert.match(memberCommandLayers(probe).join('\n'), /\$env:GCM_INTERACTIVE='never'; git ls-remote origin HEAD/);
});

test('the safe-form assertion fails on a cmd /c git or .\\git form', () => {
    const encode = (s) => `powershell -EncodedCommand ${Buffer.from(s, 'utf16le').toString('base64')}`;
    const bad = [
        `cmd /c git fetch origin ${BRANCH}`,
        `.\\git push -u origin ${BRANCH}`,
        encode(`$env:GIT_TERMINAL_PROMPT='0'; .\\git ls-remote origin HEAD`),
        encode(`cmd.exe /c git rev-parse --git-path info/exclude`),
        'git.cmd fetch origin',
    ];
    for (const cmd of bad) {
        assert.throws(() => assertSafeForm('fixture', [cmd]), assert.AssertionError, cmd);
    }
});
