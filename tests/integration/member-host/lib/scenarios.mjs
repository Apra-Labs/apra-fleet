// Pure scenario planning for the member-host upgrade passes: the pass list,
// the expected outcome per pass, the pre/post snapshot comparison that proves a
// refusal changed nothing, baseline resolution (reusing fresh-install's
// baseline logic) and the checklist the shared verdict logic evaluates.
// Unit-tested by tests/member-host-harness.test.ts; runnable on any OS.
import { baselineAsset, baselineStaleness, newestBaselineTag } from '../../fresh-install/lib/baseline.mjs';
import { QUOTE_LED_CASES } from './commands.mjs';

export const REFUSAL_CODE = 'E-FLEET-SE-RUNNING';

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
      { id: 'rf-tools', title: 'member tool list: kb_ and code_ present, execute_/register_/credential_ absent', expect: { exit: 0, keyline: '^TOOLS-OK$' } },
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
    id: 'RFS', title: 'replace-full with a supervisor running',
    expected: `replace-full refuses with ${REFUSAL_CODE} and makes no destructive change; after the supervisor is stopped it succeeds`,
    refusalKeepsState: true,
    steps: [
      { id: 'rfs-baseline-installed', title: 'latest release installed as a full install on the member', expect: { exit: 0 } },
      { id: 'rfs-supervisor-started', title: 'fleet-sprint supervisor running on the member host', expect: { exit: 0 } },
      { id: 'rfs-refused', title: `replace-full refused with ${REFUSAL_CODE}`, expect: { exit: 0, keyline: `^${REFUSAL_CODE}$` } },
      { id: 'rfs-unchanged', title: 'binary version, data dir listing and fleet.key hash unchanged after the refusal', expect: { exit: 0, keyline: '^UNCHANGED$' } },
      { id: 'rfs-supervisor-stopped', title: 'supervisor stopped', expect: { exit: 0 } },
      { id: 'rfs-replace', title: 'replace-full succeeds after the supervisor is stopped', expect: { exit: 0 } },
    ],
  },
  {
    id: 'RBS', title: 'rollback with a supervisor running',
    expected: `the rollback's guarded reinstall (run alone, so nothing before it can destroy state) refuses with ${REFUSAL_CODE} and makes no destructive change; after the supervisor is stopped the full gated rollback succeeds and restores the release version, the data dir and fleet.key`,
    refusalKeepsState: true,
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
      refusalCode: p.refusalKeepsState ? REFUSAL_CODE : null,
      requires: p.requires ?? null,
      steps: p.steps.map(s => s.id),
    };
  });
}

/** State captured before and after an operation that must have changed nothing. */
export function compareSnapshots(before, after) {
  const diffs = [];
  if (before.binaryVersion !== after.binaryVersion) diffs.push(`binary version ${before.binaryVersion} -> ${after.binaryVersion}`);
  if (before.fleetKeySha256 !== after.fleetKeySha256) diffs.push('fleet.key hash changed');
  const b = [...(before.dataListing ?? [])].sort();
  const a = [...(after.dataListing ?? [])].sort();
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
