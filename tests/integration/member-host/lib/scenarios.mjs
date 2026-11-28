// Pure scenario planning for the member-host upgrade passes: the pass list,
// the expected outcome per pass, the pre/post snapshot comparison that proves a
// refusal changed nothing, baseline resolution (reusing fresh-install's
// baseline logic) and the checklist the shared verdict logic evaluates.
// Unit-tested by tests/member-host-harness.test.ts; runnable on any OS.
import { baselineAsset, baselineStaleness, newestBaselineTag } from '../../fresh-install/lib/baseline.mjs';
import { QUOTE_LED_CASES } from './commands.mjs';

/** The install guard's refusal (the release binary's `install`, RBS). */
export const REFUSAL_CODE = 'E-FLEET-SE-RUNNING';
/** update_member's structuredContent.reason when replace-full refuses under a running sprint (RFS). */
export const REPLACE_REFUSAL_REASON = 'fleet-se-running';

/**
 * Known product gap, printed verbatim in the report: on Windows the member's
 * HTTP server is a scheduled task that runs only in an interactive logon
 * session, so a member reached only over SSH never gets a running server
 * (call --list-tools times out auto-starting it). rf-tools is ENV-LIMITED
 * (non-blocking) with this note ONLY when the failure has the gap's
 * signature, the server log the error names shows no crash, and the
 * candidate predates the fix; anything else stays FAIL.
 */
export const KNOWN_GAP_MEMBER_SERVER = 'KNOWN-GAP (member server needs an interactive logon on Windows; tracked for v0.4.7)';
/** The first core version expected to fix the gap: from it on the gap is a plain FAIL. */
export const KNOWN_GAP_FIXED_IN = [0, 4, 7];
/** rf-tools keyline when the member's server could not be auto-started (the known gap's signature). */
export const SERVER_NOT_STARTED = 'SERVER-NOT-STARTED';
/** rf-tools keyline when the gap's signature came with a crash in the named server log (never excused). */
export const SERVER_CRASHED = 'SERVER-CRASHED';

/** Whether a candidate version string (e.g. v0.4.6_3e4540) is older than KNOWN_GAP_FIXED_IN; unknown is NOT older. */
export function predatesGapFix(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== KNOWN_GAP_FIXED_IN[i]) return v[i] < KNOWN_GAP_FIXED_IN[i];
  return false;
}

/**
 * rf-tools keyline from the FULL `call --list-tools` output (the recorded
 * `observed` is only its tail, which cuts the error code off): TOOLS-OK;
 * SERVER-NOT-STARTED when the client's auto-start handed the start to the
 * service manager and the server never answered, and the candidate predates
 * the gap's fix; else TOOLS-WRONG. This signature alone cannot tell the gap
 * from a member-mode server that crashed on start (nothing else in the
 * regression suite starts a --member http server on Windows), so the driver
 * also reads the server log the error names (serverLogCrashed).
 */
export function toolListKeyline(exitCode, text, candidateVersion) {
  const t = String(text ?? '');
  if (exitCode === 0 && /kb_/.test(t) && /code_/.test(t) && !/execute_|register_|credential_/.test(t)) return 'TOOLS-OK';
  if (exitCode !== 0 && /AUTOSTART_TIMEOUT/.test(t) && /via service manager/.test(t) && predatesGapFix(candidateVersion)) return SERVER_NOT_STARTED;
  return 'TOOLS-WRONG';
}

/**
 * The server log an AUTOSTART_TIMEOUT names ("Check the last server log:
 * <path>."), as a plain Windows path (JSON escaping undone), or null.
 */
export function namedServerLog(text) {
  const m = /Check the last server log: (.+?\.log)/.exec(String(text ?? ''));
  const p = m ? m[1].replace(/\\\\/g, '\\') : null;
  // It goes into a member command: a plain drive path only.
  return p && /^[A-Za-z]:[\\\w .()-]+\.log$/.test(p) ? p : null;
}

/**
 * Whether server log text shows a crash or an error exit: an
 * uncaughtException / unhandledRejection shutdown record, a fatal entry, or a
 * nonzero exit. An absent or empty log is no crash (the server never ran).
 */
export function serverLogCrashed(logText) {
  return /uncaughtException|unhandledRejection|\bfatal\b|exit(?:ed)?(?: with)? code [1-9]|exitCode"?:\s*[1-9]/i.test(String(logText ?? ''));
}

/**
 * Files in the member data dir that are one-shot messages, not state, and so
 * are left out of every "unchanged" / "restored" listing compare:
 * - service-notice.json: a pending notice for the next service verb. The
 *   release's first install writes one (its MCP access-restart note, written
 *   whenever stdout is not a console), the reinstall in the rollback does not
 *   (the restored access key means nothing changed) and its task
 *   registration clears a stale one; the release's install guard writes one
 *   when it refuses (RBS). Losing or gaining it destroys nothing.
 */
export const TRANSIENT_DATA_FILES = Object.freeze(['service-notice.json']);

