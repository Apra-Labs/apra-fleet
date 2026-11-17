// member-git-safe-form.mjs -- the safe-form rule for git invocations in
// member-bound command strings, shared by the static source guard
// (member-git-cwd-guard.test.mjs) and the builder-driving test
// (member-git-safe-form-builders.test.mjs).
//
// WHY (measured, see the guard test header for the per-shell evidence): every
// engine member-bound command reaches the member through execute_command,
// which runs it under PowerShell (Windows, no recorded shell / pwsh7 /
// powershell5) or Git Bash (Windows, shell gitbash) or a POSIX shell. Neither
// PowerShell nor Git Bash searches the current directory for a BARE program
// name: both resolve `git` from PATH only. cmd.exe and a shell-less
// CreateProcess DO search the current directory (the work folder) first, and
// an explicit `.\git` / `./git` names the work folder directly; a `git.cmd` /
// `git.bat` shim is only runnable through cmd.exe. So the safe form is the
// bare `git` token (or an absolute path), and these are the exposed forms:

/** @type {Array<{ name: string, re: RegExp }>} */
export const EXPOSED_GIT_FORMS = [
    {
        // cmd /c git ..., cmd.exe /k "git ...", cmd /d /s /c git ...
        name: 'cmd /c git',
        re: /\bcmd(?:\.exe)?["']?(?:\s+\/[a-z])*\s+\/[ck]\b[^\n]*\bgit\b/i,
    },
    {
        // .\git, ./git, ..\git, .\\git (JS-escaped), with or without an extension.
        // The lookahead stops ./git-topology.mjs style module paths matching.
        name: '.\\git (work-folder-relative git)',
        re: /(?:^|[\s;&|('"`=])\.{1,2}[\\/]+git(?:\.exe|\.cmd|\.bat)?(?=$|[\s'"`;&|)])/i,
    },
    {
        // git.cmd / git.bat: only cmd.exe can run a batch shim.
        name: 'git.cmd / git.bat shim',
        re: /\bgit\.(?:cmd|bat)\b/i,
    },
];

/**
 * Every exposed git form found in `text`.
 * @param {string} text
 * @returns {Array<{ name: string, match: string }>}
 */
export function findExposedGitForms(text) {
    const found = [];
    for (const { name, re } of EXPOSED_GIT_FORMS) {
        const m = re.exec(String(text));
        if (m) found.push({ name, match: m[0] });
    }
    return found;
}

/**
 * The text a member shell actually runs: `cmd` itself plus, for every
 * `powershell -EncodedCommand <base64>` layer, the decoded (UTF-16LE) script.
 * @param {string} cmd
 * @returns {string[]}
 */
export function memberCommandLayers(cmd) {
    const layers = [String(cmd)];
    for (let i = 0; i < layers.length; i += 1) {
        const re = /\bpowershell(?:\.exe)?(?:\s+-\S+)*?\s+-EncodedCommand\s+([A-Za-z0-9+/=]+)/gi;
        let m;
        while ((m = re.exec(layers[i])) !== null) {
            layers.push(Buffer.from(m[1], 'base64').toString('utf16le'));
        }
    }
    return layers;
}

/**
 * The program token of each git invocation in a command string: the word
 * naming git at a statement start (start of string, after ; & | ( { the
 * PowerShell call operator, or POSIX VAR=value assignments). Returns the raw
 * tokens, e.g. ['git', 'git'].
 * @param {string} cmd
 * @returns {string[]}
 */
export function gitProgramTokens(cmd) {
    const tokens = [];
    const re = /(?:^|[;&|({]|\bthen\b|\bdo\b|\$\(|@\()\s*(?:&\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(["']?)([^\s"';&|()]*git(?:\.exe|\.cmd|\.bat)?)\1(?=\s|$)/gi;
    let m;
    while ((m = re.exec(String(cmd))) !== null) tokens.push(m[2]);
    return tokens;
}

/**
 * True when a git program token is the safe form: the bare name `git` (PATH
 * lookup only under PowerShell and Git Bash) or an absolute path.
 * @param {string} token
 */
export function isSafeGitProgramToken(token) {
    if (token === 'git' || token === 'git.exe') return true;
    return /^(?:[A-Za-z]:[\\/]|\/)/.test(token) && !/\.(?:cmd|bat)$/i.test(token);
}
