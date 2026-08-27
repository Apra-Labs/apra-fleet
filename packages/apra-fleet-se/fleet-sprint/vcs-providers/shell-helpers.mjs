/**
 * Shared shell-quoting, curl-binary and token-assertion helpers for VCS
 * provider command builders. Used by GitHub and Azure DevOps, and available
 * for use by other providers to ensure consistent shell-escaping rules across
 * all providers.
 *
 * RE-LANDED (apra-fleet-lzfv.2): apra-fleet-lzfv.1 first hoisted shQuote() and
 * assertToken() out of ./github.mjs into this module; commit 1188d2ab (an
 * unrelated orchestrator-sync/dolt-timeout change) then deleted this file and
 * re-inlined both as private definitions in github.mjs. This is that same pure
 * move re-applied, with curlBinary() added to it -- ./azure-devops.mjs needs
 * the Windows curl.exe token for exactly the same reason github.mjs does, and
 * copying it would recreate the duplication this module exists to prevent.
 *
 * shQuote's shell-aware (3rd `shell` arg) form was re-landed here on top of
 * that: 0e291ace (fix(fleet-sprint): quote VCS curl commands by member shell,
 * not bare OS) found that a Windows member whose registered shell is
 * Git-for-Windows bash got PowerShell doubled-quote escaping from the
 * OS-only check, corrupting the create-PR curl -d JSON payload. That fix
 * originally landed inline in github.mjs (github.mjs was still the only
 * caller); merged in here so both providers share the corrected logic
 * instead of github.mjs re-diverging from this module a second time.
 *
 * ASCII only.
 */

/** Single-quote a string for embedding in a shell command. The built curl
 *  command is dispatched through the member's own COMMAND SHELL, so the
 *  quoting dialect must follow that shell -- NOT the bare OS:
 *    - POSIX sh/bash (and Git-for-Windows bash on a Windows member) closes/
 *      reopens the quote around an embedded single quote ('\'').
 *    - Windows PowerShell (see wrapPowerShellEncoded()/isWindows in
 *      src/tools/remove-member.ts) escapes an embedded single quote inside a
 *      single-quoted string by DOUBLING it (''), not by backslash-closing.
 *  Using the POSIX form on a PowerShell member breaks the quoting outright
 *  (observed live: Publish PR crashing on any title/body containing an
 *  apostrophe) -- and, the mirror defect, using the PowerShell form on a
 *  Windows member whose registered shell is gitbash corrupts the curl -d
 *  JSON payload (observed live: GitHub's create-PR endpoint answering
 *  "HTTP 400: Problems parsing JSON"), because bash reads '' as
 *  close-then-reopen, not as an escaped quote.
 *
 *  `os` is one of resolveMemberOs()'s return values ('windows'/'linux'/
 *  'darwin'); `shell` is the member's registered shell as resolved by
 *  runner.js's resolveMemberTarget() -- 'gitbash' | 'pwsh7' | 'powershell5'
 *  | '' (empty/undefined when the registry recorded none, or when a caller
 *  does not yet thread shell through -- see usesPowerShellQuoting below).
 *  Resolution, mirroring se-os-commands.mjs's getSeCommands() matrix:
 *    - shell 'gitbash'                 -> POSIX quoting, even on Windows
 *    - shell 'pwsh7'/'powershell5'     -> PowerShell doubling
 *    - unresolved shell ('' / undefined) + windows -> PowerShell doubling
 *      (the historical default: every Windows member was assumed PowerShell
 *      before shells were recorded -- the fallback stays byte-identical)
 *    - any non-Windows os              -> POSIX quoting, byte-identical to
 *      before this parameter existed. */
function usesPowerShellQuoting(os, shell) {
    if (shell === 'gitbash') return false;
    if (shell === 'pwsh7' || shell === 'powershell5') return true;
    return os === 'windows';
}

function shQuote(value, os, shell) {
    if (usesPowerShellQuoting(os, shell)) {
        return `'${String(value).replace(/'/g, "''")}'`;
    }
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Which curl binary token to emit for a given member OS. On Windows the bare
 *  word `curl` is a built-in PowerShell alias for Invoke-WebRequest, NOT the
 *  real curl -- Invoke-WebRequest's -Headers parameter wants a hashtable, not
 *  curl's repeatable `-H 'k: v'` string syntax, so a bare `curl -H ...`
 *  command sent to a Windows/PowerShell member fails with a parameter-bind
 *  error (observed live on the Publish PR step). The real curl.exe binary has
 *  shipped in %SystemRoot%\System32 since Windows 10 1803 and is resolvable
 *  from PowerShell's default PATH (verified locally: `where curl.exe` and
 *  `Get-Command curl.exe` both resolve on a live Windows box), so emitting
 *  the explicit `curl.exe` token sidesteps the alias entirely without
 *  needing a different request mechanism. Non-Windows os values keep the
 *  bare `curl` token byte-identical to before this branch existed.
 *  Deliberately OS-keyed (not shell-keyed like shQuote above): curl.exe is
 *  equally resolvable from Git-for-Windows bash, so a windows+gitbash member
 *  keeps the same binary token. */
function curlBinary(os) {
    return os === 'windows' ? 'curl.exe' : 'curl';
}

function assertToken(token) {
    const value = String(token ?? '');
    if (!value) {
        throw new Error('ERROR: VCSModule: no token supplied -- caller must mint one via provision_vcs_auth before calling VCSModule.');
    }
    return value;
}

export { shQuote, usesPowerShellQuoting, curlBinary, assertToken };
