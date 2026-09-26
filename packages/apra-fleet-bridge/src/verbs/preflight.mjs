// fleet-bridge preflight -- verify every precondition a launch depends on,
// and report ALL of them in one pass (implementation-plan.md Part B, "the
// preflight verb"; build-log.md CP3's note that doltPullProbe()'s contract
// was still unpinned when this was written).
//
// -----------------------------------------------------------------------------
// WHY "RUN EVERY CHECK; NEVER SHORT-CIRCUIT"
// -----------------------------------------------------------------------------
// A pipeline operator gets ONE preflight run before committing a runner slot.
// Stopping at the first failure means a second, third, fourth run each surface
// one new problem -- exactly the failure mode this verb exists to prevent. So
// every check below always executes and always contributes one entry to
// `checks`, whether or not an earlier one failed. The one exception is
// documented below: the supervisor being genuinely UNREACHABLE, which makes
// every other supervisor-backed check meaningless (member-free needs the
// same `GET /api/members` connectivity `supervisor-health` just failed to
// get). member-vcs-provider is NOT in that set: it reads `member_detail`
// over the separate fleet MCP connection (`deps.fleetApi`), so a supervisor
// outage does not make it meaningless -- it runs independently and reports
// its own fleetApi failure locally, never via the supervisor throw path.
//
// -----------------------------------------------------------------------------
// THROW vs. REPORT
// -----------------------------------------------------------------------------
// A FAILED check is DATA -- `{ ok: false, ... }` in the returned `checks`
// array, never a throw. `runPreflight` throws a `BridgeError` (code
// PREFLIGHT_UNAVAILABLE) in exactly one situation: `supervisorClient.getHealth()`
// itself could not complete (the supervisor is down, unreachable, or the
// connection was refused). That is not "the supervisor is unhealthy" (which IS
// a normal, reported `supervisor-health` failure below) -- it is "we could not
// even ask the question", which also means `member-free` (needs
// `GET /api/members` against that same supervisor) cannot produce a
// meaningful answer either. Every other check's own collaborator failures (a
// `bd dolt pull` failure, a missing credential, an unresolvable git ref, an
// unreachable credential store, or member-vcs-provider's own `member_detail`
// lookup over the fleet MCP connection) are caught locally and reported as
// that ONE check's failure -- they never abort the run.
//
// -----------------------------------------------------------------------------
// INJECTED I/O -- NOTHING IS CONSTRUCTED IN THIS FILE
// -----------------------------------------------------------------------------
// Every collaborator (`supervisorClient`, `beads`, `fleetApi`, `git`, `fs`,
// `log`) arrives via `deps`; this module never imports `node:fs`, never reads
// `process.env`, never calls a real `fetch`. `deps.adapter` is accepted (the
// verb envelope is uniform across every verb -- ingest/launch also take one),
// but none of the nine checks below need it: "pr-capability" is a property of
// the GIT HOST (dispatched through the shared, already-tested
// `apra-fleet-se/fleet-sprint/vcs-module.mjs` capabilities() function -- a
// pure, deterministic parse-and-dispatch with no I/O of its own, safe to call
// directly rather than re-deriving host recognition here), not of the
// TRACKER adapter this package registers in `src/adapters/index.mjs`.
//
// -----------------------------------------------------------------------------
// THE CREDENTIALS CHECK NEVER READS A VALUE
// -----------------------------------------------------------------------------
// `credential_store_list` (surfaced here as `deps.fleetApi.credentialStoreList()`)
// returns names and metadata ONLY -- that is what makes checking for presence
// safe by construction (implementation-plan.md Part C). This module extracts
// exactly one field, `entry.name`, from each returned record, and never logs,
// stores, or forwards anything else from that response.
//
// -----------------------------------------------------------------------------
// WHY `opts.requiredCredentials` MUST ALREADY INCLUDE THE PAT SECRET NAME
// -----------------------------------------------------------------------------
// A real launch died on its first git operation because the wrong Azure
// DevOps PAT ended up on the member, and `fleet-bridge preflight` had just
// reported "credentials: ok -- No credential names were required for this
// launch" immediately beforehand. That message was TRUE and USELESS: nothing
// was ever asked to populate `opts.requiredCredentials` unless an operator
// remembered `--required-credentials`, so the one credential this launch
// actually depended on -- the `secretName`/`patSecretName` the bridge itself
// defaults to `fleet_bridge_azdevops_pat` (`bin/fleet-bridge.mjs`'s
// `resolveAdapterCoordinates`) -- was never in the set this check looked at.
// This module does not read config/flags/env itself (see the source-scan
// guard below) and never will -- `bin/fleet-bridge.mjs`'s `preflight` verb
// entry resolves that PAT secret name through the exact same
// flag/env/repo-config/default chain every other verb uses, and folds it
// into `opts.requiredCredentials` BEFORE calling `runPreflight`, additively
// with any explicit `--required-credentials`. `checkCredentials` below just
// has to trust that by the time `required` reaches it, it already names
// everything this launch depends on -- and it reports, by name, exactly
// which ones it verified, so "ok" is never vacuous again.
//
// ASCII only.

