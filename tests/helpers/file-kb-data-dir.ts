import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A per-FILE fleet data dir (APRA_FLEET_DATA_DIR) for a test file whose code
// under test reads FLEET_DIR state -- above all the KB config file
// <data dir>/knowledge/config.json, which selects the http provider and the
// kb_export auto-commit mode.
//
// Why: tests/setup.ts hands every worker of one vitest run the SAME data dir
// (unique per run, not per file). With files running in parallel
// (--fileParallelism), another file's KB config -- an http url pointing at its
// own kb-server, or bible.autoCommit -- is read by this file mid-test: observed
// as E-KB-HTTP-PROJECT-MISMATCH in kb-withdrawal-round-trip scenario 3.
//
// Call it from vi.hoisted, so it runs before any src module (src/paths.ts
// computes FLEET_DIR once, at import):
//
//   const fileDataDir = await vi.hoisted(async () =>
//     (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('my-suite'));
//
// and releaseFileDataDir(fileDataDir) in afterAll.

const claimed = new Map<string, string | undefined>();

/** Point APRA_FLEET_DATA_DIR at a fresh temp dir for this file; returns it. */
export function claimFileDataDir(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label + '-data-')));
  claimed.set(dir, process.env.APRA_FLEET_DATA_DIR);
  process.env.APRA_FLEET_DATA_DIR = dir;
  return dir;
}

/** Remove the dir and restore the previous APRA_FLEET_DATA_DIR. */
export function releaseFileDataDir(dir: string): void {
  const previous = claimed.get(dir);
  claimed.delete(dir);
  if (previous === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Every way a suite's view of the fleet data dir is NOT its own, as messages
 * (empty when isolated): FLEET_DIR and the KB config path the code under test
 * uses must sit in the dir this file claimed, that dir must be named for this
 * file, and it must not be the data dir shared by the whole run.
 */
export function fileDataDirViolations(o: {
  label: string; claimed: string | undefined; fleetDir: string; kbConfigPath: string; runSharedDir: string | undefined;
}): string[] {
  const out: string[] = [];
  if (!o.claimed) return ['no per-file data dir was claimed (claimFileDataDir in vi.hoisted)'];
  if (path.resolve(o.fleetDir) !== path.resolve(o.claimed)) {
    out.push('FLEET_DIR is ' + o.fleetDir + ', not the claimed ' + o.claimed + ' (claimed after src/paths.ts loaded?)');
  }
  if (path.resolve(o.kbConfigPath) !== path.resolve(o.claimed, 'knowledge', 'config.json')) {
    out.push('the KB config path ' + o.kbConfigPath + ' is outside the claimed dir');
  }
  if (!path.basename(o.claimed).startsWith(o.label + '-data-')) {
    out.push('the claimed dir ' + o.claimed + ' is not named for ' + o.label);
  }
  if (o.runSharedDir && path.resolve(o.fleetDir) === path.resolve(o.runSharedDir)) {
    out.push('FLEET_DIR is the data dir shared by every file of the run');
  }
  return out;
}
