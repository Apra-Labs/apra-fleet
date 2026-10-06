// beads-client.mjs -- the fleet bridge's typed wrapper over `bd`.
//
// This module encodes THE hard split (implementation-plan.md Part C) between
// two classes of `bd` invocation:
//
//   1. LOCAL, credential-free: reads/writes against the local beads DB only
//      (`bd list --json`, `bd show`, `bd create`, `bd update`, a `bd dolt
//      pull` health probe). These run in-process on the runner via
//      exec-bd.mjs's execBdSync/execBdAsync -- INJECTED here, never imported,
//      so this module never touches a real child process itself.
//   2. TRACKER-TOUCHING, credential-needing: `bd ado pull/push`, `bd github
//      pull/push`. These need a tracker PAT the bridge must never hold, so
//      they are dispatched to a member via the injected `callTool` (the
//      fleet server's `execute_command` MCP tool), with the PAT injected
//      server-side as `{{secret.<name>}}` -- see buildTrackerCommand()'s doc
//      comment for the full mechanics and the load-bearing "bare, never
//      quoted" gotcha.
//
// Nothing in this module reaches for `process.env`, `node:fs`, or
// `globalThis.fetch` -- every side effect (bd exec, member dispatch,
// logging) is an injected function, so every code path here is exercisable
// against fakes with no real `bd` binary or fleet server required.
//
// ---------------------------------------------------------------------------
// THE SYNC/ASYNC ROUTING RULE (implementation-plan.md hard requirement 1)
// ---------------------------------------------------------------------------
//
// exec-bd.mjs's execBdAsync validates every arg against
// `/^[A-Za-z0-9_.\-]+$/` (SAFE_ARG_PATTERN in that file) and THROWS on the
// first violation -- it exists specifically so a caller-controlled value with
// a shell metacharacter can never reach that module's `{ shell: true }`
// fallback path. That means execBdAsync is unusable for ANY `bd` invocation
// that carries free text: a title, a description, a note body, or -- easy to
// miss -- an ISO-8601 timestamp (`--created-after`), which contains `:` and
// therefore also fails the async charset check.
//
// Rather than push this choice onto every call site (which is exactly the
// bug class this module exists to prevent), `hasFreeTextArg()` below inspects
// the actual argv about to be sent and decides, ONCE, per call: any arg
// outside the safe charset routes the WHOLE invocation through execBdSync
// (which accepts free text unconditionally); an argv built entirely from
// subcommands/flags/ids routes through execBdAsync. See `runBd()`.
// ---------------------------------------------------------------------------

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';
import { assertValidTrackerRef, assertValidSecretName } from './contracts.mjs';
import { BD_MAX_BUFFER_BYTES } from '@apralabs/apra-fleet-se/src/supervisor/lib/exec-bd.mjs';
import { getSeCommands } from '@apralabs/apra-fleet-se/fleet-sprint/se-os-commands.mjs';

// Mirrors exec-bd.mjs's own (unexported) SAFE_ARG_PATTERN exactly. Kept as an
// independent copy rather than importing a private symbol: this predicate has
// to answer "would execBdAsync accept this argv" BEFORE calling it, and the
// two must never silently drift apart -- if this pattern is ever loosened
// without a matching change upstream, execBdAsync would just throw and the
// routing decision below would be a moot double-check, not a silent bypass.
const BD_SAFE_ARG_PATTERN = /^[A-Za-z0-9_.\-]+$/;

/**
 * True iff any element of `args` would be rejected by execBdAsync's own
 * charset validation -- i.e. this argv carries free text and MUST go through
 * execBdSync instead.
 * @param {string[]} args
 * @returns {boolean}
 */
function hasFreeTextArg(args) {
  return args.some((a) => typeof a !== 'string' || !BD_SAFE_ARG_PATTERN.test(a));
}