import path from 'node:path';
import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { parseToolJson } from '@apralabs/apra-fleet-client';
import { capabilities as resolveGitHostCapabilities } from '@apralabs/apra-fleet-se/fleet-sprint/vcs-module.mjs';

/** The two playbook files `deployer`/`integ-test-runner` expect a sprint to have produced. */
const PLAYBOOK_FILES = Object.freeze(['deploy.md', 'integ-test-playbook.md']);

/** Every check id this verb reports, in the order they run. Exported so a
 *  consumer (or a test) can assert completeness without re-typing the list. */
export const PREFLIGHT_CHECK_IDS = Object.freeze([
  'supervisor-health',
  'member-free',
  'member-vcs-provider',
  'credentials',
  'repo-and-base',
  'pr-capability',
  'beads-health',
  'playbooks',
  'spawn-direct-warning',
]);

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * `GET /api/health` -- every seam wired, none ending `:stub` (server.mjs's
 * `makeSeamStub()` names an unwired seam `${name}:stub`, and
 * `route('GET','/api/health')` echoes each seam's `.name` verbatim).
 * @param {any} health
 * @returns {{ ok: boolean, message: string }}
 */
function evaluateSupervisorHealth(health) {
  const seams = health && typeof health.seams === 'object' && health.seams !== null ? health.seams : {};
  const stubSeams = Object.entries(seams)
    .filter(([, v]) => typeof v === 'string' && v.endsWith(':stub'))
    .map(([k]) => k);
  const statusOk = !health || health.status === undefined || health.status === 'ok';

  if (!statusOk) {
    return { ok: false, message: `Supervisor reported status "${health.status}" instead of "ok".` };
  }
  if (stubSeams.length > 0) {
    return {
      ok: false,
      message: `Supervisor has ${stubSeams.length} unwired seam(s): ${stubSeams.join(', ')}.`,
    };
  }
  return { ok: true, message: 'Supervisor is healthy and every seam is wired.' };
}

/**
 * `GET /api/members` -- resolve the one member this launch would use.
 * Never throws: a connectivity failure here is reported as data by BOTH
 * `member-free` and `member-vcs-provider`, since they share this one fetch.
 * @param {{ getMembers: () => Promise<any> }} supervisorClient
 * @returns {Promise<{ members: any[], error: Error|null }>}
 */
async function fetchMembers(supervisorClient) {
  try {
    const result = await supervisorClient.getMembers();
    const members = Array.isArray(result) ? result : (Array.isArray(result?.members) ? result.members : []);
    return { members, error: null };
  } catch (err) {
    return { members: [], error: err };
  }
}

function findMember(members, memberName) {
  if (!memberName) return undefined;
  return members.find((m) => m && m.name === memberName);
}

/** @returns {{ ok: boolean, message: string }} */
function evaluateMemberFree(memberName, members, membersError) {
  if (membersError) {
    return { ok: false, message: `Could not fetch the member list: ${safeMessage(membersError)}` };
  }
  if (!memberName) {
    return { ok: false, message: 'No member was specified for this launch.' };
  }
  const record = findMember(members, memberName);
  if (!record) {
    return { ok: false, message: `Member "${memberName}" was not found in the fleet's member list.` };
  }
  if (record.reserved !== false) {
    return { ok: false, message: `Member "${memberName}" is already reserved${record.reservedBy ? ` (by sprint "${record.reservedBy}")` : ''}.` };
  }
  return { ok: true, message: `Member "${memberName}" exists and is free.` };
}

/**
 * `member_detail({ member_name, format: 'json' })` -- the ONE fleet-side
 * source that actually carries `vcsProvider`. `GET /api/members` (what
 * `fetchMembers`/`member-free` read) never returns this field at all, so
 * this check is deliberately NOT derived from that same member record --
 * see the file header for the defect this replaces.
 * @param {string|undefined} memberName
 * @param {{ memberDetail?: (args: object) => Promise<any> }|undefined} fleetApi
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function evaluateMemberVcsProvider(memberName, fleetApi) {
  if (!memberName) {
    return { ok: false, message: 'No member was specified for this launch.' };
  }
  if (!fleetApi || typeof fleetApi.memberDetail !== 'function') {
    return { ok: false, message: 'No fleetApi.memberDetail collaborator was injected; cannot verify the member\'s vcsProvider.' };
  }
  let detail;
  try {
    const raw = await fleetApi.memberDetail({ member_name: memberName, format: 'json' });
    detail = parseToolJson(raw);
  } catch (err) {
    return { ok: false, message: `Could not look up member "${memberName}" detail: ${safeMessage(err)}` };
  }
  const vcsProvider = detail && typeof detail.vcsProvider === 'string' ? detail.vcsProvider : '';
  if (vcsProvider.length === 0) {
    return { ok: false, message: `Member "${memberName}" has no registered vcsProvider.` };
  }
  return { ok: true, message: `Member "${memberName}" has vcsProvider "${vcsProvider}".` };
}

/**
 * `credential_store_list` -- verify every required credential NAME is
 * present. Reads names and metadata only; never a value (see file header).
 *
 * `required` is expected to already be the FULL set this launch depends on --
 * by the time `opts.requiredCredentials` reaches here, `bin/fleet-bridge.mjs`
 * has already folded in the resolved PAT `secretName` (default
 * `fleet_bridge_azdevops_pat`), additively with any explicit
 * `--required-credentials`. This function has no opinion on how that set was
 * built; it only reports presence/absence of whatever it is given, by name.
 * An empty `required` is still a legitimate (if now rare) input -- see the
 * file header's "vacuous pass" note for why it should no longer be the norm.
 * @param {string[]} required
 * @param {{ credentialStoreList?: () => Promise<any> }|undefined} fleetApi
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function checkCredentials(required, fleetApi) {
  const names = Array.isArray(required) ? required : [];
  if (names.length === 0) {
    return { ok: true, message: 'No credential names were required for this launch.' };
  }
  if (!fleetApi || typeof fleetApi.credentialStoreList !== 'function') {
    return { ok: false, message: 'No fleetApi.credentialStoreList collaborator was injected; cannot verify credential presence.' };
  }
  let storedNames;
  try {
    const raw = await fleetApi.credentialStoreList();
    const parsed = parseToolJson(raw);
    storedNames = Array.isArray(parsed)
      ? parsed.map((entry) => (entry && typeof entry.name === 'string' ? entry.name : null)).filter((n) => n !== null)
      : [];
  } catch (err) {
    return { ok: false, message: `Could not read the credential store: ${safeMessage(err)}` };
  }
  const missing = names.filter((n) => !storedNames.includes(n));
  if (missing.length > 0) {
    return { ok: false, message: `Missing credential name(s) in the store: ${missing.join(', ')}.` };
  }
  return { ok: true, message: `All required credential name(s) are present in the store: ${names.join(', ')}.` };
}

/**
 * Repo path exists (via injected `fs`) and the base branch resolves (via
 * injected `git`).
 * @param {{ localPath?: string, remoteUrl?: string }|undefined} repo
 * @param {string|undefined} baseBranch
 * @param {{ stat?: Function }|undefined} fs
 * @param {{ resolveRef?: Function }|undefined} git
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function checkRepoAndBase(repo, baseBranch, fs, git) {
  const localPath = repo && repo.localPath;
  if (!localPath) {
    return { ok: false, message: 'No repo.localPath was provided.' };
  }
  if (!fs || typeof fs.stat !== 'function') {
    return { ok: false, message: 'No fs collaborator was injected; cannot verify the repo path exists.' };
  }
  try {
    await fs.stat(localPath);
  } catch (err) {
    return { ok: false, message: `Repo path "${localPath}" does not exist or is not accessible: ${safeMessage(err)}` };
  }

  if (!baseBranch) {
    return { ok: false, message: 'No baseBranch was provided.' };
  }
  if (!git || typeof git.resolveRef !== 'function') {
    return { ok: false, message: 'No git collaborator was injected; cannot verify the base branch resolves.' };
  }
  try {
    await git.resolveRef(baseBranch, { cwd: localPath });
  } catch (err) {
    return { ok: false, message: `Base branch "${baseBranch}" does not resolve in "${localPath}": ${safeMessage(err)}` };
  }

  return { ok: true, message: `Repo path "${localPath}" exists and base branch "${baseBranch}" resolves.` };
}

/**
 * `remote recognised and can open a PR` -- dispatched through
 * vcs-module.mjs's `capabilities(remoteUrl)`, the single place a git remote
 * URL is parsed into a host and classified for PR capability (shared with
 * fleet-sprint's own Publish-PR gate, so this check can never drift from what
 * a real launch will actually see).
 * @param {{ remoteUrl?: string }|undefined} repo
 * @returns {{ ok: boolean, message: string }}
 */
function checkPrCapability(repo) {
  const remoteUrl = repo && repo.remoteUrl;
  const caps = resolveGitHostCapabilities(remoteUrl);
  if (caps.canOpenPullRequest) {
    return { ok: true, message: `Remote host "${caps.host}" is recognized and can open a pull request.` };
  }
  if (caps.hasRemote) {
    return {
      ok: false,
      message: `Remote host "${caps.host || '(unresolvable)'}" is not known to support opening a pull request.`,
    };
  }
  return { ok: false, message: 'No usable git remote URL was provided (repo.remoteUrl); pull-request capability cannot be determined.' };
}

/**
 * A `bd dolt pull` failure has two very different meanings: no dolt remote
 * configured at all (a fully-supported single-runner setup -- beads state
 * just stays local to this machine; carry-over publication to the tracker
 * goes via `bd ado push`, which needs no dolt remote), vs. a remote that IS
 * configured but the pull itself failed (a real problem). This asks beads
 * directly which case it is, via `bd dolt remote list --json` (empty array,
 * exit 0, when none are configured) -- a stable, direct signal, preferred
 * over pattern-matching the pull failure's error text (which is prose, not
 * a contract). If that lookup itself is unavailable or fails, this falls
 * back to the original, conservative behavior: report the pull failure as a
 * hard fail, since remote configuration could not be determined either way.
 * @param {{ doltRemoteList?: () => Promise<any> }|undefined} beads
 * @param {string} pullFailureMessage
 * @returns {Promise<{ ok: boolean, level: 'warn'|'fail', message: string }>}
 */
async function classifyBeadsHealthFailure(beads, pullFailureMessage) {
  if (beads && typeof beads.doltRemoteList === 'function') {
    try {
      const raw = await beads.doltRemoteList();
      const remotes = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.remotes) ? raw.remotes : null);
      if (Array.isArray(remotes) && remotes.length === 0) {
        return {
          ok: false,
          level: 'warn',
          message: 'No dolt remote is configured, so `bd dolt pull` cannot succeed -- this is fine for a '
            + 'single runner: beads state stays local to this machine, and carry-over publication to the '
            + 'tracker (`bd ado push`) is unaffected.',
        };
      }
    } catch {
      // Could not determine remote configuration either -- fall through to
      // the conservative pre-existing behavior below (report the pull
      // failure itself, as a hard fail).
    }
  }
  return { ok: false, level: 'fail', message: pullFailureMessage };
}

