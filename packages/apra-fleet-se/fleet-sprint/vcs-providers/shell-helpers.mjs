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

/** Pre-escape `value` for the Windows C-runtime argv parser that a NATIVE
 *  executable (curl.exe) applies to the command line PowerShell hands it.
 *
 *  Windows PowerShell 5.1's native-command argument binder (and pwsh before
 *  7.3) passes a single-quoted argument's VALUE through to the child process
 *  command line without escaping anything: the only thing it does is wrap
 *  the value in double quotes when it finds whitespace OUTSIDE what it
 *  counts as a double-quoted region. The child's CRT parser then eats every
 *  embedded `"` as a quote toggle, so a JSON payload like {"title":"x y"}
 *  reaches curl.exe as {title:x y} (measured live on powershell.exe
 *  5.1.19041 with a node argv probe: every `"` stripped, spaces kept) and
 *  Azure DevOps/GitHub answer HTTP 400 to the unparseable body. Same defect
 *  class dolt-settle.mjs's nodeEval() already works around for its
 *  PowerShell branch.
 *
 *  The CRT rules (CommandLineToArgvW / MSVC argv), which this function
 *  inverts so the child reconstructs `value` byte-for-byte:
 *    - 2n backslashes + `"`   -> n backslashes, `"` toggles quoting
 *    - 2n+1 backslashes + `"` -> n backslashes, literal `"`
 *    - backslashes NOT followed by `"` are literal (so a JSON `\n` escape
 *      inside a string value is left alone)
 *  So every run of n backslashes that precedes a `"` becomes 2n+1
 *  backslashes + `"` (n=0: `"` -> `\"`).
 *
 *  LIMIT (measured, not assumed): the 5.1 binder counts a backslash-escaped
 *  `\"` toward its quote parity exactly like a bare `"`, while the CRT does
 *  NOT toggle on it -- so for a value carrying BOTH whitespace and quotes
 *  the two parsers disagree about whether that whitespace is "inside
 *  quotes", the binder skips its wrapping, and the CRT splits the argument
 *  at the whitespace (observed: a JSON title 'Auto-sprint [PASS]: x'
 *  arrived as two argv entries). There is no escape sequence both parsers
 *  read the same way, so a caller must keep such a value whitespace-free --
 *  see shQuoteJson() below, which does exactly that for JSON payloads (the
 *  only quote-bearing arguments the VCS builders emit). A value with
 *  whitespace but NO quotes (an `-H 'Content-Type: application/json'`
 *  header) is wrapped by the binder and parsed back intact by the CRT.
 *
 *  NOTE pwsh 7.3+ defaults $PSNativeCommandArgumentPassing to 'Windows'
 *  mode, which escapes embedded `"` itself; this pre-escaping is for the
 *  legacy binder that every Windows member in this fleet is driven through
 *  today (src/os/windows.ts cleanExec() spawns `powershell.exe`, and the
 *  remote path sends raw PowerShell text to the member's default shell). */
function escapeForWindowsArgv(value) {
    return String(value).replace(/(\\*)"/g, (_m, backslashes) => `${backslashes}${backslashes}\\"`);
}

function shQuote(value, os, shell) {
    if (usesPowerShellQuoting(os, shell)) {
        // Two layers, applied inside-out: first the CRT argv pre-escaping
        // above (what the NATIVE child parses), then PowerShell's own
        // single-quoted-string escape (what PowerShell parses to get the
        // value it hands the binder) -- a lone `'` inside a `'...'` string
        // is written as `''`.
        return `'${escapeForWindowsArgv(value).replace(/'/g, "''")}'`;
    }
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quote a JSON document for a `-d` argument. POSIX: plain shQuote of the
 *  JSON.stringify() text. PowerShell dialect: every literal whitespace code
 *  point left in the JSON text (a space inside a string value; JSON.stringify
 *  already escapes \n \t \r) is rewritten as its equivalent JSON `\uXXXX`
 *  escape -- byte-different, semantically identical JSON -- so the argument
 *  carries NO whitespace and the 5.1 binder-vs-CRT disagreement described on
 *  escapeForWindowsArgv() can never arise: the binder leaves the value bare,
 *  the CRT reads each `\"` as a literal quote, and curl.exe receives the
 *  exact JSON the caller built. Whitespace cannot appear outside a string
 *  in JSON.stringify() output, so the rewrite is always inside a string. */
function shQuoteJson(json, os, shell) {
    const text = String(json);
    if (!usesPowerShellQuoting(os, shell)) return shQuote(text, os, shell);
    const noWhitespace = text.replace(/\s/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return shQuote(noWhitespace, os, shell);
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

export { shQuote, shQuoteJson, usesPowerShellQuoting, escapeForWindowsArgv, curlBinary, assertToken };
