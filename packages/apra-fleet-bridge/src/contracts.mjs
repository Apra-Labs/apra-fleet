// Validators for fleet-bridge inputs (no I/O, pure functions).

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';

// Patterns copied from packages/apra-fleet-se/fleet-sprint/sprint-args.mjs
// to ensure local validation matches remote engine validation.
export const ISSUE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
export const GOAL_PATTERN = /^P[1-3](\/P[1-3]){0,2}$/;

// Conservative charset for an EXTERNAL TRACKER reference -- a work-item id
// (`WI-123`), a GitHub cross-repo ref (`owner/repo#123`), or a bead id
// appearing in a `workItems` entry or a member-dispatched `bd ado`/`bd
// github` command string. This is deliberately NOT ISSUE_ID_PATTERN:
// ISSUE_ID_PATTERN has no '/' or '#', so it would reject legitimate GitHub
// refs like `owner/repo#123`. workItems are external tracker refs, not bead
// ids -- see assertValidTrackerRef.
//
// This module owns the pattern (rather than beads-client.mjs, which
// originated it) because contracts.mjs is the pure-validation module with no
// side effects, and beads-client.mjs already imports from errors.mjs here in
// this package -- adding a second import from contracts.mjs introduces no
// cycle, since contracts.mjs imports nothing from beads-client.mjs.
export const TRACKER_REF_PATTERN = /^[A-Za-z0-9._#:/-]+$/;

// Charset guard for a stored CREDENTIAL NAME (never a value) -- identical to
// rest-client.mjs's own SECRET_NAME_PATTERN, which this module cannot import
// (rest-client.mjs is outside this task's editable set, and contracts.mjs is
// meant to have no I/O-module dependencies anyway). Kept as the ONE such
// pattern in this file so a future secretName-shaped SprintRequest field
// reuses `assertValidSecretName` below rather than growing a second copy.
// An allowlist charset, not a denylist: alphanumerics plus '_.-' only, which
// already excludes '}' (so a malicious name could never close a
// `{{secret.NAME}}` placeholder early) without needing a separate check for
// it.
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validates a single stored-credential NAME (never a value) intended for
 * `{{secret.NAME}}` interpolation: must be a non-empty string, must not
 * begin with '-' (flag injection, same rule as assertValidTrackerRef), and
 * must match SECRET_NAME_PATTERN.
 *
 * @param {any} name
 * @param {string} label - what this name is called in the caller's context.
 * @throws {BridgeError} CONFIG_INVALID
 */
export function assertValidSecretName(name, label) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid ${label}: must be a non-empty string, got ${JSON.stringify(name)}`,
      { label, value: name }
    );
  }
  if (name.startsWith('-')) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid ${label} ${JSON.stringify(name)}: may not begin with a dash (would be parsed as a flag)`,
      { label, value: name }
    );
  }
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid ${label}: unsafe value ${JSON.stringify(name)}`,
      { label, value: name }
    );
  }
}

/**
 * Validates a single external-tracker reference intended for interpolation
 * into a `bd`-argv or a member-dispatched command string: must be a
 * non-empty string, must not begin with '-' (would be parsed as a CLI flag
 * -- flag injection), and must match TRACKER_REF_PATTERN.
 *
 * Always throws CONFIG_INVALID, never BEADS_FAILED: a malformed ref reaching
 * this check is CALLER-provided bad input (the pipeline's `workItems`
 * parameter), not an internal defect of the bridge or the `bd` binary. See
 * the same rule recorded on buildTrackerCommand's call site in
 * beads-client.mjs.
 *
 * @param {any} ref
 * @param {string} label - what this ref is called in the caller's context,
 *   used verbatim in the error message (e.g. 'work item', 'ref/flag').
 * @throws {BridgeError} CONFIG_INVALID
 */
export function assertValidTrackerRef(ref, label) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid ${label}: must be a non-empty string, got ${JSON.stringify(ref)}`,
      { label, value: ref }
    );
  }
  if (ref.startsWith('-')) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid ${label} ${JSON.stringify(ref)}: may not begin with a dash (would be parsed as a flag)`,
      { label, value: ref }
    );
  }
  if (!TRACKER_REF_PATTERN.test(ref)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid ${label}: unsafe value ${JSON.stringify(ref)}`,
      { label, value: ref }
    );
  }
}

