// Rollback commands and restore checks for the member-host RB / RBS passes.
// Pure; unit-tested by tests/member-host-scenarios.test.ts.
//
// The fleet's replace-full (src/services/member-fleet-install.ts
// buildReplaceFullInstallPlan) backs up into
// <home>/.apra-fleet-replace-backup-<stamp>/ holding data/, fleet.key and the
// OLD binary. The documented Rollback (docs/install.md) is: uninstall the
// member install, restore data/ and fleet.key from the backup, reinstall the
// previous version from the backup's binary. Every member command here is a
// bash string for the Git Bash member shell.

export const MEMBER_FLEET_DIR = '$HOME/.apra-fleet';
export const BACKUP_GLOB = '$HOME/.apra-fleet-replace-backup-*';
export const ROLLBACK_OK = 'ROLLBACK-OK';

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
  return `chmod +x '${b}/apra-fleet.exe' && '${b}/apra-fleet.exe' install --llm none --force`;
}

/**
 * The full documented rollback, every step gated on the previous one (&&), so
 * the first failing step fails the command and nothing after it runs. Prints
 * ROLLBACK-OK only when every step succeeded.
 */
export function rollbackSteps(backupDir) {
  const b = assertBackup(backupDir);
  const mh = MEMBER_FLEET_DIR;
  return [
    `"${mh}/bin/apra-fleet.exe" uninstall --force --yes`,
    `rm -rf "${mh}/data"`,
    `cp -R '${b}/data' "${mh}/data"`,
    `cp '${b}/fleet.key' "${mh}/fleet.key"`,
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
 * and the SAME fleet.key hash. A missing pre-replace snapshot, or an empty
 * listing / hash on it, is a MISMATCH -- a rollback can only be shown to
 * restore what was recorded before.
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
  const want = [...(preReplace.dataListing ?? [])].sort();
  const got = [...(post?.dataListing ?? [])].sort();
  const dataOk = want.length > 0 && want.join('\n') === got.join('\n');
  out.data = {
    keyline: dataOk ? 'MATCH' : 'MISMATCH',
    detail: dataOk ? got.join(',') : `before replace-full: [${want.join(',')}]; after rollback: [${got.join(',')}]`,
  };
  const keyOk = !!preReplace.fleetKeySha256 && preReplace.fleetKeySha256 === post?.fleetKeySha256;
  out.key = {
    keyline: keyOk ? 'MATCH' : 'MISMATCH',
    detail: keyOk ? post.fleetKeySha256 : `before replace-full: ${preReplace.fleetKeySha256 || '(none)'}; after rollback: ${post?.fleetKeySha256 || '(none)'}`,
  };
  return out;
}
