// rest-client.mjs -- the fleet bridge's member-dispatched REST transport.
//
// azure-devops.mjs's comment()/setBuildStatus() call `restClient({ method,
// url, secretName, body }) -> Promise<{ status, body }>`. There is no local
// `fetch` here: implementation-plan.md Part C's governing rule is that the
// bridge never holds a credential VALUE, so a REST call that needs the PAT
// cannot run in this process -- it has to be dispatched to a member, exactly
// the way beads-client.mjs's buildTrackerCommand()/dispatchTrackerCommand()
// already dispatch `bd ado pull/push`. That module is this one's template:
// same {{secret.NAME}} bare-placeholder mechanics, same getSeCommands()
// dialect selection, same callTool('execute_command', ...) dispatch shape.
//
// Nothing in this module reaches for `process.env`, `node:fs`, or
// `globalThis.fetch` -- the only side effect (dispatching the built command)
// is the injected `callTool`, so every code path here is exercisable against
// a fake with no real fleet server or curl binary required.
//
// ---------------------------------------------------------------------------
// WHY THIS IS curl, DISPATCHED, NOT A LOCAL fetch
// ---------------------------------------------------------------------------
// See beads-client.mjs's own file-level comment and
// implementation-plan.md Part C for the full mechanics; the short version:
// `{{secret.NAME}}` is resolved SERVER-SIDE by execute-command.ts's
// resolveSecretTokens(), which regex-matches the token as literal text in the
// `command` STRING this module builds -- before any further transport-level
// wrapping happens. The token must be BARE (never inside quotes we add: it
// substitutes to an ALREADY-quoted literal for the member's real shell), and
// this module must never route through se-os-commands.mjs's wrapForMember()
// (its PowerShell dialect base64-encodes the whole script at BUILD time,
// before substitution, so a placeholder inside it is never substituted at
// all and the member runs the literal text `{{secret.NAME}}` as the
// credential -- silent, and worse than a quoting error).
//
// Confirmed against packages/apra-fleet-se/fleet-sprint/vcs-providers/
// azure-devops.mjs's own REST builders (comment-on-PR / create-PR): Azure
// DevOps REST takes the PAT as HTTP Basic with an EMPTY username (`-u
// ":<pat>"`), never a bearer token.
//
// ---------------------------------------------------------------------------
// THE BODY-PASSING DECISION (see the module doc on buildRestCommand)
// ---------------------------------------------------------------------------
// The body NEVER travels as literal JSON text inside the command string, in
// EITHER dialect. The member-dispatch layer between this process and the
// member's shell applies a JSON-style unescape pass to the command text, and
// that pass HALVES a doubled backslash (`\\d` arrives as `\d`) -- measured,
// not theorised, and fatal to any JSON body carrying a regex or a Windows
// path. So the JSON is base64-encoded HERE, in JavaScript, by ONE shared step
// (encodeBodyBase64 / quoteBase64 below), and each dialect only decides how to
// get those base64 bytes back into curl on the member. Base64's alphabet holds
// no backslash, quote or whitespace, so no unescape, quoting or argv layer has
// anything to alter. See buildRestCommand's doc comment for the measurements
// and for the per-dialect decoding mechanics.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';
import { getSeCommands } from '@apralabs/apra-fleet-se/fleet-sprint/se-os-commands.mjs';
import {
  shQuote,
  curlBinary,
} from '@apralabs/apra-fleet-se/fleet-sprint/vcs-providers/shell-helpers.mjs';

/** HTTP methods this client is willing to build a curl command for. A closed
 *  enum, not free text -- `method` is caller-supplied (an adapter call site),
 *  so anything outside this set is CONFIG_INVALID, never silently passed
 *  through to curl's `-X`. */