/**
 * `beads.doltPullProbe()` -- local beads-DB health probe. See
 * beads-client.mjs's own doc comment: this is a bare `bd dolt pull`,
 * returning `{ ok, stdout, stderr }` and throwing BEADS_FAILED on exec
 * failure. That exact contract is unpinned in any spec doc (build-log.md
 * CP3's open item) -- consumed as-is here: a thrown error OR a `{ ok: false }`
 * response are both treated as a failed check, never propagated. On failure,
 * `classifyBeadsHealthFailure` decides whether that failure is a `warn`
 * (no dolt remote configured) or a `fail` (a configured remote is broken).
 * @param {{ doltPullProbe?: () => Promise<any>, doltRemoteList?: () => Promise<any> }|undefined} beads
 * @returns {Promise<{ ok: boolean, level: 'warn'|'fail', message: string }>}
 */
async function checkBeadsHealth(beads) {
  if (!beads || typeof beads.doltPullProbe !== 'function') {
    return { ok: false, level: 'fail', message: 'No beads collaborator was injected; cannot probe dolt health.' };
  }
  try {
    const result = await beads.doltPullProbe();
    if (result && result.ok) {
      return { ok: true, level: 'fail', message: 'bd dolt pull succeeded.' };
    }
    return classifyBeadsHealthFailure(beads, 'bd dolt pull did not report success.');
  } catch (err) {
    return classifyBeadsHealthFailure(beads, `bd dolt pull failed: ${safeMessage(err)}`);
  }
}

