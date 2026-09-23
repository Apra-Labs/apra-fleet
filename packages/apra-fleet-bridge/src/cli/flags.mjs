// flags.mjs -- the one declaration of which flags each fleet-bridge verb
// accepts, and the two guards built on it.
//
// WHY THIS FILE EXISTS
// -----------------------------------------------------------------------------
// `parseArgs` (args.mjs) accepts any `--anything`, and for a long time nothing
// downstream rejected a flag a verb did not read. The Azure Pipelines template
// rotted exactly that way: it passed `--work-items` (the flag is `--refs`),
// `--ado-pat-secret-name` (the flag is `--secret-name`), `--ado-org-url` (no
// verb read it), `--await-timeout-minutes` (not a flag at all), and launch's
// SprintRequest fields as flags (launch reads them from `--request-file`). Every
// one was silently ignored, so the pipeline failed later, far from the cause,
// with a CONFIG_MISSING that named a flag the author believed they had passed.
// Nothing crashed, so nothing got fixed. That is the "implicit environment
// decides behaviour and failure is silent" shape; the fix is to make the
// accepted set explicit and to fail loudly on anything outside it.
//
// ONE DECLARATION, CHECKED IN BOTH DIRECTIONS
// -----------------------------------------------------------------------------
// `VERB_FLAGS` below is the single source of truth. It is used three ways:
//   1. `assertKnownFlags` rejects, at dispatch time, any flag the verb does not
//      declare (user-facing: a stale or misspelt flag is a usage error naming
//      the flag, the likely intended one, and the accepted set).
//   2. `declaredFlagsView` wraps the parsed flags so that a verb READING a flag
//      it does not declare throws FLAG_UNDECLARED (developer-facing: a new
//      `flags.get('x')` or `configValue({ flagName: 'x' })` without a matching
//      entry here cannot ship, because the declaration would reject the flag
//      the code wants to read -- the flag would be unusable, and silently so).
//   3. test/cli-flags.test.mjs drives every verb's real buildOpts/buildDeps
//      through a recording view and asserts the set of names it read EQUALS
//      the declaration, so a declared-but-never-read entry (a stale flag kept
//      "for compatibility") fails too. The pipeline-template drift guard
//      (test/pipeline-template.test.mjs) checks every template invocation
//      against this same table.
// A declaration that is merely documentation drifts; one that the code cannot
// read around, and that tests prove equal to what the code reads, cannot.
//
// Flags are grouped by the shared helper in bin/fleet-bridge.mjs that reads
// them, so a verb's list reads as "what it reads itself, plus which shared
// collaborators it builds" -- the same shape as its buildOpts/buildDeps.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { KNOWN_REQUEST_KEYS } from '../contracts.mjs';

/** Accepted by every verb, and answered by dispatch() before any verb runs. */
export const GLOBAL_FLAGS = Object.freeze(['help', 'version']);

/**
 * Flags that take no value. Declared so a boolean given a value (`--dry-run
 * yes`) is an error instead of a silent `false`: the verbs test
 * `flags.get(x) === true`, so a string value used to read as "not set" -- for
 * `--dry-run` that turned a requested preview into a real publish.
 */
export const BOOLEAN_FLAGS = Object.freeze(new Set([
  'help',
  'version',
  'allow-missing-criteria',
  'require-criteria',
  'override-relaunch-gate',
  'dry-run',
]));

// Shared collaborator groups -- one per bin/fleet-bridge.mjs helper.
/** createRealContext().supervisorClient(flags) */
const SUPERVISOR = ['supervisor-url'];
/** createRealContext().spool(flags) / jsonlPathFor(flags) */
const SPOOL = ['spool-dir'];
/** resolveAdapterCoordinates(ctx, flags) */
const ADAPTER_COORDINATES = ['ado-org-url', 'ado-project', 'secret-name', 'work-item-type'];
/** resolveBlobDestination(ctx, flags) */
const BLOB = ['blob-account-url', 'blob-container'];
/** repoLocalPathFor(handle, flags) -- the fallback when a handle has no repo.localPath */
const REPO_FALLBACK = ['repo-local-path'];
/** memberAndPlatformFor(handle, ctx, flags) -- the fallback when there is no handle */
const MEMBER_PLATFORM_FALLBACK = ['member', 'platform'];

function freezeSorted(names) {
  return Object.freeze([...new Set(names)].sort());
}