/**
 * One JSON-parsing helper for every `bd ... --json` call, mirroring
 * fleet-sprint/beads-scope.mjs's parseBdJson pattern (labelled error, raw
 * output snippet) but raising the bridge's own typed error instead of a bare
 * Error, so every caller of this module sees one error shape.
 *
 * Empty stdout parses as `[]`, not an error -- `bd` legitimately prints
 * nothing for an empty result set on some subcommands.
 * @param {string} raw
 * @param {string} commandLabel
 * @returns {any}
 */
function parseBdOutput(raw, commandLabel) {
  const text = raw === undefined || raw === null || raw === '' ? '[]' : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    const snippet = text.length > 500 ? `${text.slice(0, 500)}... (truncated, ${text.length} chars total)` : text;
    throw new BridgeError(
      BRIDGE_ERROR_CODES.BEADS_FAILED,
      `[beads-client] failed to parse JSON output from '${commandLabel}': ${err.message}. Raw output snippet: ${JSON.stringify(snippet)}`,
      { commandLabel, rawSnippet: snippet }
    );
  }
}

/**
 * Builds the one `runBd(args, label)` seam every local method below calls
 * through, closing over the injected exec functions/logger so the
 * sync/async decision lives in exactly one place.
 * @param {{ execBdSyncFn: Function, execBdAsyncFn: Function, log: Function, cwd?: string }} deps
 */
