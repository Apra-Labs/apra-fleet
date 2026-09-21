/**
 * Azure DevOps bridge adapter (fleet-bridge-implementation-plan.md Part B/C).
 *
 * `ingest`/`publishCarryOver` are the shared native-beads-sync implementation
 * (./lib/native-beads-sync.mjs) parameterised with namespace 'ado' -- this is
 * what makes a future GitHub adapter nearly free: it would be this same file
 * with the namespace string and the REST-comment/build-status bodies swapped.
 *
 * ---------------------------------------------------------------------------
 * PART C COMPLIANCE -- READ BEFORE ADDING A FIELD TO THIS FILE
 * ---------------------------------------------------------------------------
 * No organisation, project, storage account, container or agent pool may
 * appear here as a literal or as a fallback default. Every one of those
 * values is caller-supplied (a pipeline parameter, forwarded through
 * `resolveRequest`'s `env`); a missing one throws CONFIG_MISSING naming both
 * the value and the pipeline parameter that supplies it -- never a guess.
 * test/adapters.test.mjs source-scans this exact file for a literal Azure
 * DevOps org URL segment to keep this honest.
 *
 * The one deliberate exception is `DEFAULT_ADO_PAT_SECRET_NAME`: a stored
 * CREDENTIAL NAME, not an organisation/project/storage value. It is
 * deliberately NOT the same name as the engine's own default
 * (`azdevops_pat_secret_name`, default `azdevops_pat` --
 * implementation-plan.md Part C, "Remaining credentials") -- this operator's
 * `azdevops_pat` credential name is already taken by an unrelated system, so
 * this bridge's own default is `fleet_bridge_azdevops_pat` instead. The two
 * consumers (this adapter's own `bd ado pull/push`/REST comments, and the
 * sprint engine's `provision_vcs_auth`) are configured SEPARATELY: see
 * contracts.mjs's `patSecretName` SprintRequest field, which threads this
 * bridge's own choice through to the engine's `azdevops_pat_secret_name` arg
 * so the two can never silently diverge. The pipeline may still override this
 * adapter's own name via `adoPatSecretName`; this adapter never resolves the
 * secret's VALUE, only ever forwards its NAME.
 *
 * `comment`/`setBuildStatus` are declared-but-minimal: they build the REST
 * request description and hand it to an INJECTED transport
 * (`deps.restClient`), never a real `fetch` -- every module in this package
 * takes its I/O as an injected dependency (implementation-plan.md
 * "Verification").
 *
 * ASCII only.
 */

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { validateSprintRequest } from '../contracts.mjs';
import { createNativeBeadsSync, readExternalRef, unwrapShowRow } from './lib/native-beads-sync.mjs';

/** See the Part C compliance note above: a credential NAME default, never an
 *  organisation/project/storage/pool value. Deliberately NOT 'azdevops_pat'
 *  (the engine's own default, and an operator-assigned name already taken by
 *  an unrelated system) -- this is the bridge's OWN default, independent of
 *  the engine's. */
const DEFAULT_ADO_PAT_SECRET_NAME = 'fleet_bridge_azdevops_pat';

/**
 * The ORDER in which this adapter picks a work item type when the pipeline
 * configured none -- an ordering over candidates, never a claim that any of
 * them exists. See resolveWorkItemType() for the rule, and why a name the
 * live project did not just report is never chosen.
 *
 * The order runs "smallest unit of trackable work first", per process
 * template: Basic's `Issue`, then `Task` (Basic/Agile), then the
 * story-shaped types of Agile and Scrum. A carry-over item is a leftover
 * piece of work, so the smaller container is the better default.
 */
const WORK_ITEM_TYPE_PREFERENCE = Object.freeze([
  'Issue',
  'Task',
  'User Story',
  'Product Backlog Item',
  'Requirement',
]);

/** @param {any} value @returns {string} */
function truncate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return String(value);
  return text.length > 400 ? `${text.slice(0, 400)}... (truncated)` : text;
}