/**
 * `deploy.md` / `integ-test-playbook.md` present in `playbooksDir` (defaults
 * to `repo.localPath`).
 * @param {string|undefined} playbooksDir
 * @param {{ localPath?: string }|undefined} repo
 * @param {{ stat?: Function }|undefined} fs
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function checkPlaybooks(playbooksDir, repo, fs) {
  const dir = playbooksDir || (repo && repo.localPath);
  if (!dir) {
    return { ok: false, message: 'No playbooksDir (or repo.localPath) was provided; cannot look for the sprint playbooks.' };
  }
  if (!fs || typeof fs.stat !== 'function') {
    return { ok: false, message: 'No fs collaborator was injected; cannot look for the sprint playbooks.' };
  }
  const missing = [];
  for (const file of PLAYBOOK_FILES) {
    try {
      // eslint-disable-next-line no-await-in-loop -- two files, sequential is clearer than Promise.all here.
      await fs.stat(path.join(dir, file));
    } catch {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    return { ok: false, message: `Missing playbook file(s) in "${dir}": ${missing.join(', ')}.` };
  }
  return { ok: true, message: `${PLAYBOOK_FILES.join(' and ')} are both present in "${dir}".` };
}

/** @returns {{ ok: boolean, message: string }} */
function checkSpawnDirect(spawn) {
  if (spawn === 'direct') {
    return {
      ok: false,
      message: '`--spawn direct` was requested: the sprint runs attached to this process instead of via the supervisor\'s detached child-per-sprint model.',
    };
  }
  return {
    ok: true,
    message: '`--spawn direct` was not requested; the sprint launches via the supervisor\'s normal detached model.',
  };
}