/** A data dir listing without TRANSIENT_DATA_FILES, sorted. */
export function stateListing(listing) {
  return [...(listing ?? [])].filter(x => !TRANSIENT_DATA_FILES.includes(x)).sort();
}

/**
 * The passes, in run order. `expected` is the outcome the driver must observe;
 * `refusalKeepsState` marks passes that must prove NO destructive change on
 * refusal (binary version, data dir listing, fleet.key hash unchanged).
 */
export const PASSES = Object.freeze([
  {
    id: 'Q', title: 'quote-led commands reach the member intact',
    expected: 'each command is echoed back with the exact argv',
    refusalKeepsState: false,
    steps: QUOTE_LED_CASES.map(c => ({ id: `q-${c.id}`, title: c.title, expect: { exit: 0, keyline: '^MATCH$' } })),
  },
  {
    id: 'RF', title: 'replace-full from the latest release (no supervisor)',
    expected: 'replace-full succeeds; member --version equals the candidate; member-install.json exists; member tools include kb_ and code_ and exclude execute_/register_/credential_',
    refusalKeepsState: false,
    steps: [
      { id: 'rf-baseline-installed', title: 'latest release installed as a full install on the member', expect: { exit: 0 } },
      { id: 'rf-replace', title: 'update_member fleet_install replace-full', expect: { exit: 0 } },
      { id: 'rf-version', title: 'member --version equals the candidate', expect: { exit: 0, keyline: '^MATCH$' } },
      { id: 'rf-marker', title: 'member-install.json exists', expect: { exit: 0 } },
      {
        id: 'rf-tools', title: 'member tool list: kb_ and code_ present, execute_/register_/credential_ absent', expect: { exit: 0, keyline: '^TOOLS-OK$' },
        envLimited: [{ platforms: ['windows'], keyline: `^${SERVER_NOT_STARTED}$`, note: KNOWN_GAP_MEMBER_SERVER }],
      },
    ],
  },
  {
    id: 'RB', title: 'forced rollback from the RF end state',
    expected: 'the documented rollback restores the release version, and the data dir listing and fleet.key hash recorded before replace-full',
    refusalKeepsState: false,
    requires: 'RF',
    steps: [
      { id: 'rb-backup', title: 'the replace-full backup (data/, fleet.key, old binary) is found on the member', expect: { exit: 0 } },
      { id: 'rb-rollback', title: 'documented Rollback steps run, each gated on the previous one', expect: { exit: 0 } },
      { id: 'rb-version', title: 'member reports the release version again', expect: { exit: 0, keyline: '^MATCH$' } },
      { id: 'rb-data', title: 'data dir listing equals the one taken before replace-full', expect: { exit: 0, keyline: '^MATCH$' } },
      { id: 'rb-key', title: 'fleet.key hash equals the one taken before replace-full', expect: { exit: 0, keyline: '^MATCH$' } },
    ],
  },
  {
    // Since #872 replace-full STOPS an idle supervisor itself (and says so) and
    // refuses only while a sprint runs (update_member isError, reason
    // fleet-se-running). The old "refused because a supervisor runs" check was
    // obsolete; its equivalent is the refusal under a live sprint plus the
    // idle-supervisor stop. The sprint is a stand-in process holding a sprint
    // lock, which is exactly what the install guard's detection counts.
    id: 'RFS', title: 'replace-full with fleet-sprint work running',
    expected: `with a supervisor and a sprint running, replace-full refuses (reason ${REPLACE_REFUSAL_REASON}) and makes no destructive change; with only the idle supervisor left it stops that supervisor, says so, and replaces the install with the candidate`,
    refusalKeepsState: true,
    refusalCode: REPLACE_REFUSAL_REASON,
    steps: [
      { id: 'rfs-baseline-installed', title: 'latest release installed as a full install on the member', expect: { exit: 0 } },
      { id: 'rfs-workflows-copied', title: 'the installed fleet-sprint runtime (workflows/ + node_modules/) copied aside for RBS', expect: { exit: 0 } },
      { id: 'rfs-supervisor-started', title: 'fleet-sprint supervisor running on the member host (seen by fleet-se-check in a later session)', expect: { exit: 0 } },
      { id: 'rfs-sprint-started', title: 'a running sprint (stand-in holding a sprint lock) seen by fleet-se-check', expect: { exit: 0 } },
      { id: 'rfs-refused', title: `replace-full refused (isError, reason ${REPLACE_REFUSAL_REASON})`, expect: { exit: 0, keyline: `^${REPLACE_REFUSAL_REASON}$` } },
      { id: 'rfs-unchanged', title: 'binary version, data dir listing and fleet.key hash unchanged after the refusal', expect: { exit: 0, keyline: '^UNCHANGED$' } },
      { id: 'rfs-sprint-stopped', title: 'the sprint ended; the idle supervisor still runs', expect: { exit: 0 } },
      { id: 'rfs-replace', title: 'replace-full succeeds and reports it stopped the idle supervisor', expect: { exit: 0, keyline: '^IDLE-SUPERVISOR-STOPPED$' } },
      { id: 'rfs-supervisor-gone', title: 'no supervisor runs after the replacement', expect: { exit: 0 } },
      { id: 'rfs-version', title: 'member --version equals the candidate', expect: { exit: 0, keyline: '^MATCH$' } },
    ],
  },
  {
    id: 'RBS', title: 'rollback with a supervisor running',
    expected: `the rollback's guarded reinstall (the release binary's install, run alone, so nothing before it can destroy state) refuses with ${REFUSAL_CODE} and makes no destructive change; after the supervisor is stopped the full gated rollback succeeds and restores the release version, the data dir and fleet.key`,
    refusalKeepsState: true,
    refusalCode: REFUSAL_CODE,
    requires: 'RFS',
    steps: [
      { id: 'rbs-backup', title: 'the replace-full backup (data/, fleet.key, old binary) is found on the member', expect: { exit: 0 } },
      { id: 'rbs-supervisor-started', title: 'fleet-sprint supervisor running on the member host', expect: { exit: 0 } },
      { id: 'rbs-refused', title: `the rollback's guarded reinstall, run alone, refused with ${REFUSAL_CODE}`, expect: { exit: 0, keyline: `^${REFUSAL_CODE}$` } },
      { id: 'rbs-unchanged', title: 'binary version, data dir listing and fleet.key hash unchanged after the refusal', expect: { exit: 0, keyline: '^UNCHANGED$' } },
      { id: 'rbs-supervisor-stopped', title: 'supervisor stopped', expect: { exit: 0 } },
      { id: 'rbs-rollback', title: 'full rollback succeeds after the supervisor is stopped, each step gated on the previous one', expect: { exit: 0 } },
      { id: 'rbs-version', title: 'member reports the release version again', expect: { exit: 0, keyline: '^MATCH$' } },
      { id: 'rbs-data', title: 'data dir listing equals the one taken before replace-full', expect: { exit: 0, keyline: '^MATCH$' } },
      { id: 'rbs-key', title: 'fleet.key hash equals the one taken before replace-full', expect: { exit: 0, keyline: '^MATCH$' } },
    ],
  },
]);