const ALLOWED_METHODS = Object.freeze(new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']));

// Charset guard for the URL, mirroring TRACKER_REF_PATTERN's shape (contracts.mjs):
// an ALLOWLIST, not a denylist, and a leading '-' is refused even though it
// would also be rejected by the charset check below for most real URLs --
// stated explicitly because a leading '-' is what turns an argument into a
// flag if it is ever handled unquoted upstream. The URL is additionally
// wrapped in shQuote() before it is embedded (belt-and-suspenders: the
// charset guard rejects obviously-hostile input at the boundary; the
// escaping is what actually makes embedding safe against whatever the
// charset still allows, e.g. '&', ';', '$').
const REST_URL_PATTERN = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

// The credential NAME is interpolated BARE inside `{{secret.${secretName}}}`
// -- unlike the URL/body, it is never quoted or escaped, because it has to
// remain literal text for resolveSecretTokens() to match. That makes its
// charset gate the load-bearing one in this module: this pattern matches the
// fleet credential store's own naming convention (see beads-client.mjs's
// TRACKER_ENV_VAR / DEFAULT_ADO_PAT_SECRET_NAME callers) and, crucially,
// excludes '}' so a malicious name could never close the placeholder early
// or inject a second one.
// IMPORTED, NOT REDECLARED. This module used to keep its own copy of the
// charset. The copy was identical, so nothing failed -- but beads-client.mjs
// performs the same bare `{{secret.NAME}}` interpolation and shipped with NO
// gate at all, which is exactly the drift a second copy invites: two call
// sites with one shared rule and no single place that owns it. One
// definition, in contracts.mjs, guarded by pattern-drift.test.mjs.
import { SECRET_NAME_PATTERN } from './contracts.mjs';

/** Env var this module stores the resolved secret in for the duration of the
 *  member-dispatched command, so it can be referenced (not re-embedded bare)
 *  by the curl invocation's `-u` argument -- see buildRestCommand's doc
 *  comment, section "WHY AN INTERMEDIATE VARIABLE FOR -u". */
const SECRET_ENV_VAR = 'FLEET_BRIDGE_REST_SECRET';

/** The media types this module is willing to put on the wire. An ALLOWLIST,
 *  exactly like ALLOWED_METHODS above and for the same reason: `contentType`
 *  is caller-supplied, it is interpolated into a header string, and a
 *  tracker that needs a media type outside this set should have to say so
 *  here rather than smuggle arbitrary header text through. 'json-patch' is
 *  present because Azure DevOps work item CREATE accepts nothing else. */
const ALLOWED_CONTENT_TYPES = Object.freeze(new Set([
  'application/json',
  'application/json-patch+json',
]));

const DEFAULT_CONTENT_TYPE = 'application/json';

/** PowerShell variable the body temp-file PATH is held in for the duration of
 *  the dispatched command. Named, not `$p`: this one-liner is pasted into a
 *  member's live shell session, so a short name could collide with something
 *  the member's own profile defined. */
const PS_BODY_PATH_VAR = 'FleetBridgeRestBody';

/**
 * The ONE place a request body is turned into transport-safe text. BOTH
 * dialects call this; neither re-derives it.
 *
 * This is deliberately a single shared step rather than a line in each
 * branch. The rule it encodes ("the body must not reach the member as
 * literal JSON") is identical for POSIX and PowerShell, and a rule with two
 * copies is the most repeated defect in this package -- the `secretName`
 * charset gate shipped with a copy here and NOTHING in beads-client.mjs,
 * which was a command-injection hole. If the encoding ever needs to change,
 * it changes once and both dialects move together or neither does.
 *
 * @param {string} jsonBody @returns {string} base64 of the UTF-8 bytes
 */
function encodeBodyBase64(jsonBody) {
  return Buffer.from(jsonBody, 'utf8').toString('base64');
}

/**
 * Quote a base64 blob for embedding in either dialect's command text.
 *
 * Dialect-INDEPENDENT on purpose, and that is not laziness: base64's
 * alphabet is [A-Za-z0-9+/=] only -- no quote, no backslash, no whitespace,
 * nothing PowerShell's single-quoted-string rules or the Windows CRT argv
 * parser treat specially -- so a plain pair of single quotes is exactly
 * correct for POSIX sh, for PowerShell, and for the legacy native-command
 * binder alike. That immunity is the whole reason base64 was chosen over
 * cleverer escaping, so spending shQuote()/shQuoteJson()'s dialect machinery
 * on it would only obscure it.
 * @param {string} b64 @returns {string}
 */
function quoteBase64(b64) {
  return `'${b64}'`;
}

/** @param {string|undefined} contentType @returns {string} */
function resolveContentType(contentType) {
  if (contentType === undefined || contentType === null || contentType === '') return DEFAULT_CONTENT_TYPE;
  if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `buildRestCommand: unsupported contentType ${JSON.stringify(contentType)} (expected one of ${[...ALLOWED_CONTENT_TYPES].join(', ')})`,
      { contentType }
    );
  }
  return contentType;
}