/**
 * Turns a rest-client.mjs `{ status, body }` into the parsed JSON payload,
 * failing loudly on anything that is not a 2xx with a JSON body.
 *
 * WHY THIS THROWS, unlike comment()'s path: a comment is a reporting
 * side-effect the facade deliberately swallows, but a failed CREATE means
 * the carry-over item does not exist. Swallowing it is precisely the
 * silent-success failure this change exists to remove -- beads' "Warning:
 * ...; exit 0" is the shape being replaced here, so this must not reproduce
 * it.
 *
 * @param {{ status: number|null, body: string }} response
 * @param {string} what for the message
 * @returns {any}
 */
function parseRestJson(response, what) {
  const status = response && response.status;
  const body = response && typeof response.body === 'string' ? response.body : '';
  if (typeof status !== 'number' || status < 200 || status >= 300) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED,
      `azure-devops adapter: REST call to ${what} failed with status ${status === null || status === undefined ? 'unknown' : status}: ${truncate(body)}`,
      { status: status === undefined ? null : status }
    );
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED,
      `azure-devops adapter: REST call to ${what} returned status ${status} but a body that is not JSON: ${truncate(body)}`,
      { status }
    );
  }
}

/**
 * The env keys this adapter requires from `resolveRequest`'s pipeline input,
 * paired with the pipeline parameter name to name in a CONFIG_MISSING error
 * (implementation-plan.md Part C: "Parameters the Azure DevOps template
 * exposes (all required unless noted)"). Kept as data, not a chain of
 * `if`s, so the missing-value error message and the required-field list can
 * never drift apart.
 */
const REQUIRED_ADO_CONFIG = Object.freeze([
  { key: 'adoOrgUrl', param: 'adoOrgUrl' },
  { key: 'adoProject', param: 'adoProject' },
  { key: 'repoPath', param: 'repoPath' },
  { key: 'agentPool', param: 'agentPool' },
  { key: 'member', param: 'member' },
  { key: 'targetBranch', param: 'targetBranch' },
  { key: 'baseBranch', param: 'baseBranch' },
  { key: 'workItems', param: 'workItems' },
]);

/**
 * @param {object} env
 * @param {string} key
 * @param {string} param
 * @returns {any} the present value.
 * @throws {BridgeError} CONFIG_MISSING naming both `key` and `param`.
 */
function requireConfigValue(env, key, param) {
  const value = env[key];
  const missing = value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
  if (missing) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      `azure-devops adapter: missing required value "${key}" -- supply it via the pipeline parameter "${param}"`,
      { key, pipelineParameter: param }
    );
  }
  return value;
}