/** Remedy text, one per check id -- kept as data next to the ids they belong
 *  to, so a new check can never ship without one. */
const REMEDIES = Object.freeze({
  'supervisor-health':
    'Start or restart the fleet supervisor (`fleet-se serve`) so every seam is wired; a ":stub" seam means it booted without its real collaborator injected.',
  'member-free':
    'Register the member (`register_member`), choose a different --member, or free the current reservation (stop its sprint, or `force_release`) before relaunching.',
  'member-vcs-provider':
    'Set the member\'s VCS provider before launching -- run `provision_vcs_auth` with an explicit `provider`, or `update_member` to set `vcsProvider` directly. The engine has no default and hard-errors without one.',
  credentials:
    'Deposit the missing credential name(s) with `apra-fleet secret --set <name> --persist` (or `credential_store_set`) before launching. Never paste a credential value into this pipeline.',
  'repo-and-base':
    'Verify `repo.localPath` points at a checked-out clone on this runner, and that `baseBranch` exists and is fetched (or fetch it, or correct the parameter).',
  'pr-capability':
    'WARNING: this remote cannot open a pull request. The sprint will still run for up to two days and then DECLINE TO RAISE A PR. Point repo.remoteUrl at a supported host (GitHub, Azure DevOps, Bitbucket) before launching if a PR is required.',
  'beads-health':
    'If a dolt remote IS configured (fail): run `bd dolt pull` manually on this runner to diagnose; verify the '
    + 'configured remote and the local beads DB are both healthy before launching. If NO dolt remote is '
    + 'configured (warn): no action needed for a single runner -- this is expected when the beads DB was '
    + 'bootstrapped locally and never pushed; configure a remote only if this beads DB needs to be shared '
    + 'across machines.',
  playbooks:
    'Generate the missing playbook(s) (see the sprint plan template) before relying on the deployer/integ-test-runner agents; their absence just means those roles have nothing to follow yet.',
  'spawn-direct-warning':
    'Confirm `--spawn direct` is intentional (e.g. local debugging): it holds this process for the sprint\'s full duration instead of returning control to the supervisor\'s detached model.',
});