/**
 * Builds the exact member-dispatched curl command string for one REST call,
 * WITHOUT performing any I/O itself -- pure string construction, so it is
 * testable with no `callTool` at all. Mirrors beads-client.mjs's
 * buildTrackerCommand() in every load-bearing respect.
 *
 * ---------------------------------------------------------------------------
 * WHY AN INTERMEDIATE VARIABLE FOR -u, NOT A BARE `-u :{{secret.NAME}}`
 * ---------------------------------------------------------------------------
 * Azure DevOps REST wants `-u ":<pat>"` -- an empty username, a literal
 * colon, then the PAT, as ONE curl argument. Gluing the bare placeholder
 * directly onto that colon (`-u :{{secret.NAME}}`) would rely on the
 * member's shell concatenating an unquoted `:` with the placeholder's
 * post-substitution quoted literal into a single argv word purely by
 * adjacency. That concatenation is well-defined POSIX behaviour, but this
 * package targets PowerShell members too, and PowerShell's native-command
 * argument binder (see vcs-providers/shell-helpers.mjs's escapeForWindowsArgv
 * doc comment for the measured specifics of that binder) is exactly the kind
 * of place an unverified adjacency assumption goes to die silently.
 *
 * So this module never glues anything onto the bare token. It assigns the
 * secret to an intermediate environment variable in its OWN statement first
 * (the same "assign, then use" shape buildTrackerCommand already uses for
 * PowerShell's `$env:VAR = {{secret.NAME}};`), then references that variable
 * from a SEPARATE statement via ordinary shell/PowerShell variable
 * interpolation (`"$FLEET_BRIDGE_REST_SECRET"` / `"$env:FLEET_BRIDGE_REST_SECRET"`)
 * inside a double-quoted `-u` argument. Two consequences:
 *   - The placeholder itself is still bare (assigned, not quoted by us) --
 *     rule 1 is intact.
 *   - The "must not go through wrapForMember" rule is intact too: this
 *     builds a plain one-liner, dialect chosen only via getSeCommands().
 * The one residual risk this does NOT eliminate: if a PAT's own bytes ever
 * contained a literal double quote (not a realistic shape for an Azure
 * DevOps PAT, which is base64/hex-like), the Windows legacy argv binder
 * could still mis-split that single argument -- the same irreducible class
 * of risk vcs-providers/shell-helpers.mjs documents for values it cannot
 * pre-escape because it never sees them. Recorded here rather than silently
 * assumed away.
 *
 * Note also that a single-line POSIX prefix form (`VAR=value cmd args...`)
 * would NOT work for this: word expansions in `args` on that same command
 * line are resolved by the shell using the environment BEFORE the prefix
 * assignment takes effect for the child, so `"$VAR"` in the same line reads
 * the OLD value, not the one just assigned. That is why both dialects here
 * use two statements joined by `;` -- POSIX included, even though POSIX's
 * prefix form is available and IS still what beads-client.mjs's simpler
 * "just export it into bd's environment" case correctly uses (bd never needs
 * the value back on the same command line).
 *
 * ---------------------------------------------------------------------------
 * WHY THE BODY TRAVELS AS BASE64 IN BOTH DIALECTS, NEVER AS JSON COMMAND TEXT
 * ---------------------------------------------------------------------------
 * A JSON body reaches the member as text inside the `command` STRING, and
 * the dispatch layer between here and the member's shell applies one
 * JSON-style UNESCAPE pass to that string before the shell ever sees it.
 * Measured live against a real member (windows/gitbash), with the argument
 * inside POSIX single quotes, where the shell itself changes nothing:
 *
 *   sent \d   -> arrived \d      (an unknown escape is left alone)
 *   sent \\d  -> arrived \d      (a doubled backslash is HALVED)
 *
 * That halving is silent and it is fatal: a carry-over bead whose
 * description contains a regex (`/^\\d+$/` in JSON) arrives as `\d`, which
 * is not a legal JSON escape, and Azure DevOps answers 400 "You must pass a
 * valid patch document" -- verified live on one of the four real carry-over
 * beads while everything else in the same batch published fine. No amount
 * of shell quoting fixes it, because the corruption happens BEFORE the
 * shell, and it cannot be pre-compensated either: `\` and `\\` both arrive
 * as `\`, so the transform is not injective and has no inverse.
 *
 * So the POSIX/gitbash dialect stops putting the JSON in the command text
 * at all. The body is base64-encoded HERE, in JavaScript -- base64's
 * alphabet contains no backslash, no quote and no whitespace, so there is
 * nothing for any unescape, quoting or argv layer to alter -- and decoded
 * on the member straight into curl's stdin (`--data-binary @-`). What curl
 * sends is then byte-for-byte what JSON.stringify produced.
 *
 * THE POWERSHELL BRANCH USED TO BE THE GAP, AND THE GAP WAS A LIVE DEFECT.
 * It was left on the old shQuoteJson argv path and recorded as "unproven".
 * It is now PROVEN broken. With a real member switched to powershell5, the
 * old form -- `--data-binary '{"text":"... regex /^\\d+$/ ..."}'` as a
 * quoted argument -- was dispatched against Azure DevOps and answered:
 *
 *   HTTP=400  TF400898 ... "typeName":"Newtonsoft.Json.JsonReaderException"
 *
 * while the identical body over the gitbash base64 path answered 200. The
 * corruption is the SAME dispatch-layer halving described above; the
 * binder/CRT escaping shQuoteJson performs happens strictly later and
 * cannot undo it. Since carry-over bead descriptions routinely carry
 * regexes and Windows paths, every such publish to a PowerShell member was
 * failing. CLAUDE.md's rule -- a POSIX-only feature hard-fails or is gated,
 * an advisory warning is a false success -- left two acceptable outcomes:
 * make PowerShell work, or refuse on PowerShell. This makes it work.
 *
 * ---------------------------------------------------------------------------
 * HOW POWERSHELL DECODES IT: A TEMP FILE, NOT A PIPELINE
 * ---------------------------------------------------------------------------
 * The POSIX line does not translate. `... | curl.exe --data-binary @-` in
 * PowerShell does not move bytes: a PowerShell pipeline carries OBJECTS,
 * and handing one to a native process serialises it back to TEXT through
 * the console output encoding -- which on Windows PowerShell 5.1 is a
 * legacy code page, not UTF-8 -- so any non-ASCII byte of a body can be
 * re-encoded or replaced on its way into curl's stdin. That is a silent
 * mutation of exactly the kind this whole section exists to eliminate, so
 * the pipeline is rejected outright rather than measured and hoped over.
 *
 * Instead the decoded bytes are written straight to disk by the .NET API,
 * bypassing every PowerShell text layer:
 *
 *   $VAR = Join-Path ([IO.Path]::GetTempPath()) ('fleet-bridge-body-' +
 *          [guid]::NewGuid().ToString('N') + '.json');
 *   [IO.File]::WriteAllBytes($VAR, [Convert]::FromBase64String('<b64>'));
 *   try { curl.exe ... --data-binary ('@' + $VAR) ... } finally { <delete> }
 *
 * WriteAllBytes writes the exact byte array FromBase64String produced -- no
 * encoding, no BOM, no newline translation (which is also why this is NOT
 * Set-Content / Out-File: both of those apply an encoding AND append a
 * trailing newline, silently changing the body length).
 *
 * Temp-file lifecycle, decided deliberately:
 *   - WHERE: [IO.Path]::GetTempPath(), the per-user temp directory. Not the
 *     member's work folder -- a stray file there can be picked up by a git
 *     status/add in a sprint. Resolved by .NET on the member, never by
 *     string-building a path here.
 *   - NAME: a fresh GUID per dispatch. Two concurrent dispatches to the same
 *     member (the fleet does run them) must not be able to collide, and a
 *     predictable name would also let a local process pre-create or swap the
 *     file. A PID or a timestamp gives neither property.
 *   - DELETION: in a `finally`, so it is removed when curl returns non-zero
 *     (a 400/timeout leaves the file behind otherwise) and when the command
 *     is interrupted mid-statement. A body can contain issue text, so a
 *     leftover file is a disclosure risk, not just litter. `-Force` so a
 *     read-only file still goes, `-ErrorAction SilentlyContinue` so cleanup
 *     can never convert a successful REST call into a failed command, and
 *     `-LiteralPath` so a path is never reinterpreted as a wildcard.
 *
 * The curl argument is built as `('@' + $VAR)` -- a PowerShell string
 * CONCATENATION, not `"@$VAR"` interpolation -- so the path value is passed
 * through as data and nothing inside it is ever expanded.
 *
 * Both dialects share encodeBodyBase64()/quoteBase64(); only the decode step
 * differs. Verified live end to end: the same body containing both
 * `/^\\d+$/` and `C:\\Users\\x` returns 200 on a powershell5 member and on a
 * gitbash member, and reading the created comment back shows the
 * backslashes byte-intact in both cases.
 *
 * ---------------------------------------------------------------------------
 * WHY contentType IS A PARAMETER, NOT A CONSTANT
 * ---------------------------------------------------------------------------
 * It used to be hardcoded to 'application/json'. That is right for a work
 * item COMMENT, and wrong for a work item CREATE: Azure DevOps's
 * POST _apis/wit/workitems/$<type> takes a JSON Patch document and REFUSES
 * any other media type, so the one media type this module knew was not
 * enough to reach the create endpoint at all. It stays a caller-supplied
 * value (defaulting to the old constant, so every existing call site is
 * byte-for-byte unchanged) rather than a second boolean flag, because the
 * media type is the REST call's own property, not a mode of this transport.
 *
 * @param {{ method: string, url: string, secretName: string, body?: any, contentType?: string, targetOs?: string|null, shell?: string|null }} opts
 * @returns {string}
 */