function trimTrailingSlash(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

/**
 * Maps the Azure DevOps pipeline's platform-specific env (parameter values)
 * to a neutral SprintRequest, enforcing this adapter's own required set
 * (REQUIRED_ADO_CONFIG above) before handing the SprintRequest-shaped subset
 * to contracts.mjs's validateSprintRequest for the shared shape/pattern
 * checks. Every required value is caller-supplied -- see the Part C note at
 * the top of this file.
 *
 * @param {object} env - pipeline parameter values (already resolved by the
 *   caller; this function never reads process.env itself).
 * @returns {object} frozen { sprintRequest, adoOrgUrl, adoProject, agentPool,
 *   adoPatSecretName, awaitPlanTimeout?, maxCarryOver?, viewerPort?,
 *   blobAccountUrl?, blobContainer? }
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
function resolveRequest(env) {
  const e = env && typeof env === 'object' ? env : {};

  for (const { key, param } of REQUIRED_ADO_CONFIG) {
    requireConfigValue(e, key, param);
  }

  const workItems = Array.isArray(e.workItems)
    ? e.workItems
    : (typeof e.workItems === 'string'
      ? e.workItems.split(',').map((s) => s.trim()).filter(Boolean)
      : e.workItems);

  const repo = (e.repoPath !== undefined || e.repoRemoteUrl !== undefined)
    ? { remoteUrl: e.repoRemoteUrl, localPath: e.repoPath }
    : undefined;

  const sprintRequest = validateSprintRequest({
    platform: 'azure-devops',
    repo,
    workItems,
    targetBranch: e.targetBranch,
    baseBranch: e.baseBranch,
    goal: e.goal,
    member: e.member,
    maxCycles: e.maxCycles,
    budget: e.budget,
    requirementsFile: e.requirementsFile,
    triggeredBy: e.triggeredBy,
    runUrl: e.runUrl,
  });

  return Object.freeze({
    sprintRequest,
    adoOrgUrl: e.adoOrgUrl,
    adoProject: e.adoProject,
    agentPool: e.agentPool,
    adoPatSecretName: e.adoPatSecretName || DEFAULT_ADO_PAT_SECRET_NAME,
    // OPTIONAL, and deliberately NOT defaulted to a type name -- see
    // resolveWorkItemType() below. Absent, the type is discovered from the
    // project itself; it is never assumed.
    adoWorkItemType: e.adoWorkItemType,
    awaitPlanTimeout: e.awaitPlanTimeout,
    maxCarryOver: e.maxCarryOver,
    viewerPort: e.viewerPort,
    blobAccountUrl: e.blobAccountUrl,
    blobContainer: e.blobContainer,
  });
}

/**
 * `ingest`/`publishCarryOver` delegate to the shared native-beads-sync
 * implementation, parameterised with namespace 'ado'. `deps.beads` is the
 * injected beads client (src/beads-client.mjs's createBeadsClient output) --
 * this module never constructs or imports one itself. `deps.beads` must
 * expose `list`/`show` in addition to `trackerPull`/`trackerPush`: both are
 * used for the LOCAL, credential-free read-back `createNativeBeadsSync`
 * performs after each dispatch. See that module's PINNED CONTRACTS comment
 * for the exact return shapes this adapter's `ingest`/`publishCarryOver`
 * therefore also return.
 */
async function ingest(opts, deps) {
  const beads = deps && deps.beads;
  const sync = createNativeBeadsSync({ namespace: 'ado', beads });
  return sync.ingest(opts);
}

/**
 * ---------------------------------------------------------------------------
 * BEADS CANNOT CREATE HERE -- why carry-over splits into two paths
 * ---------------------------------------------------------------------------
 * `bd ado push` CREATES a work item with `System.State` hardcoded to 'New'.
 * 'New' is an Agile/Scrum initial state. This project runs the BASIC process
 * template, whose states are To Do / Doing / Done, so every creation 400s
 * with "The field 'State' contains the value 'New' that is not in the list
 * of supported values" -- and beads reports that as a *Warning* and exits 0,
 * so the bridge saw four successful pushes and published nothing. Verified
 * live.
 *
 * This is the same class of assumption docs/setup.md's "A note on work item
 * types" already forbids this package from making, one level down: not a
 * type NAME this time but a STATE VOCABULARY, and it lives in beads, which
 * we do not own and (`bd config` has no state-mapping key; `--states` is
 * only a filter) cannot configure out of it.
 *
 * So creation moves here, onto the member-dispatched REST seam, and the
 * split is by whether the bead is already linked:
 *   - external_ref ALREADY stamped -> the work item exists. Hand the bead to
 *     `bd ado push` exactly as before: that is the UPDATE path, it does not
 *     create, so beads' initial-state assumption never comes into play, and
 *     beads stays the owner of field mapping for everything it can already
 *     do. This is also what makes a re-run idempotent: a second finalize
 *     takes this branch and creates nothing.
 *   - no external_ref -> createWorkItem() below (REST, no System.State),
 *     then the resulting tracker URL is stamped back onto the bead with
 *     `bd update --external-ref` so the NEXT run takes the branch above.
 *
 * `dryRun` touches neither path: the already-linked beads go to `bd ado push
 * --dry-run` as before, and the unlinked ones are reported as "would be
 * created" with nothing sent.
 *
 * @param {{ beadIds?: string[], secretName: string, dryRun?: boolean }} opts
 * @param {{ beads: object, restClient?: Function, resolved?: object, log?: Function }} deps
 * @returns {Promise<Array<{ beadId: string, externalRef: string|null, pushed: boolean, created: boolean }>>}
 */
async function publishCarryOver(opts, deps) {
  const { beadIds, secretName, dryRun } = opts || {};
  const d = deps || {};
  const beads = d.beads;
  const log = typeof d.log === 'function' ? d.log : () => {};
  const sync = createNativeBeadsSync({ namespace: 'ado', beads });

  const idList = Array.isArray(beadIds) ? beadIds : [];
  if (idList.length === 0) {
    // The empty case keeps its old behaviour exactly.
    return sync.publishCarryOver({ beadIds: idList, secretName, dryRun });
  }

  const linked = [];
  const unlinked = [];
  for (const beadId of idList) {
    // eslint-disable-next-line no-await-in-loop -- ordered LOCAL reads
    // against the same beads DB; nothing to gain by parallelizing.
    const ref = await readExternalRef(beads, beadId);
    (ref === null ? unlinked : linked).push(beadId);
  }

  const byId = new Map();

  if (linked.length > 0) {
    const pushed = await sync.publishCarryOver({ beadIds: linked, secretName, dryRun });
    for (const row of pushed) byId.set(row.beadId, { ...row, created: false });
  }

  if (unlinked.length > 0) {
    const created = await createUnlinked(
      unlinked,
      { secretName, dryRun },
      { beads, restClient: d.restClient, resolved: d.resolved, log }
    );
    for (const row of created) byId.set(row.beadId, row);
  }

  // One entry per input beadId, in input order -- the pinned contract.
  return idList.map((beadId) => byId.get(beadId)
    || { beadId, externalRef: null, pushed: false, created: false });
}

/**
 * The create path of publishCarryOver: one REST work item per bead with no
 * `external_ref` yet, then `bd update --external-ref` to link it. This
 * THROWS on failure rather than returning a failed row -- verbs/finalize.mjs
 * already calls publishCarryOver one bead at a time precisely so a throw is
 * isolated to that bead and recorded as its `error`.
 *
 * @param {string[]} beadIds
 * @param {{ secretName: string, dryRun?: boolean }} opts
 * @param {{ beads: object, restClient?: Function, resolved?: object, log: Function }} deps
 */
async function createUnlinked(beadIds, { secretName, dryRun }, { beads, restClient, resolved, log }) {
  if (dryRun) {
    log(`[azure-devops] dry-run: ${beadIds.length} carry-over bead(s) carry no external_ref and WOULD BE CREATED as new work items: ${beadIds.join(', ')}`);
    return beadIds.map((beadId) => ({ beadId, externalRef: null, pushed: false, created: false }));
  }

  if (!beads || typeof beads.update !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'azure-devops adapter: creating a carry-over work item requires an injected beads client exposing update() -- the tracker ref has to be stamped back onto the bead, or the next run would create a duplicate',
      {}
    );
  }

  // Resolved ONCE for the whole batch: the type is a property of the
  // project, not of the bead, and discovering it costs a REST round trip.
  const workItemType = await resolveWorkItemType({ resolved, secretName }, { restClient, log });

  const results = [];
  for (const beadId of beadIds) {
    // eslint-disable-next-line no-await-in-loop -- ordered; each bead is
    // created and linked before the next one starts, so an interrupted run
    // leaves every already-created item linked and therefore not duplicated.
    const row = unwrapShowRow(await beads.show(beadId), beadId);
    if (!row) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED,
        `azure-devops adapter: bead "${beadId}" was selected for carry-over but bd show returned no row for it`,
        { beadId }
      );
    }
    // eslint-disable-next-line no-await-in-loop
    const item = await createWorkItem({
      resolved,
      secretName,
      workItemType,
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : beadId,
      description: typeof row.description === 'string' ? row.description : '',
    }, { restClient });

    // eslint-disable-next-line no-await-in-loop
    await beads.update(beadId, { externalRef: item.externalRef });
    // The stamp is read BACK rather than trusted: `pushed` means "the bead
    // is now linked", and only the beads DB can answer that.
    // eslint-disable-next-line no-await-in-loop
    const confirmed = await readExternalRef(beads, beadId);
    log(`[azure-devops] carry-over bead ${beadId} created as work item ${item.workItemId}`);
    results.push({ beadId, externalRef: confirmed, pushed: confirmed !== null, created: true });
  }
  return results;
}

