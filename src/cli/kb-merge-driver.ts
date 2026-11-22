// `apra-fleet kb merge-driver <base> <ours> <theirs> [<path>]`
//
// The git merge driver for the knowledge bible (.fleet/kb-canonical.json).
// kb_setup registers it in a clone (installBibleMergeDriver below): git config
// merge.<name>.driver plus a line in the clone's info/attributes, so a LOCAL
// git merge, rebase or cherry-pick of two bible-changing branches resolves
// through the id-keyed, tombstone-aware merge (src/services/knowledge/
// bible-merge.ts) instead of a line merge.
//
// Git passes %O (ancestor), %A (ours, also the result) and %B (theirs) as temp
// files. On a clean merge the result is written to %A in the exporter's byte
// form and the exit code is 0. On a genuine conflict (or an unreadable side)
// the problem is printed on stderr, %A gets git's own line merge with conflict
// markers (git merge-file) so the conflict is visible as usual, and the exit
// code is 1, which git reports as a conflict.
//
// Hosted merges (a pull request merged on the git server) cannot run a local
// driver: when such a merge reports a bible conflict, merge locally in a clone
// set up by kb_setup, or run the standalone merge script (see
// packages/apra-fleet-se/docs/kb-canonical-merge.md).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeBibleDocuments, serializeBible, formatBibleConflicts, MalformedBibleError } from '../services/knowledge/bible-merge.js';
import { gitExecutable } from '../os/git-executable.js';
import { resolveKbInvalidateCommand } from '../tools/kb-invalidate.js';

/** Name of the merge driver in git config (merge.<name>.driver) and attributes (merge=<name>). */
export const BIBLE_MERGE_DRIVER_NAME = 'apra-fleet-kb-bible';
/** The bible path the driver is assigned to, relative to the repository root. */
export const BIBLE_ATTRIBUTES_PATH = '.fleet/kb-canonical.json';
export const BIBLE_ATTRIBUTES_LINE = `${BIBLE_ATTRIBUTES_PATH} merge=${BIBLE_MERGE_DRIVER_NAME}`;

export const KB_MERGE_DRIVER_USAGE = 'Usage: apra-fleet kb merge-driver <base> <ours> <theirs> [<path>]';

interface Io { error: (msg: string) => void }
const defaultIo: Io = { error: (msg) => console.error(msg) };