export function buildRestCommand({ method, url, secretName, body, contentType, targetOs, shell } = {}) {
  if (!method || typeof method !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'buildRestCommand: method is required',
      {}
    );
  }
  const normalizedMethod = method.toUpperCase();
  if (!ALLOWED_METHODS.has(normalizedMethod)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `buildRestCommand: unsupported method ${JSON.stringify(method)} (expected one of ${[...ALLOWED_METHODS].join(', ')})`,
      { method }
    );
  }

  if (!url || typeof url !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'buildRestCommand: url is required',
      {}
    );
  }
  if (url.startsWith('-')) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `buildRestCommand: url may not begin with a dash (would be parsed as a flag): ${JSON.stringify(url)}`,
      { url }
    );
  }
  if (!REST_URL_PATTERN.test(url)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `buildRestCommand: url contains characters outside the allowed charset or is not http(s): ${JSON.stringify(url)}`,
      { url }
    );
  }

  if (!secretName || typeof secretName !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'buildRestCommand: secretName is required (the stored credential NAME, never a value)',
      {}
    );
  }
  if (secretName.startsWith('-')) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `buildRestCommand: secretName may not begin with a dash: ${JSON.stringify(secretName)}`,
      { secretName }
    );
  }
  if (!SECRET_NAME_PATTERN.test(secretName)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `buildRestCommand: secretName contains characters outside the allowed charset: ${JSON.stringify(secretName)}`,
      { secretName }
    );
  }

  let jsonBody = null;
  if (body !== undefined && body !== null) {
    try {
      jsonBody = JSON.stringify(body);
    } catch (err) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `buildRestCommand: body is not JSON-serializable: ${err && err.message ? err.message : String(err)}`,
        {}
      );
    }
    if (jsonBody === undefined) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'buildRestCommand: body serialized to undefined (functions/symbols are not valid REST bodies)',
        {}
      );
    }
  }

  // Three shell identifiers, not two -- 'gitbash' groups with 'posix' (a
  // Windows member running Git-for-Windows bash takes bash command text just
  // like a POSIX member; only a Windows member with NO gitbash shell
  // recorded is actually PowerShell). Exactly beads-client.mjs's rule.
  const dialect = getSeCommands({ os: targetOs, shell }).shell;
  const isPosix = dialect === 'posix' || dialect === 'gitbash';

  const token = `{{secret.${secretName}}}`;
  const assign = isPosix ? `${SECRET_ENV_VAR}=${token}` : `$env:${SECRET_ENV_VAR} = ${token}`;
  const authArg = isPosix ? `":$${SECRET_ENV_VAR}"` : `":$env:${SECRET_ENV_VAR}"`;

  const parts = [curlBinary(targetOs), '-sS', '-X', normalizedMethod, '-u', authArg];
  // Text placed BEFORE the curl invocation (the POSIX decode pipeline, or
  // the PowerShell temp-file write plus its `try {`) and AFTER it (the
  // PowerShell `} finally { <delete> }`). Both stay empty for a bodyless
  // request, so a GET is byte-identical to a plain one-line curl.
  let bodyPrefix = '';
  let bodySuffix = '';
  if (jsonBody !== null) {
    parts.push('-H', shQuote(`Content-Type: ${resolveContentType(contentType)}`, targetOs, shell));
    // ONE encoding step for both dialects -- see "WHY THE BODY TRAVELS AS
    // BASE64 IN BOTH DIALECTS" above. Only the decode differs below.
    const bodyB64 = quoteBase64(encodeBodyBase64(jsonBody));
    if (isPosix) {
      bodyPrefix = `printf %s ${bodyB64} | base64 -d | `;
      parts.push('--data-binary', '@-');
    } else {
      // A temp file, not a pipeline: a PowerShell pipeline re-encodes bytes
      // on their way into a native process's stdin. See "HOW POWERSHELL
      // DECODES IT: A TEMP FILE, NOT A PIPELINE" above for the full
      // reasoning and the temp-file lifecycle decisions (GUID name,
      // per-user temp dir, delete in `finally`).
      const pathVar = `$${PS_BODY_PATH_VAR}`;
      bodyPrefix =
        `${pathVar} = Join-Path ([IO.Path]::GetTempPath()) ` +
        `('fleet-bridge-body-' + [guid]::NewGuid().ToString('N') + '.json'); ` +
        `[IO.File]::WriteAllBytes(${pathVar}, [Convert]::FromBase64String(${bodyB64})); ` +
        'try { ';
      bodySuffix = ` } finally { Remove-Item -LiteralPath ${pathVar} -Force -ErrorAction SilentlyContinue }`;
      parts.push('--data-binary', `('@' + ${pathVar})`);
    }
  }
  parts.push(shQuote(url, targetOs, shell));
  // A trailing '\n%{http_code}' write-out (curl's OWN '\n' escape in its -w
  // format string, hence the literal two-character '\\n' in this JS source
  // rather than an actual newline byte), split off on the LAST newline by
  // parseRestOutput() below -- the same "bare trailing REST status line"
  // shape implementation-plan.md Part B already documents this fleet using
  // for its own curl+`-w` REST calls.
  parts.push('-w', shQuote('\\n%{http_code}', targetOs, shell));

  const curlCommand = `${bodyPrefix}${parts.join(' ')}${bodySuffix}`;
  return `${assign}; ${curlCommand}`;
}

