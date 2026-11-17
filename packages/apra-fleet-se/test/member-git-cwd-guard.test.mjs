import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import {
    EXPOSED_GIT_FORMS,
    findExposedGitForms,
    gitProgramTokens,
    isSafeGitProgramToken,
    memberCommandLayers,
} from './helpers/member-git-safe-form.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_SPRINT = path.resolve(__dirname, '..', 'fleet-sprint');

// =============================================================================
// Guard: a fleet-sprint engine git command run on a Windows member never
// resolves git from the work folder (apra-fleet-rx6b.3).
//
// PER-SHELL EVIDENCE (local experiment, Windows 10 22H2, Windows PowerShell
// 5.1, Git for Windows 2.47: a whoami.exe copied to <dir>\git.exe, then a bare
// `git` run with <dir> as the current directory):
//   - PowerShell: runs the real git from PATH. An empty PATH entry (leading
//     ';') is ignored -- still the real git. Documented behaviour
//     (about_Command_Precedence): PowerShell does not run a native command
//     from the current location unless it is on PATH or named by path.
//     CAVEAT: a literal '.' entry in $env:Path DID run the planted exe, the
//     same as '.' in PATH on a POSIX member.
//   - Git Bash: runs the real git. Git Bash prepends /mingw64/bin:/usr/bin to
//     PATH (login and non-login), and MSYS drops empty Windows PATH entries
//     (';;' or a leading ';' produce no '::'), so even a '.' Windows entry
//     comes after git's own directory. CAVEAT: a POSIX PATH that puts '.' or
//     an empty entry BEFORE git's directory (e.g. from ~/.bashrc) DID run it.
//   - cmd.exe / shell-less CreateProcess: search the current directory first.
//     No engine git command runs under either: execute_command runs a Windows
//     member's command under powershell.exe (local cleanExec) or bash.exe
//     (gitbash), and a remote member's command is a PowerShell / bash script
//     that could not even start under a cmd.exe DefaultShell.
// So the bare `git` token every engine builder emits is already the safe form
// for both Windows member shells, with no per-call-site change. This guard
// pins that: no engine source line may emit an exposed form (cmd /c git,
// .\git, ./git, git.cmd, git.bat), and the per-shell builders keep the bare
// PATH-resolved `git`.
// =============================================================================

/** Every runtime source file under fleet-sprint (recursive), .mjs/.js only. */
function engineSourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...engineSourceFiles(full));
        else if (/\.(?:mjs|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** True for a whole-line comment (// ..., * ..., /* ...). */
function isCommentLine(line) {
    return /^\s*(?:\/\/|\*|\/\*)/.test(line);
}

/** Exposed git forms on non-comment lines of `source`. */
function scanSource(source) {
    const hits = [];
    source.split(/\r?\n/).forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const f of findExposedGitForms(line)) hits.push({ line: i + 1, ...f, text: line.trim() });
    });
    return hits;
}

test('every exposed git form is detected and the safe forms are not', () => {
    const exposed = [
        'cmd /c git fetch origin',
        'cmd.exe /d /s /c "git push origin main"',
        '.\\git fetch origin',
        './git status --porcelain',
        'Set-Location "C:\\w"; .\\git.exe rev-parse HEAD',
        'git.cmd fetch origin',
        '& git.bat status',
    ];
    for (const cmd of exposed) {
        assert.ok(findExposedGitForms(cmd).length > 0, `must be flagged as exposed: ${cmd}`);
    }
    const safe = [
        'git fetch origin main',
        "$env:GIT_TERMINAL_PROMPT='0'; git ls-remote origin HEAD",
        'git -C "C:\\work" status',
        "import { runGitStep } from './git-topology.mjs';",
        '& "C:\\Program Files\\Git\\cmd\\git.exe" status',
    ];
    for (const cmd of safe) {
        assert.deepEqual(findExposedGitForms(cmd), [], `must not be flagged: ${cmd}`);
    }
    assert.equal(EXPOSED_GIT_FORMS.length, 3);
    // An exposed form hidden inside a -EncodedCommand layer is still found.
    const wrapped = `powershell -EncodedCommand ${Buffer.from('Set-Location "C:\\w"; .\\git fetch', 'utf16le').toString('base64')}`;
    assert.deepEqual(findExposedGitForms(wrapped), []);
    assert.ok(findExposedGitForms(memberCommandLayers(wrapped).join('\n')).length > 0);
});

test('the source scanner flags an exposed form in a fixture and skips comment lines', () => {
    const fixture = [
        '// cmd /c git is mentioned in a comment only',
        ' * .\\git in a block comment',
        "const a = 'git fetch origin';",
        "const b = 'cmd /c git push origin main';",
        'const c = `.\\\\git status`;',
    ].join('\n');
    const hits = scanSource(fixture);
    assert.deepEqual(hits.map((h) => h.line), [4, 5]);
});

test('no fleet-sprint engine source emits a git command in a form that resolves git from the work folder', () => {
    const files = engineSourceFiles(FLEET_SPRINT);
    assert.ok(files.length > 50, `expected the whole engine tree, found ${files.length} files`);
    const violations = [];
    for (const file of files) {
        for (const hit of scanSource(fs.readFileSync(file, 'utf8'))) {
            violations.push(`${path.relative(FLEET_SPRINT, file)}:${hit.line} [${hit.name}] ${hit.text}`);
        }
    }
    assert.deepEqual(violations, [], `exposed git forms found:\n${violations.join('\n')}`);
});

test('per-shell builders keep the bare PATH-resolved git token for Windows PowerShell and Git Bash', () => {
    const targets = [
        { os: 'windows', shell: '' },
        { os: 'windows', shell: 'powershell5' },
        { os: 'windows', shell: 'pwsh7' },
        { os: 'windows', shell: 'gitbash' },
    ];
    for (const target of targets) {
        const cmds = getSeCommands(target);
        for (const outer of [cmds.ensureGitExcluded('.apra-call/'), cmds.gitLsRemoteProbe()]) {
            const built = memberCommandLayers(outer).join('\n');
            assert.deepEqual(findExposedGitForms(built), [], `${JSON.stringify(target)}: ${built}`);
            const tokens = gitProgramTokens(built);
            assert.ok(tokens.length > 0, `${JSON.stringify(target)}: no git invocation found in ${built}`);
            for (const t of tokens) {
                assert.ok(isSafeGitProgramToken(t), `${JSON.stringify(target)}: unsafe git token '${t}' in ${built}`);
            }
        }
    }
    // The PowerShell forms specifically (the shell that would otherwise be
    // tempted to spell .\git or & git.cmd): bare git under the call-free form.
    const ps = getSeCommands({ os: 'windows', shell: '' });
    assert.match(memberCommandLayers(ps.ensureGitExcluded('.apra-call/')).join('\n'), /@\(git rev-parse --git-path info\/exclude 2>\$null\)/);
    assert.match(memberCommandLayers(ps.gitLsRemoteProbe()).join('\n'), /; git ls-remote origin HEAD/);
});