export const AWAIT_UNTIL_SPECS = Object.freeze([
  'launch',
  'plan-round',
  'plan-approved',
  'plan-settled',
]);

/**
 * Parse an await-until spec (e.g., 'launch', 'phase:regex', 'cycle:5').
 * @param {string} spec
 * @returns {{kind: string, pattern?: RegExp, cycle?: number}}
 * @throws {BridgeError} CONFIG_INVALID if spec is invalid
 */
export function parseAwaitUntil(spec) {
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid await-until spec: must be a non-empty string`
    );
  }

  // Check if it's a known spec
  if (AWAIT_UNTIL_SPECS.includes(spec)) {
    return Object.freeze({ kind: spec });
  }

  // Check for phase:regex form
  if (spec.startsWith('phase:')) {
    const pattern = spec.slice('phase:'.length);
    if (pattern.length === 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid phase spec: pattern cannot be empty`,
        { spec }
      );
    }
    try {
      const regex = new RegExp(pattern);
      return Object.freeze({ kind: 'phase', pattern: regex });
    } catch (err) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid phase regex: ${err.message}`,
        { spec, error: err.message }
      );
    }
  }

  // Check for cycle:N form
  if (spec.startsWith('cycle:')) {
    const cycleStr = spec.slice('cycle:'.length);
    const cycle = Number.parseInt(cycleStr, 10);
    if (Number.isNaN(cycle) || cycle < 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid cycle spec: must be a non-negative integer`,
        { spec }
      );
    }
    return Object.freeze({ kind: 'cycle', cycle });
  }

  throw new BridgeError(
    BRIDGE_ERROR_CODES.CONFIG_INVALID,
    `Invalid await-until spec "${spec}": must be one of ${AWAIT_UNTIL_SPECS.join(', ')}, phase:<regex>, or cycle:<N>`,
    { spec }
  );
}

export const KNOWN_REQUEST_KEYS = Object.freeze(new Set([
  'platform',
  'repo',
  'workItems',
  'targetBranch',
  'baseBranch',
  'goal',
  'member',
  'maxCycles',
  'budget',
  'requirementsFile',
  'mode',
  'triggeredBy',
  'runUrl',
  // Platform-neutral name (not adoPatSecretName): SprintRequest is meant to
  // stay platform-agnostic (see 'platform' above), and every tracker
  // adapter's own PAT/token is conceptually the same shape -- one stored
  // credential NAME for the sprint engine's own VCS auth step. This is
  // DISTINCT from azure-devops.mjs's own adoPatSecretName (that one is the
  // BRIDGE's PAT, for its own `bd ado pull/push`/REST comments); this field
  // is the ENGINE's PAT, for `provision_vcs_auth` -- see buildPostSprintBody
  // in verbs/launch.mjs, which maps this onto the engine's own
  // `azdevops_pat_secret_name` launch arg when present.
  'patSecretName',
]));

/**
 * Validates a sprint request and returns a normalized, frozen object.
 * Throws BridgeError on missing/invalid required keys or unknown keys.
 * @param {any} req
 * @returns {object} normalized sprint request
 * @throws {BridgeError} CONFIG_INVALID or CONFIG_MISSING
 */