/**
 * Best-effort extraction of the raw stdout text from whatever `callTool`
 * resolved to. execute-command.ts's real MCP tool response carries
 * `structuredContent: { exitCode, stdout, stderr }` alongside a human-facing
 * `text` (`Exit code: N\n<output>`); this module prefers the structured
 * field but degrades gracefully for a fake/lighter-weight `callTool` that
 * just resolves `{ stdout }` or a bare string, since the exact shape
 * `callTool` resolves to is this module's one injected, un-pinned
 * dependency.
 * @param {any} result
 * @returns {string}
 */
function extractStdout(result) {
  if (result && result.structuredContent && typeof result.structuredContent.stdout === 'string') {
    return result.structuredContent.stdout;
  }
  if (result && typeof result.stdout === 'string') {
    return result.stdout;
  }
  if (result && typeof result.text === 'string') {
    return result.text.replace(/^Exit code: -?\d+\n/, '');
  }
  if (typeof result === 'string') return result;
  return '';
}

/**
 * Parses the member's stdout into `{ status, body }`. The trailing
 * '\n%{http_code}' write-out appended by buildRestCommand() means the LAST
 * newline-delimited line is the status code and everything before it is the
 * response body -- split on the last newline (not the first) so a response
 * body containing its own newlines is never mis-split.
 *
 * A non-2xx status is DATA, not a throw (facade.comment() already treats a
 * REST failure as non-fatal -- see facade.mjs's "COMMENT NEVER THROWS" -- and
 * throwing here would make a failed comment roll back a successful
 * carry-over). Symmetrically, output this module cannot make sense of (no
 * trailing numeric status line -- e.g. a dispatch that never reached curl at
 * all) is likewise returned as best-effort data with `status: null` rather
 * than thrown, for the same reason: this function's job is to describe the
 * REST outcome, never to decide whether that outcome should abort the
 * caller's own workflow.
 * @param {any} result
 * @returns {{ status: number|null, body: string }}
 */