/**
 * Every flag each verb accepts, excluding GLOBAL_FLAGS. Keep each list equal
 * to what that verb's buildOpts/buildDeps actually read -- the tests enforce
 * it both ways, see the file header.
 */
export const VERB_FLAGS = Object.freeze({
  preflight: freezeSorted([
    'member', 'repo-local-path', 'repo-remote-url', 'base-branch',
    'required-credentials', 'secret-name', 'playbooks-dir', 'spawn',
    ...SUPERVISOR,
  ]),
  ingest: freezeSorted([
    'refs', 'secret-name', 'allow-missing-criteria', 'require-criteria', 'epic-title',
    'member', 'platform', 'repo-local-path',
    ...SUPERVISOR,
  ]),
  launch: freezeSorted([
    'request-file', 'request-json', 'synthetic-root-id', 'await-until',
    'override-relaunch-gate', 'timeout-ms', 'poll-ms', 'watcher', 'watcher-timeout-ms',
    ...SUPERVISOR, ...SPOOL,
  ]),
  watch: freezeSorted([
    'sprint-id', 'give-up-ms', 'log-tail-lines',
    ...MEMBER_PLATFORM_FALLBACK, ...ADAPTER_COORDINATES, ...BLOB, ...REPO_FALLBACK,
    ...SUPERVISOR, ...SPOOL,
  ]),
  finalize: freezeSorted([
    'sprint-id', 'dry-run', 'max-carry-over',
    ...MEMBER_PLATFORM_FALLBACK, ...ADAPTER_COORDINATES, ...BLOB, ...REPO_FALLBACK,
    ...SUPERVISOR, ...SPOOL,
  ]),
  status: freezeSorted([
    'sprint-id', 'log-tail-lines',
    ...SUPERVISOR, ...SPOOL,
  ]),
  // No member/platform fallback: the daemon only ever works handles written by
  // launch, whose validated SprintRequest always carries both. Accepting
  // `--member` here would invite reading it as "only watch this member's
  // sprints", which the daemon does not do.
  daemon: freezeSorted([
    'scan-interval-ms',
    ...ADAPTER_COORDINATES, ...BLOB, ...REPO_FALLBACK,
    ...SUPERVISOR, ...SPOOL,
  ]),
  viewer: freezeSorted(['listen-host', 'listen-port', 'upstream-host', 'upstream-port']),
});

/**
 * Names that were once used (by the design doc, the first pipeline template,
 * or an earlier spelling) for something the CLI now spells differently. A
 * hit gets a precise pointer rather than an edit-distance guess, because
 * these are not typos -- `--work-items` is nowhere near `--refs`.
 */
export const RENAMED_FLAGS = Object.freeze({
  'work-items': { to: 'refs', note: 'comma-separated work item ids or URLs' },
  'ado-pat-secret-name': { to: 'secret-name', note: 'the stored credential NAME, never a value' },
  'pat-secret-name': { to: 'secret-name' },
  'await-timeout-minutes': { to: 'timeout-ms', note: 'milliseconds, not minutes' },
  'await-timeout-ms': { to: 'timeout-ms' },
  // The design document's names for the await gate, before it was built.
  'await-plan': { to: 'await-until', note: 'e.g. --await-until plan-approved' },
  'await-timeout': { to: 'timeout-ms', note: 'milliseconds' },
  adoOrgUrl: { to: 'ado-org-url' },
  adoProject: { to: 'ado-project' },
  'root-id': { to: 'synthetic-root-id', note: "ingest's syntheticRootId output" },
  'viewer-port': { to: 'listen-port', note: 'a flag of the viewer verb, which runs as its own long-lived process' },
});