export function validateSprintRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Sprint request must be an object'
    );
  }

  // Check for unknown keys
  const unknown = Object.keys(req).filter((k) => !KNOWN_REQUEST_KEYS.has(k));
  if (unknown.length > 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Unknown request keys: ${unknown.join(', ')}`,
      { unknownKeys: unknown }
    );
  }

  // Validate required: platform (non-empty string)
  if (typeof req.platform !== 'string' || req.platform.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'Missing or invalid required field: platform (non-empty string)'
    );
  }

  // Validate required: member (non-empty string)
  if (typeof req.member !== 'string' || req.member.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'Missing or invalid required field: member (non-empty string)'
    );
  }

  // Validate required: workItems (non-empty array of non-empty strings)
  if (!Array.isArray(req.workItems) || req.workItems.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Missing or invalid required field: workItems (non-empty array of strings)'
    );
  }
  for (const item of req.workItems) {
    // workItems are EXTERNAL TRACKER refs (work-item ids, GitHub
    // `owner/repo#123` refs), not bead ids -- validated with the same rule
    // beads-client.mjs's buildTrackerCommand applies to tracker refs, so a
    // malformed id fails fast here instead of much later in the pipeline.
    assertValidTrackerRef(item, 'work item');
  }

  // Validate optional: repo
  let repo;
  if (req.repo !== undefined) {
    if (!req.repo || typeof req.repo !== 'object' || Array.isArray(req.repo)) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'Invalid repo: must be an object with remoteUrl and localPath'
      );
    }
    repo = {
      remoteUrl: req.repo.remoteUrl,
      localPath: req.repo.localPath,
    };
  }

  // Validate optional: targetBranch
  let targetBranch;
  if (req.targetBranch !== undefined) {
    if (typeof req.targetBranch !== 'string' || !BRANCH_NAME_PATTERN.test(req.targetBranch)) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid targetBranch "${req.targetBranch}": must match ${BRANCH_NAME_PATTERN}`,
        { field: 'targetBranch' }
      );
    }
    targetBranch = req.targetBranch;
  }

  // Validate optional: baseBranch
  let baseBranch;
  if (req.baseBranch !== undefined) {
    if (typeof req.baseBranch !== 'string' || !BRANCH_NAME_PATTERN.test(req.baseBranch)) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid baseBranch "${req.baseBranch}": must match ${BRANCH_NAME_PATTERN}`,
        { field: 'baseBranch' }
      );
    }
    baseBranch = req.baseBranch;
  }

  // Reject targetBranch === baseBranch. This is the mistake that actually
  // reached a live launch attempt: nothing downstream rejects it, and
  // branch-ensure.mjs in the sprint engine (packages/apra-fleet-se/fleet-sprint/branch-ensure.mjs)
  // creates the sprint's working branch FROM the base branch -- so if
  // targetBranch (the sprint's own working branch, where its commits land)
  // names the SAME branch as baseBranch (the branch it is cut from and the
  // PR is raised against), the sprint commits go straight onto that branch
  // and the eventual PR is a request from the branch into itself. On a real
  // repo with a protected default branch, that means unreviewed commits
  // landing directly on it -- exactly what the whole PR-based design exists
  // to prevent. Only trims surrounding whitespace before comparing (a
  // copy-paste artifact should not defeat this check); does NOT lowercase,
  // because git branch names are case-sensitive -- "Main" and "main" are
  // genuinely different refs, and folding their case here would reject a
  // legitimate distinct pair. Runs only after both fields have already
  // passed BRANCH_NAME_PATTERN above, so a malformed branch name is reported
  // as its own specific error first. Fires only when BOTH fields are
  // present -- each is independently optional, and one being unset is not
  // this mistake.
  if (targetBranch !== undefined && baseBranch !== undefined
      && targetBranch.trim() === baseBranch.trim()) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `targetBranch and baseBranch are both "${req.targetBranch}", but they must name different `
        + `branches. targetBranch is the sprint's OWN working branch, where its commits land. `
        + `baseBranch is the branch the sprint is cut FROM and the branch the PR is raised `
        + `AGAINST. With them equal, the sprint would commit straight onto "${req.baseBranch}" `
        + `and then try to open a pull request from that branch into itself.`,
      { field: 'targetBranch', targetBranch: req.targetBranch, baseBranch: req.baseBranch }
    );
  }

  // Validate optional: goal (default 'P1/P2')
  const goal = req.goal === undefined ? 'P1/P2' : req.goal;
  if (typeof goal !== 'string' || !GOAL_PATTERN.test(goal)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid goal "${goal}": must match ${GOAL_PATTERN}`,
      { field: 'goal' }
    );
  }

  // Validate optional: mode (default 'detached'; 'attached' throws)
  const mode = req.mode === undefined ? 'detached' : req.mode;
  if (mode === 'attached') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Attached mode is not supported yet',
      { field: 'mode' }
    );
  }
  // 'attached' already threw above, so by this point mode can never be
  // 'attached' -- the `&& mode !== 'attached'` conjunct here was dead.
  if (typeof mode !== 'string' || mode !== 'detached') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `Invalid mode "${mode}": must be 'detached' or 'attached'`,
      { field: 'mode' }
    );
  }

  // Validate optional: maxCycles (positive int)
  let maxCycles;
  if (req.maxCycles !== undefined) {
    if (typeof req.maxCycles !== 'number' || !Number.isInteger(req.maxCycles) || req.maxCycles < 1) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid maxCycles: must be a positive integer`,
        { field: 'maxCycles' }
      );
    }
    maxCycles = req.maxCycles;
  }

  // Validate optional: budget (non-negative finite number)
  let budget;
  if (req.budget !== undefined) {
    if (typeof req.budget !== 'number' || !Number.isFinite(req.budget) || req.budget < 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid budget: must be a non-negative finite number`,
        { field: 'budget' }
      );
    }
    budget = req.budget;
  }

  // Validate optional: requirementsFile (non-empty string)
  let requirementsFile;
  if (req.requirementsFile !== undefined) {
    if (typeof req.requirementsFile !== 'string' || req.requirementsFile.length === 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'Invalid requirementsFile: must be a non-empty string',
        { field: 'requirementsFile' }
      );
    }
    requirementsFile = req.requirementsFile;
  }

  // Validate optional: triggeredBy (string)
  let triggeredBy;
  if (req.triggeredBy !== undefined && typeof req.triggeredBy === 'string') {
    triggeredBy = req.triggeredBy;
  }

  // Validate optional: runUrl (string)
  let runUrl;
  if (req.runUrl !== undefined && typeof req.runUrl === 'string') {
    runUrl = req.runUrl;
  }

  // Validate optional: patSecretName -- the ENGINE's own PAT/token secret
  // NAME (never a value), threaded through to the sprint engine's
  // `azdevops_pat_secret_name` launch arg by buildPostSprintBody
  // (verbs/launch.mjs). Same charset guard as rest-client.mjs's own
  // secretName check (assertValidSecretName above): optional string,
  // [A-Za-z0-9_.-]+, no leading dash, excludes '}'.
  let patSecretName;
  if (req.patSecretName !== undefined) {
    assertValidSecretName(req.patSecretName, 'patSecretName');
    patSecretName = req.patSecretName;
  }

  return Object.freeze({
    platform: req.platform,
    repo,
    workItems: req.workItems,
    targetBranch,
    baseBranch,
    goal,
    member: req.member,
    maxCycles,
    budget,
    requirementsFile,
    mode,
    triggeredBy,
    runUrl,
    patSecretName,
  });
}

// A narrow, VALUE-shaped check to sit alongside the key-name checks below: a
// URL of the form scheme://user:password@host embeds a literal credential
// no matter what its key is named -- and `repo.remoteUrl` is a real
// SprintRequest field that lands in the persisted handle. This guard
// enforces "no secret-named field AND no credential-bearing URL", NOT "no
// secret-shaped value anywhere": general entropy detection or JWT-shape
// sniffing is deliberately out of scope, since that would produce false
// positives on legitimate data. The structural defence for everything else
// remains that the bridge only ever handles secret NAMES
// (`{{secret.NAME}}`), never secret values.
//
// Exported (not just module-private) so log-safe.mjs's mask-and-continue
// redactor can reuse the exact same value-shaped rule rather than
// maintaining a second copy that could silently drift from this one.
export const CREDENTIAL_URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/;

// An Azure Storage SAS (Shared Access Signature) URL is ALSO a credential,
// but not in the user:password@ shape above -- a SAS URL is plain
// https://account.host/container/blob?<query>, and the credential lives in
// the query string's 'sig' parameter: the HMAC signature that IS the
// delegated access grant. Anyone holding a URL with a valid 'sig' can use it
// exactly as if they held the account key/user-delegation token it was
// derived from. The other common SAS query parameters -- sv (version), se
// (expiry), sp (permissions), st (start time), and skoid/sktid (the
// user-delegation principal's AAD object/tenant id) -- describe the grant
// but do not themselves confer access without 'sig', and are exactly the
// fields useful when debugging a failed request (expired? wrong permission
// scope? clock skew? wrong delegation principal?). So only 'sig' is matched
// here, deliberately leaving the account, container, blob path, and those
// other parameters legible. Like CREDENTIAL_URL_PATTERN above, declared
// without the 'g' flag -- log-safe.mjs makes its own global copy to mask
// every occurrence, not just the first.
export const SAS_SIGNATURE_PATTERN = /([?&]sig=)[^&\s]+/i;

// Substrings to match case-insensitively within key names.
const SECRET_KEY_SUBSTRINGS = ['token', 'sas', 'password', 'secret'];
// 'pat' is only matched as an exact key, not as a substring, to avoid false positives
// on legitimate keys like 'path', 'patch', 'compatible', 'pattern'.
const EXACT_SECRET_KEYS = ['pat'];

/**
 * True iff `key` looks like it names a secret-bearing field -- 'token', 'sas',
 * 'password', 'secret' as case-insensitive substrings, and 'pat' as an
 * exact (case-insensitive) match only (a substring rule would also hit
 * 'path', 'patch', 'compatible', 'pattern').
 *
 * This is the ONE definition of "does this key name a secret" for the whole
 * package -- `assertNoSecrets` (throw-on-detect, below) and log-safe.mjs's
 * `createRedactor` (mask-and-continue) both call this rather than each
 * keeping their own copy of the key-name rule.
 * @param {any} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  if (typeof key !== 'string') return false;
  const keyLower = key.toLowerCase();
  if (SECRET_KEY_SUBSTRINGS.some((substring) => keyLower.includes(substring))) return true;
  return EXACT_SECRET_KEYS.includes(keyLower);
}

/**
 * Guard: assert no secret-bearing keys exist in an object graph (case-insensitive),
 * and no string value embeds a credential-bearing URL (scheme://user:password@host).
 * Key names are tested with `isSecretKey` (see above for the exact rule).
 * Throws if found. Recursive over nested objects and arrays.
 * @param {any} obj
 * @param {string} label - context for error message
 * @throws {BridgeError} if secrets detected
 */
export function assertNoSecrets(obj, label) {
  function walk(val, path) {
    if (typeof val === 'string') {
      if (CREDENTIAL_URL_PATTERN.test(val)) {
        throw new BridgeError(
          BRIDGE_ERROR_CODES.CONFIG_INVALID,
          `Attempt to embed a credential-bearing URL in ${label}: found at ${path}`,
          { field: path }
        );
      }
      return;
    }

    if (val === null || typeof val !== 'object') {
      return;
    }

    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        walk(val[i], `${path}[${i}]`);
      }
      return;
    }

    for (const [key, value] of Object.entries(val)) {
      if (isSecretKey(key)) {
        throw new BridgeError(
          BRIDGE_ERROR_CODES.CONFIG_INVALID,
          `Attempt to embed secret in ${label}: found key "${key}" at ${path}.${key}`,
          { field: `${path}.${key}` }
        );
      }

      walk(value, `${path}.${key}`);
    }
  }

  walk(obj, label);
}

/**
 * Create a sprint handle from a launch response.
 * Throws if any secret-bearing keys are detected in the object graph.
 * @param {object} options
 * @param {object} options.launchResponse - server response from launch
 * @param {object} options.request - the validated sprint request
 * @param {number} options.startedAt - timestamp when sprint started
 * @param {string} options.syntheticRootId - synthetic root issue id
 * @returns {object} frozen sprint handle
 * @throws {BridgeError} if secrets detected
 */
export function makeSprintHandle({ launchResponse, request, startedAt, syntheticRootId }) {
  // issueRoots are genuine BEAD ids (not external tracker refs), so they are
  // validated against ISSUE_ID_PATTERN here -- the one place in this module
  // that handles bead ids rather than workItems' external tracker refs.
  if (launchResponse?.issueRoots !== undefined) {
    if (!Array.isArray(launchResponse.issueRoots)) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'Invalid launchResponse.issueRoots: must be an array of bead ids',
        { field: 'issueRoots' }
      );
    }
    for (const id of launchResponse.issueRoots) {
      if (typeof id !== 'string' || !ISSUE_ID_PATTERN.test(id)) {
        throw new BridgeError(
          BRIDGE_ERROR_CODES.CONFIG_INVALID,
          `Invalid launchResponse.issueRoots entry: ${JSON.stringify(id)} must match ${ISSUE_ID_PATTERN}`,
          { field: 'issueRoots', value: id }
        );
      }
    }
  }

  const handle = {
    version: 1,
    sprintId: launchResponse?.sprintId,
    pid: launchResponse?.pid,
    port: launchResponse?.port,
    logPath: launchResponse?.logPath,
    issueRoots: launchResponse?.issueRoots,
    request,
    syntheticRootId,
    startedAt,
  };

  // Guard against secrets in the handle
  assertNoSecrets(handle, 'sprint-handle');

  return Object.freeze(handle);
}

/**
 * Validate a progress snapshot object.
 * @param {any} s
 * @throws {BridgeError} if invalid
 */
export function validateProgressSnapshot(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Progress snapshot must be an object'
    );
  }

  // Validate required fields
  if (typeof s.sprintId !== 'string' || s.sprintId.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: sprintId is required'
    );
  }

  if (typeof s.phase !== 'string' || s.phase.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: phase is required'
    );
  }

  // `cycle` is required, but `null` is a legal value distinct from a missing
  // one: it means "durable evidence exists for this sprint, but no cycle
  // number could be recovered from it" -- e.g. status.mjs's
  // buildTerminalFromEvidence() (snapshot.mjs), built from a raw log tail or
  // a recorded spool outcome once the supervisor has forgotten the sprint,
  // neither of which carries a phase tree to read a cycle off. `0` would
  // read as "cycle zero happened," which is invented data this package must
  // never report (see snapshot.mjs's file header); `null` says plainly "not
  // known," the same way `phaseEndedAt === null` legitimately means
  // "still running" elsewhere in this file (currentPhase()'s doc comment).
  if (s.cycle !== null && (typeof s.cycle !== 'number' || !Number.isInteger(s.cycle) || s.cycle < 0)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: cycle must be a non-negative integer, or null when it cannot be determined'
    );
  }

  if (typeof s.updatedAt !== 'number' || s.updatedAt < 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: updatedAt must be a non-negative number'
    );
  }

  // Validate optional/expected fields
  if (s.health !== undefined && typeof s.health !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: health must be a string'
    );
  }

  if (s.closed !== undefined && typeof s.closed !== 'number') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: closed must be a number'
    );
  }

  if (s.required !== undefined && typeof s.required !== 'number') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: required must be a number'
    );
  }

  if (s.fraction !== undefined && (typeof s.fraction !== 'number' || s.fraction < 0 || s.fraction > 1)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: fraction must be a number between 0 and 1'
    );
  }

  if (s.spendUsd !== undefined && (typeof s.spendUsd !== 'number' || s.spendUsd < 0)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: spendUsd must be a non-negative number'
    );
  }

  if (s.verdict !== undefined && typeof s.verdict !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'Invalid progress snapshot: verdict must be a string'
    );
  }
}

/**
 * Create a normalized, validated progress snapshot.
 * @param {object} fields
 * @returns {object} frozen snapshot
 * @throws {BridgeError} if fields are invalid
 */
export function makeProgressSnapshot(fields) {
  validateProgressSnapshot(fields);

  return Object.freeze({
    sprintId: fields.sprintId,
    phase: fields.phase,
    cycle: fields.cycle,
    health: fields.health,
    closed: fields.closed,
    required: fields.required,
    fraction: fields.fraction,
    spendUsd: fields.spendUsd,
    verdict: fields.verdict,
    updatedAt: fields.updatedAt,
  });
}