/**
 * Run every precondition check for a launch and report all of them in one
 * pass. See the file header for the throw-vs-report rule.
 *
 * @param {{
 *   member?: string,
 *   repo?: { remoteUrl?: string, localPath?: string },
 *   baseBranch?: string,
 *   requiredCredentials?: string[],   - expected to already include the
 *     resolved PAT secretName; the caller (bin/fleet-bridge.mjs) folds that
 *     in before calling runPreflight -- see the file header's "vacuous pass"
 *     note. This function does not derive it itself.
 *   playbooksDir?: string,
 *   spawn?: string,
 * }} [opts]
 * @param {{
 *   supervisorClient: { getHealth: () => Promise<any>, getMembers: () => Promise<any> },
 *   beads?: { doltPullProbe?: () => Promise<any>, doltRemoteList?: () => Promise<any> },
 *   adapter?: any,
 *   fleetApi?: { credentialStoreList?: () => Promise<any>, memberDetail?: (args: object) => Promise<any> },
 *   git?: { resolveRef?: (ref: string, opts: { cwd: string }) => Promise<any> },
 *   fs?: { stat?: (path: string) => Promise<any> },
 *   log?: (msg: string) => void,
 * }} deps
 * @returns {Promise<{
 *   ok: boolean,
 *   checks: Array<{ id: string, level: 'fail'|'warn', ok: boolean, message: string, remedy: string }>,
 *   warnings: string[],
 * }>}
 * @throws {BridgeError} PREFLIGHT_UNAVAILABLE -- ONLY when the supervisor
 *   itself could not be reached to answer `GET /api/health`, which makes
 *   every other supervisor-backed check meaningless.
 */
export async function runPreflight(opts = {}, deps = {}) {
  const { supervisorClient, beads, fleetApi, git, fs } = deps;
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  if (!supervisorClient || typeof supervisorClient.getHealth !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'runPreflight requires deps.supervisorClient with a getHealth() method',
      { param: 'supervisorClient' }
    );
  }

  let health;
  try {
    health = await supervisorClient.getHealth();
  } catch (err) {
    // The one legitimate throw: connectivity itself is broken, so every
    // other supervisor-backed check (member-free, member-vcs-provider) would
    // be equally meaningless. See the file header.
    throw new BridgeError(
      BRIDGE_ERROR_CODES.PREFLIGHT_UNAVAILABLE,
      `preflight could not reach the supervisor to run any check: ${safeMessage(err)}. Confirm the supervisor is running ("fleet-se serve") and reachable before retrying.`,
      { cause: err && err.code ? err.code : undefined }
    );
  }

  const checks = [];
  function record(id, level, evaluation) {
    log(`[preflight] ${id}: ${evaluation.ok ? 'ok' : level === 'warn' ? 'warn' : 'fail'} -- ${evaluation.message}`);
    checks.push({ id, level, ok: evaluation.ok, message: evaluation.message, remedy: REMEDIES[id] });
  }

  // 1. supervisor-health -- already fetched above (that fetch is the one
  // throw-worthy step); evaluate what it reported.
  record('supervisor-health', 'fail', evaluateSupervisorHealth(health));

  // 2. member-free -- GET /api/members. A failure fetching the member list
  // is reported as this check's own failure, never thrown: it does not make
  // supervisor-health, member-vcs-provider, credentials, repo-and-base,
  // pr-capability, beads-health, or playbooks meaningless.
  const { members, error: membersError } = await fetchMembers(supervisorClient);
  record('member-free', 'fail', evaluateMemberFree(opts.member, members, membersError));

  // 3. member-vcs-provider -- a SEPARATE source (member_detail over the
  // fleet MCP connection), not the member list above. See
  // evaluateMemberVcsProvider's own doc comment for why.
  record('member-vcs-provider', 'fail', await evaluateMemberVcsProvider(opts.member, fleetApi));

  // 4. credentials -- names only, never a value.
  record('credentials', 'fail', await checkCredentials(opts.requiredCredentials, fleetApi));

  // 5. repo-and-base
  record('repo-and-base', 'fail', await checkRepoAndBase(opts.repo, opts.baseBranch, fs, git));

  // 6. pr-capability -- warn, loudly.
  record('pr-capability', 'warn', checkPrCapability(opts.repo));

  // 7. beads-health -- level is NOT a literal here, unlike every other check:
  // a dolt-pull failure with no remote configured is a `warn` (fine for a
  // single runner), while a configured-but-broken remote stays a `fail`.
  // See checkBeadsHealth/classifyBeadsHealthFailure.
  const beadsHealthEval = await checkBeadsHealth(beads);
  record('beads-health', beadsHealthEval.level, beadsHealthEval);

  // 8. playbooks -- warn.
  record('playbooks', 'warn', await checkPlaybooks(opts.playbooksDir, opts.repo, fs));

  // 9. spawn-direct-warning -- warn.
  record('spawn-direct-warning', 'warn', checkSpawnDirect(opts.spawn));

  const ok = checks.every((c) => c.ok || c.level === 'warn');
  const warnings = checks.filter((c) => c.level === 'warn' && !c.ok).map((c) => c.message);

  return { ok, checks, warnings };
}

export default runPreflight;