function parseRestOutput(result) {
  const stdout = extractStdout(result).replace(/\r\n/g, '\n');
  const idx = stdout.lastIndexOf('\n');
  if (idx === -1) {
    const trimmed = stdout.trim();
    return /^\d+$/.test(trimmed) ? { status: Number.parseInt(trimmed, 10), body: '' } : { status: null, body: stdout };
  }
  const bodyPart = stdout.slice(0, idx);
  const statusPart = stdout.slice(idx + 1).trim();
  if (/^\d+$/.test(statusPart)) {
    return { status: Number.parseInt(statusPart, 10), body: bodyPart };
  }
  return { status: null, body: stdout };
}

/**
 * Creates the REST client azure-devops.mjs's `comment()`/`setBuildStatus()`
 * are handed as `deps.restClient`: `restClient({ method, url, secretName,
 * body }) -> Promise<{ status, body }>`, dispatched to `memberName` via the
 * injected `callTool('execute_command', ...)`.
 *
 * @param {{
 *   callTool: (name: string, args: object) => Promise<any>,
 *   memberName: string,
 *   targetOs?: string|null, shell?: string|null,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {(req: { method: string, url: string, secretName: string, body?: any, contentType?: string }) => Promise<{ status: number|null, body: string }>}
 */
export function createRestClient({ callTool, memberName, targetOs = null, shell = null, log = () => {} } = {}) {
  if (typeof callTool !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createRestClient({ callTool }): callTool must be a function',
      { param: 'callTool', expectedType: 'function', actualType: typeof callTool }
    );
  }
  if (!memberName || typeof memberName !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createRestClient({ memberName }): memberName is required',
      { param: 'memberName' }
    );
  }

  return async function restClient({ method, url, secretName, body, contentType } = {}) {
    const command = buildRestCommand({ method, url, secretName, body, contentType, targetOs, shell });
    log(`[rest-client] dispatching ${typeof method === 'string' ? method.toUpperCase() : method} to member '${memberName}'`);
    const result = await callTool('execute_command', { member_name: memberName, command });
    return parseRestOutput(result);
  };
}

export default createRestClient;