export const PASS_IDS = Object.freeze(PASSES.map(p => p.id));

/** Checklist in the shape fresh-install/lib/verdict.mjs evaluatePass() reads. */
export function buildChecklist() {
  const passes = {};
  for (const p of PASSES) passes[p.id] = { title: p.title, steps: p.steps.map(s => ({ ...s })) };
  return { passes };
}

/** What `run.mjs --plan` prints: pass list with expected outcomes (no VM changes). */
export function planPasses(ids = PASS_IDS) {
  return ids.map(id => {
    const p = PASSES.find(x => x.id === id);
    if (!p) throw new Error(`unknown pass ${id}`);
    return {
      id: p.id, title: p.title, expected: p.expected,
      refusalWithoutDestructiveChange: p.refusalKeepsState,
      refusalCode: p.refusalKeepsState ? p.refusalCode : null,
      requires: p.requires ?? null,
      steps: p.steps.map(s => s.id),
    };
  });
}

/** State captured before and after an operation that must have changed nothing (TRANSIENT_DATA_FILES ignored). */
export function compareSnapshots(before, after) {
  const diffs = [];
  if (before.binaryVersion !== after.binaryVersion) diffs.push(`binary version ${before.binaryVersion} -> ${after.binaryVersion}`);
  if (before.fleetKeySha256 !== after.fleetKeySha256) diffs.push('fleet.key hash changed');
  const b = stateListing(before.dataListing);
  const a = stateListing(after.dataListing);
  if (b.join('\n') !== a.join('\n')) {
    const added = a.filter(x => !b.includes(x));
    const removed = b.filter(x => !a.includes(x));
    diffs.push(`data dir listing changed (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'})`);
  }
  return { unchanged: diffs.length === 0, diffs };
}

/**
 * Baseline resolution (reuses fresh-install's pins and staleness logic).
 * Returns { tag, asset, sha256, repo, reasons } where `reasons` are the
 * INCONCLUSIVE reasons: a missing pin or asset digest, an unresolvable latest
 * release, or a pin older than the latest release. Never a PASS in those cases.
 */
export function resolveBaseline({ pins, platform = 'windows', latestTag = null, lookupError = null }) {
  const tag = newestBaselineTag(pins);
  const reasons = [];
  if (!tag) return { tag: null, asset: null, sha256: null, repo: null, reasons: ['no release baseline is pinned in fresh-install/pins.json; member upgrade from the latest release is not proven'] };
  const entry = pins.baselines[tag];
  const asset = entry?.[platform]?.asset ?? baselineAsset(platform);
  const sha256 = entry?.[platform]?.sha256 ?? null;
  if (!sha256) reasons.push(`baseline ${tag} has no pinned ${platform} sha256 in pins.json; the release asset cannot be verified`);
  const s = baselineStaleness({ usedTag: tag, latestTag, lookupError });
  if (s.status !== 'current') reasons.push(s.note);
  return { tag, asset, sha256, repo: entry?.repo ?? null, reasons };
}