/**
 * ---------------------------------------------------------------------------
 * WORK ITEM TYPE -- CONFIGURED, ELSE DISCOVERED, NEVER ASSUMED
 * ---------------------------------------------------------------------------
 * docs/setup.md's "A note on work item types" is the rule: the bridge never
 * assumes a work item type exists. `Task` exists on Basic and Agile but not
 * on Scrum; `Issue` on Basic only; `User Story` on Agile only; `Product
 * Backlog Item` on Scrum only; a custom process can rename all of them.
 * Hardcoding any one of those names is the same mistake as hardcoding
 * `System.State = 'New'`, just with a different 400 at the end of it.
 *
 * So, in order:
 *   1. `resolved.adoWorkItemType`, when the pipeline configured one. It is
 *      still VALIDATED against the project's real type list rather than
 *      taken on trust -- a typo'd type would otherwise 400 per bead at
 *      create time instead of failing once, up front, with the list of what
 *      this project actually offers.
 *   2. Otherwise, discovered: GET _apis/wit/workitemtypes and take the
 *      first name in PREFERENCE order that the PROJECT ACTUALLY REPORTS.
 *      The preference list is an ordering over candidates, not a claim that
 *      any of them exists -- nothing is ever chosen that the project did
 *      not just name.
 *   3. If the project reports none of them, this FAILS -- naming every type
 *      the project does offer and the parameter to set. Never a silent
 *      skip, and never a guess that 400s later.
 *
 * @param {{ resolved?: object, secretName?: string }} opts
 * @param {{ restClient?: Function, log?: Function }} deps
 * @returns {Promise<string>}
 */