function kebabToCamel(name) {
  return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/** Plain Levenshtein distance; flag names are short, so O(n*m) is fine. */
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * The most useful hint for one unknown flag on one verb, or null.
 * @param {string} verb
 * @param {string} name - the flag name without its leading dashes
 * @returns {string|null}
 */
export function suggestFlag(verb, name) {
  const accepted = VERB_FLAGS[verb] || [];
  const renamed = RENAMED_FLAGS[name];
  if (renamed && accepted.includes(renamed.to)) {
    return `did you mean --${renamed.to}?${renamed.note ? ` (${renamed.note})` : ''}`;
  }
  // launch takes the SprintRequest as a document, not as flags. The first
  // template passed --target-branch/--goal/--max-cycles/... to launch and
  // every one was dropped; say where they belong instead of guessing a flag.
  if (verb === 'launch' && KNOWN_REQUEST_KEYS.has(kebabToCamel(name))) {
    return `launch takes "${kebabToCamel(name)}" as a SprintRequest field inside --request-file / --request-json, not as a flag`;
  }
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const d = editDistance(name, candidate);
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  if (best && bestDistance <= 2) return `did you mean --${best}?`;
  if (renamed) return `--${name} is now --${renamed.to}, which ${verb} does not accept`;
  return null;
}

/**
 * Reject every flag `verb` does not declare, every positional argument (no
 * verb takes any -- an extra word on the command line used to be dropped as
 * silently as an unknown flag), a boolean flag given a non-boolean value, and
 * a value flag given no value. Returns a normalized copy of `flags` in which
 * 'true'/'false' strings on boolean flags are real booleans.
 *
 * @param {string} verb
 * @param {Map<string, any>} flags - parseArgs().flags
 * @param {string[]} [positionals] - parseArgs().positionals
 * @returns {Map<string, any>}
 * @throws {BridgeError} USAGE (exit 2) naming each offending flag
 */
export function assertKnownFlags(verb, flags, positionals = []) {
  const accepted = VERB_FLAGS[verb];
  if (!accepted) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.FLAG_UNDECLARED,
      `fleet-bridge internal error: verb "${verb}" has no entry in VERB_FLAGS (src/cli/flags.mjs)`,
      { verb },
    );
  }
  const allowed = new Set([...accepted, ...GLOBAL_FLAGS]);
  const problems = [];
  const normalized = new Map();

  for (const [name, value] of flags) {
    if (!allowed.has(name)) {
      const hint = suggestFlag(verb, name);
      problems.push(`unknown flag --${name}${hint ? ` (${hint})` : ''}`);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (value === true || value === 'true') { normalized.set(name, true); continue; }
      if (value === false || value === 'false') { normalized.set(name, false); continue; }
      problems.push(`--${name} is a boolean flag and takes no value (got "${value}"); pass --${name} or --no-${name}`);
      continue;
    }
    if (value === true || value === false) {
      problems.push(`--${name} requires a value (e.g. --${name} <value>)`);
      continue;
    }
    normalized.set(name, value);
  }

  if (positionals.length > 0) {
    problems.push(`unexpected argument(s) ${positionals.map((p) => JSON.stringify(p)).join(', ')} -- ${verb} takes flags only`);
  }

  if (problems.length > 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.USAGE,
      `${verb}: ${problems.join('; ')}.\n`
      + `  ${verb} accepts: ${accepted.map((f) => `--${f}`).join(', ')}\n`
      + `  every verb accepts: ${GLOBAL_FLAGS.map((f) => `--${f}`).join(', ')}`,
      { verb, problems, accepted: [...accepted] },
    );
  }
  return normalized;
}

/**
 * A Map view of `flags` that throws FLAG_UNDECLARED when code asks about a
 * flag `verb` does not declare. See the file header, point 2, for why a read
 * is policed and not only the user's input.
 *
 * `onRead`, when given, is called with each name read -- the hook the
 * declaration-equality test records through. Production passes none.
 *
 * @param {string} verb
 * @param {Map<string, any>} flags
 * @param {{ onRead?: (name: string) => void }} [opts]
 * @returns {Map<string, any>}
 */
export function declaredFlagsView(verb, flags, { onRead } = {}) {
  const allowed = new Set([...(VERB_FLAGS[verb] || []), ...GLOBAL_FLAGS]);
  const view = new Map(flags);
  const check = (name) => {
    if (onRead) onRead(name);
    if (!allowed.has(name)) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.FLAG_UNDECLARED,
        `fleet-bridge internal error: verb "${verb}" read flag --${name}, which VERB_FLAGS.${verb} `
        + '(src/cli/flags.mjs) does not declare. Declare it there, or stop reading it -- '
        + 'an undeclared flag is rejected on the command line, so this read can never see a value.',
        { verb, flag: name },
      );
    }
  };
  view.get = (name) => { check(name); return Map.prototype.get.call(view, name); };
  view.has = (name) => { check(name); return Map.prototype.has.call(view, name); };
  return view;
}
