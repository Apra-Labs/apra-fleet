/**
 * Shared shell-quoting and token-assertion helpers for VCS provider command
 * builders. Used by GitHub, and available for use by other providers
 * (Azure DevOps, etc.) to ensure consistent shell-escaping rules across
 * all providers.
 *
 * ASCII only.
 */

/** Single-quote a string for embedding in a shell command. The built curl
 *  command is dispatched through the member's own shell -- POSIX sh/bash
 *  closes/reopens the quote around an embedded single quote ('\''), but
 *  Windows PowerShell (the shell every Windows member's commands actually
 *  run through -- see wrapPowerShellEncoded()/isWindows in
 *  src/tools/remove-member.ts) escapes an embedded single quote inside a
 *  single-quoted string by DOUBLING it (''), not by backslash-closing. Using
 *  the POSIX form on a Windows member breaks the quoting outright (observed
 *  live: Publish PR crashing on any title/body containing an apostrophe).
 *  `os` is one of resolveMemberOs()'s return values ('windows'/'linux'/
 *  'darwin'); anything other than 'windows' keeps the POSIX behavior
 *  byte-identical to before this branch existed. */
function shQuote(value, os) {
    if (os === 'windows') {
        return `'${String(value).replace(/'/g, "''")}'`;
    }
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}


function assertToken(token) {
    const value = String(token ?? '');
    if (!value) {
        throw new Error('ERROR: VCSModule: no token supplied -- caller must mint one via provision_vcs_auth before calling VCSModule.');
    }
    return value;
}

export { shQuote, assertToken };