function readSide(file: string, label: string): unknown {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  // An empty side (the file did not exist there) is an empty bible.
  if (text.trim() === '') return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MalformedBibleError(`bible merge: ${label} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  // Legacy bare-array bible.
  return Array.isArray(parsed) ? { entries: parsed } : parsed;
}

/** Leave git's own line merge (with conflict markers) in `ours`. */
function lineMergeInto(ours: string, base: string, theirs: string, io: Io): void {
  try {
    execFileSync(gitExecutable(), ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', ours, base, theirs], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
  } catch (err) {
    // merge-file exits with the number of conflicts; the markers are written either way.
    const status = (err as { status?: number }).status;
    if (typeof status !== 'number' || status < 0) io.error(`apra-fleet kb merge-driver: git merge-file failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function runKbMergeDriver(args: string[], io: Io = defaultIo): number {
  if (args.length < 3 || args.length > 4) {
    io.error(KB_MERGE_DRIVER_USAGE);
    return 2;
  }
  const [base, ours, theirs] = args;
  const label = args[3] ?? BIBLE_ATTRIBUTES_PATH;
  let result;
  try {
    result = mergeBibleDocuments(readSide(base, 'base'), readSide(ours, 'ours'), readSide(theirs, 'theirs'));
  } catch (err) {
    io.error(`apra-fleet kb merge-driver: cannot merge ${label}: ${err instanceof Error ? err.message : String(err)}`);
    lineMergeInto(ours, base, theirs, io);
    return 1;
  }
  if (result.merged === null) {
    io.error(`apra-fleet kb merge-driver: ${result.conflicts.length} genuine conflict(s) in ${label}; resolve by hand:\n${formatBibleConflicts(result.conflicts)}`);
    lineMergeInto(ours, base, theirs, io);
    return 1;
  }
  fs.writeFileSync(ours, serializeBible(result.merged));
  return 0;
}

// POSIX sh single-quoting (git runs a merge driver through sh, including git
// for Windows' bundled sh, which takes forward slashes).
function shQuote(arg: string): string {
  const normalized = process.platform === 'win32' ? arg.replace(/\\/g, '/') : arg;
  return `'${normalized.replace(/'/g, `'\\''`)}'`;
}

/** What the registered driver prints on stderr when its command cannot start. */
export const BIBLE_MERGE_DRIVER_STALE_MESSAGE =
  'apra-fleet kb merge-driver: the registered driver command cannot start (apra-fleet moved or was reinstalled); '
  + 'left a line merge with conflict markers in the bible -- resolve it by hand, then re-run kb_setup to repair the driver';

/**
 * The merge.<name>.driver value: the absolute CLI argv, resolved in JS, then
 * git's placeholders (git substitutes %O/%A/%B/%P already sh-quoted).
 *
 * The command is guarded so a stale registration can never leave the bible
 * silently as ours: when any recorded path is gone, or sh cannot start the
 * command (exit 126/127), the driver falls back to git's own 3-way line merge
 * (git merge-file, conflict markers with both sides), prints a message naming
 * kb_setup as the repair and exits 1, so git reports a conflict. A driver
 * that ran keeps its own exit code (0 merged, 1 genuine conflict).
 * Only POSIX sh is used (git for Windows runs drivers through its bundled sh);
 * every path is resolved in JS and single-quoted, nothing is expanded by sh.
 */
export function buildBibleMergeDriverCommand(command: string[]): string {
  if (command.length === 0 || !command.every((a) => path.isAbsolute(a))) {
    throw new Error('bible merge driver command must be absolute paths');
  }
  const quoted = command.map(shQuote);
  const present = quoted.map((q) => `[ -f ${q} ]`).join(' && ');
  const run = `${quoted.join(' ')} kb merge-driver %O %A %B %P`;
  const fallback = `echo ${shQuote(BIBLE_MERGE_DRIVER_STALE_MESSAGE)} >&2; git merge-file -L ours -L base -L theirs %A %O %B; exit 1`;
  return `if ${present}; then ${run}; rc=$?; else rc=127; fi; `
    + `if [ $rc -eq 126 ] || [ $rc -eq 127 ]; then ${fallback}; fi; exit $rc`;
}

export type BibleMergeDriverInstallResult =
  /**
   * repairedFrom: the previously registered merge.<name>.driver value when it
   * differed from the current one (a stale path after apra-fleet moved or was
   * reinstalled, or an older command form) and was replaced; absent when the
   * driver was newly registered or the registration was already current.
   */
  | { installed: true; attributesPath: string; repairedFrom?: string }
  | { installed: false; reason: string };

/** The currently registered merge.<name>.driver value, or null when none is set. */
function registeredDriver(repoPath: string): string | null {
  try {
    const value = git(repoPath, ['config', '--local', '--get', `merge.${BIBLE_MERGE_DRIVER_NAME}.driver`]);
    return value === '' ? null : value;
  } catch {
    // git config --get exits 1 when the key is unset.
    return null;
  }
}

function git(repoPath: string, args: string[]): string {
  return execFileSync(gitExecutable(), args, {
    cwd: repoPath, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

/**
 * Register the bible merge driver in the clone at repoPath: local git config
 * merge.<name>.{name,driver} and the attribute line in the clone's
 * info/attributes (untracked, so nothing is added to the repository). Both are
 * idempotent. A registered driver that differs from the current install's
 * command (its recorded paths moved or were reinstalled) is re-registered and
 * reported as repairedFrom. Never throws: a failure is returned as a reason.
 */
export function installBibleMergeDriver(repoPath: string, command?: string[]): BibleMergeDriverInstallResult {
  try {
    const driver = buildBibleMergeDriverCommand(command ?? resolveKbInvalidateCommand());
    const previous = registeredDriver(repoPath);
    git(repoPath, ['config', '--local', `merge.${BIBLE_MERGE_DRIVER_NAME}.name`, 'apra-fleet knowledge bible merge (id-keyed, tombstone-aware)']);
    if (previous !== driver) git(repoPath, ['config', '--local', `merge.${BIBLE_MERGE_DRIVER_NAME}.driver`, driver]);
    const rel = git(repoPath, ['rev-parse', '--git-path', 'info/attributes']).split(/\r?\n/)[0];
    const attributesPath = path.isAbsolute(rel) ? rel : path.join(repoPath, rel);
    const existing = fs.existsSync(attributesPath) ? fs.readFileSync(attributesPath, 'utf8') : '';
    if (!existing.split(/\r?\n/).some((line) => line.trim() === BIBLE_ATTRIBUTES_LINE)) {
      fs.mkdirSync(path.dirname(attributesPath), { recursive: true });
      const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
      fs.writeFileSync(attributesPath, existing + sep + BIBLE_ATTRIBUTES_LINE + '\n');
    }
    return previous !== null && previous !== driver
      ? { installed: true, attributesPath, repairedFrom: previous }
      : { installed: true, attributesPath };
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