export async function resolveWorkItemType({ resolved, secretName } = {}, deps) {
  assertRestClient(deps);
  const r = resolved || {};
  requireConfigValue(r, 'adoOrgUrl', 'adoOrgUrl');
  requireConfigValue(r, 'adoProject', 'adoProject');
  const log = deps && typeof deps.log === 'function' ? deps.log : () => {};
  const name = secretName || r.adoPatSecretName || DEFAULT_ADO_PAT_SECRET_NAME;

  const url = `${trimTrailingSlash(r.adoOrgUrl)}/${encodeURIComponent(r.adoProject)}/_apis/wit/workitemtypes?api-version=7.1`;
  const response = await deps.restClient({ method: 'GET', url, secretName: name });
  const payload = parseRestJson(response, 'list work item types');
  const available = Array.isArray(payload && payload.value)
    ? payload.value.map((t) => t && t.name).filter((n) => typeof n === 'string' && n.length > 0)
    : [];

  if (available.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      `azure-devops adapter: project "${r.adoProject}" reported no work item types, so no carry-over item can be created -- check the PAT's Work Items (read) scope`,
      { adoProject: r.adoProject }
    );
  }

  const configured = r.adoWorkItemType;
  if (typeof configured === 'string' && configured.length > 0) {
    if (!available.includes(configured)) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `azure-devops adapter: configured work item type "${configured}" does not exist in project "${r.adoProject}" -- it offers: ${available.join(', ')}. Set the pipeline parameter "adoWorkItemType" to one of those.`,
        { configured, available, pipelineParameter: 'adoWorkItemType' }
      );
    }
    return configured;
  }

  const chosen = WORK_ITEM_TYPE_PREFERENCE.find((candidate) => available.includes(candidate));
  if (!chosen) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      `azure-devops adapter: project "${r.adoProject}" offers none of the work item types this adapter can pick unaided (${WORK_ITEM_TYPE_PREFERENCE.join(', ')}) -- it offers: ${available.join(', ')}. Set the pipeline parameter "adoWorkItemType" explicitly.`,
      { available, preference: [...WORK_ITEM_TYPE_PREFERENCE], pipelineParameter: 'adoWorkItemType' }
    );
  }
  log(`[azure-devops] no adoWorkItemType configured -- using "${chosen}", chosen from the types project "${r.adoProject}" actually reports`);
  return chosen;
}