function createRunBd({ execBdSyncFn, execBdAsyncFn, log, cwd }) {
  return async function runBd(args, label) {
    const useSync = hasFreeTextArg(args);
    // WHY `cwd` MATTERS HERE (createBeadsClient's own doc comment has the
    // full validation story): every LOCAL bd invocation below runs wherever
    // `execBdSyncFn`/`execBdAsyncFn` happen to spawn their child process --
    // Node's default, absent an explicit `cwd` option, is the BRIDGE
    // PROCESS's own current working directory, not the repo whose beads DB
    // this call is actually supposed to touch. Those are routinely different
    // directories: the bridge is launched from a pipeline workspace (or
    // wherever an operator happens to be), while the beads DB lives in
    // `repo.localPath`, the repo under test. Without threading `cwd` through,
    // `bd` runs against whatever (if any) beads DB happens to sit under the
    // bridge's own launch directory -- which is exactly how `bd dolt pull`
    // (beads-health) failed with "no beads database found" even though the
    // target repo's DB was right there, just in a different directory.
    //
    // Built conditionally into each options object below, never as an
    // unconditional `{ ..., cwd }`: an explicit `cwd: undefined` key is a
    // DIFFERENT options object than one with no `cwd` key at all to a caller
    // (or a test) doing a strict/deep comparison, even though
    // execFileSync/execFile themselves treat the two identically. Omitting
    // the key entirely when `cwd` was never supplied to createBeadsClient()
    // keeps every existing call site's behavior -- and every existing test's
    // exact-options assertions -- byte-for-byte unchanged.
    try {
      if (useSync) {
        log(`[beads-client] execBdSync (free-text arg present): ${label}`);
        // BD_MAX_BUFFER_BYTES is passed explicitly on every call rather than
        // relied upon as execBdSync's own internal default: this module is
        // exercised against INJECTED fakes in tests, which have no such
        // default of their own, so a caller reading `bd list --json` on a
        // large tracker must not silently fall back to Node's 1MiB ceiling.
        const syncOptions = { maxBuffer: BD_MAX_BUFFER_BYTES };
        if (cwd !== undefined) syncOptions.cwd = cwd;
        const out = execBdSyncFn(args, syncOptions);
        const stdout = Buffer.isBuffer(out) ? out.toString('utf-8') : (out == null ? '' : String(out));
        return { stdout, stderr: '' };
      }
      log(`[beads-client] execBdAsync (safe-charset args): ${label}`);
      const asyncOptions = { maxBuffer: BD_MAX_BUFFER_BYTES };
      if (cwd !== undefined) asyncOptions.cwd = cwd;
      const res = await execBdAsyncFn(args, asyncOptions);
      const stdout = res && res.stdout != null ? String(res.stdout) : '';
      const stderr = res && res.stderr != null ? String(res.stderr) : '';
      return { stdout, stderr };
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError(
        BRIDGE_ERROR_CODES.BEADS_FAILED,
        `[beads-client] '${label}' failed: ${err && err.message ? err.message : String(err)}`,
        { args, cause: err }
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Tracker-touching command construction
// ---------------------------------------------------------------------------

/** Env var each tracker namespace's `bd` integration reads its PAT from
 *  (fleet-bridge-design.md 2.3: "GitHub mirrors this exactly"). */
const TRACKER_ENV_VAR = Object.freeze({ ado: 'AZURE_DEVOPS_PAT', github: 'GITHUB_TOKEN' });

// The tracker-ref charset/validation (TRACKER_REF_PATTERN, assertValidTrackerRef)
// lives in contracts.mjs, imported above, so this module's ref-validation loop in
// buildTrackerCommand and contracts.mjs's validateSprintRequest workItems check
// enforce exactly the same rule from one definition. Unlike execBdAsync's args
// (validated argv elements passed to execFile, never shell-interpreted), refs here
// are concatenated into a STRING that a member's real shell parses -- so they get
// this stricter gate rather than trusting the caller.

/**
 * Refuses to build a `bd ado`/`bd github` command whose verb is a bare
 * `sync`. `bd ado sync` / `bd github sync` are bidirectional by default and
 * would push the ENTIRE local beads DB into the customer's backlog -- the
 * bridge must only ever call the ID-scoped `pull` and `push` verbs.
 *
 * `args` is a `bd`-argv-shaped array with NO leading "bd" element (matching
 * exec-bd.mjs's own convention), so `args[0]` is the namespace and `args[1]`
 * is the verb, e.g. `["ado", "sync", ...]`.
 * @param {string[]} args
 */
export function assertNoBareSync(args) {
  if (!Array.isArray(args) || args.length < 2) return;
  const namespace = args[0];
  const verb = args[1];
  if (typeof namespace !== 'string' || typeof verb !== 'string') {
    // RULE (see buildTrackerCommand's call-site comment below): a malformed
    // shape reaching this guard is CALLER-supplied bad input (this function
    // is exported and validates whatever argv it is handed), never an
    // internal defect of the bridge or the `bd` binary -- CONFIG_INVALID
    // (exit 2), not BEADS_FAILED (exit 9, "recurs identically on retry",
    // which is the wrong signal for "caller passed a non-string verb").
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `assertNoBareSync: invalid argv shape -- expected array of strings with at least [namespace, verb]`,
      { argsLength: args.length, namespaceType: typeof namespace, verbType: typeof verb }
    );
  }
  if ((namespace === 'ado' || namespace === 'github') && verb === 'sync') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.BEADS_BARE_SYNC_REFUSED,
      `Refusing bare 'bd ${namespace} sync' -- it is bidirectional by default and would push the entire local beads DB into the tracker's backlog. Use the ID-scoped 'pull'/'push' verbs instead.`,
      { namespace, verb }
    );
  }
}

/**
 * Builds the exact member-dispatched command string for a tracker-touching
 * `bd ado`/`bd github` pull or push, WITHOUT performing any I/O itself --
 * pure string construction, so it is testable with no `callTool`/exec at all.
 *
 * ---------------------------------------------------------------------------
 * THE {{secret.NAME}} GOTCHA (implementation-plan.md Part C)
 * ---------------------------------------------------------------------------
 * `{{secret.NAME}}` is resolved SERVER-SIDE, in `execute-command.ts`'s
 * `resolveSecretTokens()`, which regex-matches the token as literal text
 * directly against the `command` string this function returns -- BEFORE any
 * further transport-level wrapping happens. Two consequences shape every
 * line below:
 *
 *   1. The token must be placed BARE (unquoted). `resolveSecretTokens`
 *      replaces it with an ALREADY-ESCAPED-AND-QUOTED literal for the
 *      member's real shell (`escapeShellArg` -> `'value'` for POSIX,
 *      `escapePowerShellArg` -> `'value'` for PowerShell, both wrapping in
 *      their own single quotes). Wrapping the token in a second pair of
 *      quotes here would double-quote the result and silently mangle the
 *      value -- no error, just a broken credential.
 *
 *   2. This function must NEVER route its output through
 *      se-os-commands.mjs's `wrapForMember()` for the Windows/PowerShell
 *      dialect. That helper base64-encodes the ENTIRE script into an opaque
 *      `-EncodedCommand` blob at BUILD time -- i.e. before the token is ever
 *      substituted. `resolveSecretTokens` only ever sees the literal
 *      `command` string it's handed; a token buried inside a base64 blob
 *      would never match its regex, so the member would decode and run a
 *      script with the RAW, unresolved `{{secret.NAME}}` text baked in --
 *      arguably worse than the mangled-quoting failure mode, because it is
 *      not even a value substitution error, it is silently no substitution
 *      at all. This is why the code below builds a plain, unencoded
 *      one-liner for both dialects instead of delegating to `wrapForMember`.
 *
 * RECONCILING "BARE" WITH POWERSHELL ASSIGNMENT: POSIX has an inline
 * `VAR=value cmd` prefix form, so the POSIX branch is a single statement.
 * PowerShell has no equivalent syntax, so the PowerShell branch is two
 * statements joined by `;` (`$env:VAR = <token>; bd ...`). This still works
 * with the token left bare precisely because of point 1 above: after
 * substitution, `$env:VAR = {{secret.NAME}}` becomes `$env:VAR = 'the-real-
 * value'` -- a syntactically valid PowerShell assignment -- without this
 * function adding any quoting of its own. The dialect (POSIX vs PowerShell)
 * is resolved via `getSeCommands({ os, shell }).shell`, the same member
 * os/shell resolution fleet-sprint's own command builders use, so a
 * Windows member whose registered shell is `gitbash` correctly gets the
 * POSIX form.
 *
 * @param {{ namespace: 'ado'|'github', verb: 'pull'|'push', refs?: string[], secretName: string, dryRun?: boolean, targetOs?: string|null, shell?: string|null }} opts
 * @returns {string}
 */
export function buildTrackerCommand({ namespace, verb, refs, secretName, dryRun, targetOs, shell } = {}) {
  if (namespace !== 'ado' && namespace !== 'github') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_UNKNOWN,
      `buildTrackerCommand: unknown tracker namespace '${namespace}' (expected 'ado' or 'github')`,
      { namespace }
    );
  }
  assertNoBareSync([namespace, verb]);
  if (verb !== 'pull' && verb !== 'push') {
    // RULE: `verb` is a parameter to this exported function -- CALLER input,
    // not a bd-process failure -- so an invalid value is CONFIG_INVALID
    // (exit 2), never BEADS_FAILED (exit 9). (A bare sync verb is refused
    // above with its own dedicated BEADS_BARE_SYNC_REFUSED; this branch
    // covers everything else that is neither pull nor push nor that verb.)
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `buildTrackerCommand: verb must be 'pull' or 'push', got ${JSON.stringify(verb)}`,
      { namespace, verb }
    );
  }
  if (secretName === undefined || secretName === null || secretName === '') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      `buildTrackerCommand: secretName is required (the stored credential NAME, never a value)`,
      { namespace, verb }
    );
  }
  // CHARSET-GATE THE NAME, NOT JUST ITS PRESENCE.
  //
  // `secretName` is interpolated BARE into `{{secret.${secretName}}}` below,
  // and the result is a shell command string dispatched to a member. A
  // truthiness check is therefore not enough: a name containing '}' closes
  // the placeholder early, and everything after it is shell text the member
  // executes. `x}} ; <command> ; echo {{secret.y` yields three statements,
  // the middle one attacker-chosen -- and this value arrives from outside,
  // via `--secret-name`, FLEET_BRIDGE_SECRET_NAME, the repo config file, or
  // the pipeline's own `adoPatSecretName` parameter, so anyone who can queue
  // the pipeline could run commands on the member host.
  //
  // assertValidSecretName is an allowlist (alphanumerics plus '_.-') that
  // already excludes '}' and a leading dash. It existed for exactly this
  // call site from the start and was simply never invoked here, while
  // rest-client.mjs -- the sibling doing the same interpolation -- did gate
  // its own. One validator, both call sites, no second copy to drift.
  assertValidSecretName(secretName, 'secretName');

  // RULE: input validation failures are CONFIG_INVALID; failures of the bd
  // process itself are BEADS_FAILED. These refs originate from the
  // pipeline's externally-supplied `workItems` parameter, so a malformed one
  // (non-string, leading dash, bad charset) is CALLER-provided bad input --
  // exit 2 (CONFIG_INVALID) -- never an internal/tooling defect -- exit 9
  // (BEADS_FAILED). A pipeline branching on exit code must be able to tell
  // "operator mistyped a work-item id" from "the bd binary crashed"; only
  // genuine bd-invocation failures (a crash, non-zero exit, unparseable
  // output -- see runBd()/parseBdOutput() above) belong on BEADS_FAILED.
  const refList = Array.isArray(refs) ? refs : [];
  for (const ref of refList) {
    assertValidTrackerRef(ref, 'ref/flag in a member-dispatched command');
  }

  const bdCommandParts = ['bd', namespace, verb, ...refList];
  if (dryRun) bdCommandParts.push('--dry-run');
  const bdCommand = bdCommandParts.join(' ');
  const envVar = TRACKER_ENV_VAR[namespace];
  const token = `{{secret.${secretName}}}`;

  // getSeCommands(...).shell answers one of three values: 'posix',
  // 'powershell', or 'gitbash' (a Windows member running Git-for-Windows
  // bash). 'gitbash' takes bash command text just like 'posix' -- only a
  // Windows member with NO gitbash shell recorded is actually PowerShell --
  // so both group into the POSIX branch below.
  const dialect = getSeCommands({ os: targetOs, shell }).shell;
  const isPosix = dialect === 'posix' || dialect === 'gitbash';

  if (isPosix) {
    return `${envVar}=${token} ${bdCommand}`;
  }
  return `$env:${envVar} = ${token}; ${bdCommand}`;
}

