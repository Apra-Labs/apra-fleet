// Rollback commands and restore checks for the member-host RB / RBS passes.
// Pure; unit-tested by tests/member-host-scenarios.test.ts.
//
// The fleet's replace-full (src/services/member-fleet-install.ts
// buildReplaceFullInstallPlan) backs up into
// <home>/.apra-fleet-replace-backup-<stamp>/ holding data/, fleet.key and the
// OLD binary, and moves the old data/ to <home>/.apra-fleet/data.replaced-<stamp>.
// The documented Rollback (docs/install.md) is: uninstall the member install,
// put the old data back (the aside copy; data/ kept if never moved; the
// backup's only when neither exists), restore fleet.key only if missing,
// reinstall the previous version from the backup's binary. Every member command here is a
// bash string for the Git Bash member shell.

import { TRANSIENT_DATA_FILES, stateListing } from './scenarios.mjs';

export const MEMBER_FLEET_DIR = '$HOME/.apra-fleet';
export const BACKUP_GLOB = '$HOME/.apra-fleet-replace-backup-*';
export const ROLLBACK_OK = 'ROLLBACK-OK';
/** The member's llm_provider (run.mjs registers it so): only claude / opencode members get a member install. */
export const MEMBER_PROVIDER = 'claude';

// What a backup directory may look like before it is put into a command.
const BACKUP_RE = /^\/[A-Za-z0-9._\/-]*\/\.apra-fleet-replace-backup-[A-Za-z0-9._-]+$/;

/** Lists the replace-full backups on the member, newest first. */
export function listBackupsCommand() {
  return `ls -1dt ${BACKUP_GLOB} 2>/dev/null || true`;
}

/** The newest backup path from listBackupsCommand() output, or null. */
export function pickNewestBackup(output) {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const p = line.trim().replace(/\/+$/, '');
    if (BACKUP_RE.test(p)) return p;
  }
  return null;
}

function assertBackup(backupDir) {
  if (!BACKUP_RE.test(String(backupDir ?? ''))) throw new Error(`refusing to build a rollback for an unexpected backup path '${backupDir}'`);
  return backupDir;
}

/**
 * The ONE guarded rollback step, alone: the backup binary's reinstall. With a
 * fleet-sprint supervisor running it must refuse (E-FLEET-SE-RUNNING) before it
 * changes anything, so the RBS refusal attempt runs only this -- never the
 * uninstall or the data restore that precede it in the full rollback.
 */
export function guardedReinstallCommand(backupDir) {
  const b = assertBackup(backupDir);
  // --llm <the member's provider>, as the product's own rollback steps do
  // (buildReplaceFullInstallPlan). A release install takes no "none" provider.
  return `chmod +x '${b}/apra-fleet.exe' && '${b}/apra-fleet.exe' install --llm ${MEMBER_PROVIDER} --force`;
}

/** Where replace-full moved the old data/ (`<home>/.apra-fleet/data.replaced-<stamp>`, the backup's stamp). */
export function dataAsidePath(backupDir) {
  const stamp = /\.apra-fleet-replace-backup-([A-Za-z0-9._-]+)$/.exec(assertBackup(backupDir))[1];
  return `${MEMBER_FLEET_DIR}/data.replaced-${stamp}`;
}

/**
 * The full documented rollback (docs/install.md "Rollback", the same as the
 * product's own plan in buildReplaceFullInstallPlan), every step gated on the
 * previous one (&&), so the first failing step fails the command and nothing
 * after it runs. Prints ROLLBACK-OK only when every step succeeded.
 * - data/: the moved-aside copy when there is one; with none, data/ was never
 *   moved, so it is kept; the backup's data/ only when neither exists.
 * - fleet.key: restored from the backup only when the member has none.
 */
export function rollbackSteps(backupDir) {
  const b = assertBackup(backupDir);
  const mh = MEMBER_FLEET_DIR;
  const aside = dataAsidePath(b);
  return [
    `"${mh}/bin/apra-fleet.exe" uninstall --force --yes`,
    `if [ -d "${aside}" ]; then rm -rf "${mh}/data" && mv "${aside}" "${mh}/data"; elif [ ! -d "${mh}/data" ]; then cp -R '${b}/data' "${mh}/data"; fi`,
    `if [ ! -f "${mh}/fleet.key" ] && [ -f '${b}/fleet.key' ]; then cp '${b}/fleet.key' "${mh}/fleet.key"; fi`,
    guardedReinstallCommand(b),
  ];
}

export function rollbackCommand(backupDir) {
  return `${rollbackSteps(backupDir).join(' && ')} && echo ${ROLLBACK_OK}`;
}

/** Did the gated rollback run to the end? (exit status AND the final marker) */
export function rollbackSucceeded(result) {
  return !!result && !result.isError && new RegExp(`(^|\\n)${ROLLBACK_OK}\\s*$`).test(String(result.text ?? '').replace(/\r/g, ''));
}

/**
 * Restore checks after a rollback, against the snapshot taken right before
 * replace-full (preReplace): the release version, the SAME data dir listing
 * (one-shot notices, TRANSIENT_DATA_FILES, left out) and the SAME fleet.key hash. A missing pre-replace snapshot, or an empty
 * data listing on it, is a MISMATCH -- a rollback can only be shown to restore
 * what was recorded before. An empty fleet.key hash means the key was ABSENT
 * (it is created lazily): absent before and absent after is a MATCH; absent
 * before but present after, or present before but absent/different after, is
 * a MISMATCH.
 */
export function restoreChecks({ preReplace, post, releaseVersion }) {
  const version = String(post?.binaryVersion ?? '');
  const rel = String(releaseVersion ?? '').replace(/^v/, '');
  const out = {
    version: { keyline: rel && version.includes(rel) ? 'MATCH' : 'MISMATCH', detail: `expected ${rel || '(none)'} in '${version}'` },
  };
  if (!preReplace) {
    const why = 'no snapshot from before replace-full (its replace pass did not run or failed early)';
    out.data = { keyline: 'MISMATCH', detail: why };
    out.key = { keyline: 'MISMATCH', detail: why };
    return out;
  }
  // One-shot notices (TRANSIENT_DATA_FILES) are not state a rollback restores.
  const want = stateListing(preReplace.dataListing);
  const got = stateListing(post?.dataListing);
  const dataOk = want.length > 0 && want.join('\n') === got.join('\n');
  const ignored = `(ignored: ${TRANSIENT_DATA_FILES.join(', ')})`;
  out.data = {
    keyline: dataOk ? 'MATCH' : 'MISMATCH',
    detail: dataOk ? `${got.join(',')} ${ignored}` : `before replace-full: [${want.join(',')}]; after rollback: [${got.join(',')}] ${ignored}`,
  };
  const keyBefore = String(preReplace.fleetKeySha256 ?? '');
  const keyAfter = String(post?.fleetKeySha256 ?? '');
  const keyOk = keyBefore === keyAfter;
  out.key = {
    keyline: keyOk ? 'MATCH' : 'MISMATCH',
    detail: keyOk ? (keyAfter || '(absent before and after)') : `before replace-full: ${preReplace.fleetKeySha256 || '(none)'}; after rollback: ${post?.fleetKeySha256 || '(none)'}`,
  };
  return out;
}