/**
 * ---------------------------------------------------------------------------
 * CREATE A WORK ITEM -- AND WHY IT SETS NO STATE
 * ---------------------------------------------------------------------------
 * The patch document carries `System.Title` and `System.Description` and
 * NOTHING ELSE. In particular it does not set `System.State`, and that
 * omission is the point: Azure DevOps then applies the work item type's OWN
 * initial state, whatever the project's process template says that is --
 * `To Do` on Basic, `New` on Agile, `New` on Scrum, anything at all on a
 * custom process. Setting no state is the only choice correct on every
 * process template, which is the standard this package already holds itself
 * to for work item TYPES (docs/setup.md, "A note on work item types")
 * applied to the state vocabulary. Verified live: the work items in the e2e
 * project were created by a POST setting only these two fields, and Azure
 * DevOps defaulted their state correctly.
 *
 * Content type is `application/json-patch+json` -- this endpoint accepts
 * nothing else (see rest-client.mjs's note on why that is a parameter).
 *
 * @param {{ resolved: object, secretName?: string, workItemType: string, title: string, description?: string }} opts
 * @param {{ restClient: Function }} deps
 * @returns {Promise<{ workItemId: number|string, externalRef: string }>}
 */
export async function createWorkItem(opts, deps) {
  assertRestClient(deps);
  const { resolved, secretName, workItemType, title, description } = opts || {};
  const r = resolved || {};
  requireConfigValue(r, 'adoOrgUrl', 'adoOrgUrl');
  requireConfigValue(r, 'adoProject', 'adoProject');
  if (typeof workItemType !== 'string' || workItemType.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'azure-devops adapter: createWorkItem() requires opts.workItemType -- resolveWorkItemType() supplies it; it is never defaulted to a type name',
      { field: 'workItemType' }
    );
  }
  if (typeof title !== 'string' || title.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `azure-devops adapter: createWorkItem() requires a non-empty opts.title, got ${JSON.stringify(title)}`,
      { field: 'title', value: title }
    );
  }
  const name = secretName || r.adoPatSecretName || DEFAULT_ADO_PAT_SECRET_NAME;

  // The '$' on the type segment is Azure DevOps's own "create of this type"
  // syntax on the workitems collection, not an escape.
  const url = `${trimTrailingSlash(r.adoOrgUrl)}/${encodeURIComponent(r.adoProject)}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}?api-version=7.1`;

  const patch = [{ op: 'add', path: '/fields/System.Title', value: title }];
  if (typeof description === 'string' && description.length > 0) {
    patch.push({ op: 'add', path: '/fields/System.Description', value: description });
  }

  const response = await deps.restClient({
    method: 'POST',
    url,
    secretName: name,
    contentType: 'application/json-patch+json',
    body: patch,
  });
  const payload = parseRestJson(response, `create a "${workItemType}" work item`);
  const workItemId = payload && payload.id;
  if (workItemId === undefined || workItemId === null || workItemId === '') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED,
      `azure-devops adapter: work item create returned no id -- response body: ${truncate(response && response.body)}`,
      { status: response && response.status }
    );
  }

  // The human-facing URL, preferred from the response's own _links so the
  // ref is whatever Azure DevOps itself calls this item; the constructed
  // form is the fallback. Either way it ENDS in the work item id, which is
  // what native-beads-sync.mjs's normalizeRefIdentity() matches on.
  const htmlHref = payload && payload._links && payload._links.html && payload._links.html.href;
  const externalRef = typeof htmlHref === 'string' && htmlHref.length > 0
    ? htmlHref
    : `${trimTrailingSlash(r.adoOrgUrl)}/${encodeURIComponent(r.adoProject)}/_workitems/edit/${workItemId}`;

  return { workItemId, externalRef };
}