/**
 * The beads client: local, credential-free `bd` reads/writes routed through
 * the injected exec-bd functions, and tracker-touching `bd ado`/`bd github`
 * pull/push dispatched to a member via the injected `callTool`.
 *
 * @param {{
 *   execBdSync: Function, execBdAsync: Function,
 *   callTool?: ((name: string, args: object) => Promise<any>)|null,
 *   memberName?: string|null,
 *   targetOs?: string|null, shell?: string|null,
 *   cwd?: string,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function createBeadsClient({
  execBdSync,
  execBdAsync,
  callTool = null,
  memberName = null,
  targetOs = null,
  shell = null,
  cwd = undefined,
  log = () => {},
} = {}) {
  if (typeof execBdSync !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createBeadsClient({ execBdSync }): execBdSync must be a function',
      { param: 'execBdSync', expectedType: 'function', actualType: typeof execBdSync }
    );
  }
  if (typeof execBdAsync !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createBeadsClient({ execBdAsync }): execBdAsync must be a function',
      { param: 'execBdAsync', expectedType: 'function', actualType: typeof execBdAsync }
    );
  }
  // `cwd` -- OPTIONAL, unlike execBdSync/execBdAsync above -- is the working
  // directory every LOCAL bd invocation (list/show/create/update/setParent/
  // doltPullProbe, via runBd() below) runs in. WHY it exists at all: the
  // beads DB belongs to the repo under test (`repo.localPath`), never to
  // wherever the bridge binary happened to be launched from (a pipeline
  // workspace, an operator's arbitrary shell) -- those are routinely
  // different directories, and running `bd` in the wrong one is
  // indistinguishable from there being no beads DB at all ("no beads
  // database found"), not a clearly-wrong-directory error. Omitted, this
  // module's behavior is UNCHANGED from before this option existed (see
  // runBd's own comment on why that means never passing `cwd: undefined`
  // down to the exec functions); supplied, it must actually be a path, the
  // same "present means valid" rule this constructor already applies to
  // execBdSync/execBdAsync above.
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'createBeadsClient({ cwd }): cwd must be a non-empty string when provided',
      { param: 'cwd', expectedType: 'non-empty string', actualType: typeof cwd }
    );
  }

  const runBd = createRunBd({ execBdSyncFn: execBdSync, execBdAsyncFn: execBdAsync, log, cwd });

  /**
   * `bd list --json`, scoped by the given filters.
   * @param {{ all?: boolean, status?: string, createdAfter?: string, labels?: string|string[], limit?: number, parent?: string, type?: string }} [opts]
   * @returns {Promise<any[]>}
   */
  async function list({ all, status, createdAfter, labels, limit, parent, type } = {}) {
    const args = ['list', '--json'];
    // WHY `all` exists: `bd list` defaults to OPEN issues only -- a closed
    // bead is simply absent from an unfiltered result, which reads
    // identically to "no such bead". `--all` is bd's own documented flag for
    // "show all issues including closed (overrides default filter)"; it is
    // preferred over enumerating every status by name in `--status` because
    // that enumeration silently goes stale the day beads gains a new status.
    // Added for ingest.mjs's synthetic-root reuse lookup, which must SEE a
    // closed root in order to refuse rather than silently create a duplicate.
    // `--all` overrides bd's default filter, so an explicit `status` alongside
    // it would be contradictory: `all` wins and `status` is not sent.
    if (all) args.push('--all');
    else if (status) args.push('--status', status);
    if (parent) args.push('--parent', parent);
    // `type` (bug|feature|task|epic|chore|decision) is safe-charset, added
    // for ingest.mjs's synthetic-root reuse lookup (resolveRoot), which needs
    // to scope its scan to epics only -- never widened to a free-text filter.
    if (type) args.push('--type', type);
    const labelList = Array.isArray(labels) ? labels : (labels ? [labels] : []);
    for (const l of labelList) args.push('--label', l);
    // ISO-8601 timestamps contain ':' -- always free text, always routes
    // this whole call through execBdSync (see hasFreeTextArg above).
    if (createdAfter) args.push('--created-after', createdAfter);
    args.push('--limit', String(limit ?? 0));

    const label = `bd ${args.join(' ')}`;
    const { stdout } = await runBd(args, label);
    return parseBdOutput(stdout, label);
  }

  /**
   * `bd show <id> --json`.
   * @param {string} id
   * @returns {Promise<any>}
   */
  async function show(id) {
    const args = ['show', id, '--json'];
    const label = `bd ${args.join(' ')}`;
    const { stdout } = await runBd(args, label);
    return parseBdOutput(stdout, label);
  }

  /**
   * `bd create --title <title> ... --json`. `title` (and `description`, if
   * given) are free text, so this always routes through execBdSync.
   *
   * `metadata`, when given, is a plain JS object JSON.stringify'd onto
   * `--metadata` -- e.g. ingest.mjs's resolveRoot stamps a durable identity
   * marker on a freshly-created synthetic epic this way, so a later run can
   * find and reuse it instead of creating a duplicate. The serialized JSON
   * always contains `{`/`"`/`:` -- outside execBdAsync's safe charset -- so
   * it forces the sync route the same way a free-text title already does;
   * no separate accommodation needed in hasFreeTextArg.
   * @param {{ title: string, description?: string, issueType?: string, priority?: number, parent?: string, metadata?: object }} opts
   * @returns {Promise<any>}
   */
  async function create({ title, description, issueType, priority, parent, metadata } = {}) {
    if (!title || typeof title !== 'string') {
      // RULE: `title` is caller-supplied (ultimately a pipeline parameter via
      // ingest.mjs) -- CONFIG_INVALID (exit 2), never BEADS_FAILED (exit 9,
      // "internal defect, recurs identically on retry" -- the wrong signal
      // for a pipeline to retry, since a bad title can never succeed on retry
      // either way, but for the RIGHT reason: it's not a bug, it's bad input).
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'beadsClient.create requires a non-empty title', {});
    }
    const args = ['create', '--title', title];
    if (description) args.push('--description', description);
    if (issueType) args.push('--type', issueType);
    if (priority != null) args.push('--priority', String(priority));
    if (parent) args.push('--parent', parent);
    if (metadata !== undefined) args.push('--metadata', JSON.stringify(metadata));
    args.push('--json');

    const label = `bd ${args.join(' ')}`;
    const { stdout } = await runBd(args, label);
    return parseBdOutput(stdout, label);
  }

  /**
   * `bd update <id> ... --json`. Any free-text field (title/description/
   * notes) routes the call through execBdSync; an id-and-flags-only update
   * (e.g. just `status`) routes through execBdAsync.
   * @param {string} id
   * `externalRef` maps to `bd update --external-ref <value>`: the tracker
   * ref a bead is linked to. It exists here because carry-over publishing
   * for a tracker whose native `bd <ns> push` cannot CREATE the work item
   * (see src/adapters/azure-devops.mjs's "BEADS CANNOT CREATE HERE" note)
   * has to stamp the ref itself after creating the item over REST -- that
   * stamp is the whole basis of carry-over idempotency (design.md Section
   * 8), so without it a retried pipeline would create a duplicate work item
   * every single run. The value is a tracker URL, so it always contains ':'
   * and '/' and therefore always routes this call through execBdSync, the
   * same as any other free-text field.
   * @param {{ title?: string, description?: string, status?: string, priority?: number, issueType?: string, notes?: string, parent?: string, externalRef?: string }} [fields]
   * @returns {Promise<any>}
   */
  async function update(id, fields = {}) {
    const args = ['update', id];
    if (fields.externalRef !== undefined) args.push('--external-ref', fields.externalRef);
    if (fields.title !== undefined) args.push('--title', fields.title);
    if (fields.description !== undefined) args.push('--description', fields.description);
    if (fields.status !== undefined) args.push('--status', fields.status);
    if (fields.priority !== undefined) args.push('--priority', String(fields.priority));
    if (fields.issueType !== undefined) args.push('--type', fields.issueType);
    if (fields.notes !== undefined) args.push('--notes', fields.notes);
    if (fields.parent !== undefined) args.push('--parent', fields.parent);
    args.push('--json');

    const label = `bd ${args.join(' ')}`;
    const { stdout } = await runBd(args, label);
    return parseBdOutput(stdout, label);
  }

  /**
   * Reparent `childId` under `parentId`. A thin `update()` call, kept as its
   * own method because "set a bead's parent" is a distinct operation callers
   * reach for, not an incidental field update.
   * @param {string} childId
   * @param {string} parentId
   * @returns {Promise<any>}
   */
  async function setParent(childId, parentId) {
    return update(childId, { parent: parentId });
  }

  /**
   * Local beads-DB health probe: `bd dolt pull` against the configured dolt
   * remote. This is LOCAL and credential-free -- it authenticates via
   * whatever git/dolt credential is already configured on the runner, never
   * a tracker PAT -- so it stays on the exec-bd path, never dispatched to a
   * member. All args are safe-charset, so this always routes through
   * execBdAsync.
   * @returns {Promise<{ ok: true, stdout: string, stderr: string }>}
   */
  async function doltPullProbe() {
    const args = ['dolt', 'pull'];
    const label = `bd ${args.join(' ')}`;
    const { stdout, stderr } = await runBd(args, label);
    return { ok: true, stdout, stderr };
  }

  /**
   * `bd dolt remote list --json` -- the configured dolt remotes (if any) for
   * this local beads DB. LOCAL and credential-free, same as doltPullProbe.
   * Used by preflight.mjs's beads-health check to distinguish "no dolt
   * remote configured" (a fully-supported single-runner setup) from "a
   * remote is configured but unreachable" -- a stable, direct signal from
   * beads itself, preferred there over pattern-matching `bd dolt pull`'s
   * error text.
   * @returns {Promise<any[]>} empty array when no remote is configured.
   */
  async function doltRemoteList() {
    const args = ['dolt', 'remote', 'list', '--json'];
    const label = `bd ${args.join(' ')}`;
    const { stdout } = await runBd(args, label);
    return parseBdOutput(stdout, label);
  }

  /**
   * Dispatches a tracker-touching `bd ado`/`bd github` pull or push to the
   * configured member via the injected `callTool('execute_command', ...)`.
   * @param {{ namespace: 'ado'|'github', verb: 'pull'|'push', refs?: string[], secretName: string, dryRun?: boolean }} opts
   * @returns {Promise<any>}
   */
  async function dispatchTrackerCommand({ namespace, verb, refs, secretName, dryRun }) {
    if (typeof callTool !== 'function') {
      // CONFIG_MISSING is the correct code: this is a missing constructor dependency,
      // not a transient connectivity failure. SUPERVISOR_UNAVAILABLE is reserved for
      // an actual failed connectivity attempt, never for a dependency that was never injected.
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_MISSING,
        `beadsClient: tracker-touching call ('bd ${namespace} ${verb}') requires an injected callTool -- none was provided to createBeadsClient()`,
        { namespace, verb }
      );
    }
    if (!memberName || typeof memberName !== 'string') {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_MISSING,
        `beadsClient: tracker-touching call ('bd ${namespace} ${verb}') requires memberName -- none was provided to createBeadsClient()`,
        { namespace, verb }
      );
    }

    const refList = Array.isArray(refs) ? [...refs] : [];

    const command = buildTrackerCommand({ namespace, verb, refs: refList, secretName, dryRun, targetOs, shell });
    log(`[beads-client] dispatching 'bd ${namespace} ${verb}' to member '${memberName}' (${refList.length} arg(s))`);
    return callTool('execute_command', { member_name: memberName, command });
  }

  /**
   * `bd ado pull <refs...>` / `bd github pull <refs...>`, dispatched to the
   * member. `refs` accepts bead IDs or external tracker references.
   * @param {'ado'|'github'} namespace
   * @param {string[]} refs
   * @param {{ secretName: string }} opts
   * @returns {Promise<any>}
   */
  async function trackerPull(namespace, refs, { secretName } = {}) {
    return dispatchTrackerCommand({ namespace, verb: 'pull', refs, secretName });
  }

  /**
   * `bd ado push <beadIds...>` / `bd github push <beadIds...>`, dispatched
   * to the member. Explicitly ID-scoped -- never a bare `sync` -- so only
   * the given `beadIds` are ever pushed.
   * @param {'ado'|'github'} namespace
   * @param {string[]} beadIds
   * @param {{ secretName: string, dryRun?: boolean }} opts
   * @returns {Promise<any>}
   */
  async function trackerPush(namespace, beadIds, { secretName, dryRun } = {}) {
    return dispatchTrackerCommand({ namespace, verb: 'push', refs: beadIds, secretName, dryRun });
  }

  return {
    list,
    show,
    create,
    update,
    setParent,
    doltPullProbe,
    doltRemoteList,
    trackerPull,
    trackerPush,
  };
}

export default createBeadsClient;