function capabilities() {
  return {
    nativeBeadsSync: true,
    canCreateWorkItem: true,
    canComment: true,
    maxJobMinutes: null,
    supportsAttached: true,
  };
}

function assertRestClient(deps) {
  if (!deps || typeof deps.restClient !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'azure-devops adapter: this call requires an injected REST transport (deps.restClient) -- this module never reaches for a real fetch',
      {}
    );
  }
}

/**
 * Declared-but-minimal: adds a comment to an Azure DevOps work item. Builds
 * the request description (method/url/secretName/body) from caller-supplied
 * coordinates and hands it to `deps.restClient` -- see the file-level doc
 * comment. `resolved` is this adapter's own resolveRequest() output (or an
 * equivalent object carrying adoOrgUrl/adoProject/adoPatSecretName).
 *
 * @param {{ resolved: object, workItemId: string|number, body: string }} opts
 * @param {{ restClient: (req: object) => Promise<any> }} deps
 */
async function comment(opts, deps) {
  assertRestClient(deps);
  const { resolved, workItemId, body } = opts || {};
  const r = resolved || {};
  requireConfigValue(r, 'adoOrgUrl', 'adoOrgUrl');
  requireConfigValue(r, 'adoProject', 'adoProject');
  if (workItemId === undefined || workItemId === null || workItemId === '') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `azure-devops adapter: comment() requires opts.workItemId, got ${JSON.stringify(workItemId)}`,
      { field: 'workItemId', value: workItemId }
    );
  }
  const secretName = r.adoPatSecretName || DEFAULT_ADO_PAT_SECRET_NAME;
  const url = `${trimTrailingSlash(r.adoOrgUrl)}/${encodeURIComponent(r.adoProject)}/_apis/wit/workItems/${encodeURIComponent(String(workItemId))}/comments?api-version=7.1-preview.3`;
  return deps.restClient({
    method: 'POST',
    url,
    secretName,
    body: { text: body },
  });
}

/**
 * Declared-but-minimal: sets a build/pipeline status. Same shape as
 * `comment` -- builds the request, delegates I/O to `deps.restClient`.
 *
 * @param {{ resolved: object, state: string, description?: string, targetUrl?: string, context?: string }} opts
 * @param {{ restClient: (req: object) => Promise<any> }} deps
 */
async function setBuildStatus(opts, deps) {
  assertRestClient(deps);
  const { resolved, state, description, targetUrl, context } = opts || {};
  const r = resolved || {};
  requireConfigValue(r, 'adoOrgUrl', 'adoOrgUrl');
  requireConfigValue(r, 'adoProject', 'adoProject');
  if (state === undefined || state === null || state === '') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'azure-devops adapter: setBuildStatus() requires opts.state',
      { field: 'state', value: state }
    );
  }
  if (typeof state !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `azure-devops adapter: setBuildStatus() requires opts.state to be a string, got ${typeof state} (${JSON.stringify(state)})`,
      { field: 'state', value: state, expectedType: 'string', actualType: typeof state }
    );
  }
  const secretName = r.adoPatSecretName || DEFAULT_ADO_PAT_SECRET_NAME;
  const url = `${trimTrailingSlash(r.adoOrgUrl)}/${encodeURIComponent(r.adoProject)}/_apis/build/builds?api-version=7.1-preview.7`;
  return deps.restClient({
    method: 'POST',
    url,
    secretName,
    body: {
      state,
      description,
      targetUrl,
      context: context || { name: 'fleet-bridge', genre: 'continuous-integration' },
    },
  });
}

export const AzureDevOpsBridgeAdapter = Object.freeze({
  name: 'azure-devops',
  capabilities,
  resolveRequest,
  ingest,
  publishCarryOver,
  comment,
  setBuildStatus,
  createWorkItem,
});

export default AzureDevOpsBridgeAdapter;
