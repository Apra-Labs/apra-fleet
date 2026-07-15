/**
 * Shared extraction helpers for the workflow subsystem's on-disk payload:
 * ~/.apra-fleet/{node_modules,schemas,workflows/<builtin>}.
 *
 * Factored out of src/cli/install.ts (apra-fleet-7pm.5's workflow-install step)
 * so src/cli/workflow.ts's launcher (apra-fleet-7pm.8) can self-heal a missing
 * install using the EXACT SAME extraction code path -- not a re-implementation.
 * install.ts's own install step calls extractWorkflowSubsystemAssets() below;
 * its behavior (console output, files written) is unchanged by this refactor.
 *
 * See docs/workflow-subsystem-plan.md Section 2.1 (on-disk layout) / Section 3
 * (self-heal) / Section 6 (installer step).
 */
import fs from 'node:fs';
import path from 'node:path';
import { NODE_MODULES_DIR, SCHEMAS_DIR, WORKFLOWS_DIR } from './config.js';

/** Recognized built-in workflow names installed by `apra-fleet install` and
 *  eligible for workflow.ts's self-heal extraction. */
export const BUILTIN_WORKFLOW_NAMES = ['auto-sprint', 'hello-world'];

export interface WorkflowSubsystemManifest {
  workflowRuntime?: Record<string, string>;
  agentSchemas?: Record<string, string>;
  builtinWorkflows?: Record<string, string>;
}

/** Does this (already-loaded) asset manifest carry all three workflow sections? */
export function hasWorkflowSubsystemAssets(manifest: WorkflowSubsystemManifest): boolean {
  return !!(manifest.workflowRuntime && manifest.agentSchemas && manifest.builtinWorkflows);
}

// --- extract-to-temp-then-rename with Windows EBUSY handling (apra-fleet-7pm.5) ---
// A running apra-fleet process (self-update, or a workflow launched from the very
// tree being refreshed) can hold a package/workflow directory open on Windows.
// Extract into a sibling temp dir first, then swap it in with rename(); if the
// swap hits EBUSY, retry a few times, and if it still fails, warn and leave the
// existing directory untouched rather than failing the whole install.
const EBUSY_MAX_ATTEMPTS = 5;
const EBUSY_RETRY_DELAY_MS = 200;

function sleepSync(ms: number): void {
  const ia = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(ia, 0, 0, ms);
}

function rmSyncBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort cleanup only */ }
}

/**
 * Extract `files` (relative-path -> asset key) into `destDir` via
 * extract-to-temp-then-rename. `label` is used in warning text only.
 */
export function extractPackageTree(
  destDir: string,
  files: Record<string, string>,
  label: string,
  extractAssetBuffer: (key: string) => Buffer,
  warn: (msg: string) => void = (m) => console.warn(m),
): void {
  const tmpDir = `${destDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    for (const [relPath, assetKey] of Object.entries(files)) {
      const buf = extractAssetBuffer(assetKey);
      const dest = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
  } catch (err) {
    rmSyncBestEffort(tmpDir);
    warn(`  [!] Failed to extract ${label}: ${(err as Error).message} -- skipped`);
    return;
  }

  for (let attempt = 1; attempt <= EBUSY_MAX_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true, maxRetries: EBUSY_MAX_ATTEMPTS, retryDelay: EBUSY_RETRY_DELAY_MS });
      fs.renameSync(tmpDir, destDir);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' && attempt < EBUSY_MAX_ATTEMPTS) {
        sleepSync(EBUSY_RETRY_DELAY_MS);
        continue;
      }
      rmSyncBestEffort(tmpDir);
      warn(`  [!] ${label} is in use (locked) -- skipped this update; existing files left in place.`);
      return;
    }
  }
}

export interface ExtractWorkflowSubsystemAssetsOptions {
  manifest: WorkflowSubsystemManifest;
  /** Reads one asset (SEA asset key, or a dev-mode disk-relative path) into a Buffer. */
  extractAssetBuffer: (key: string) => Buffer;
  /** Recorded in workflows/.installed.json -- the installing/self-healing binary's version. */
  version: string;
  /** Extract the built-in workflow directories too (installer default: true).
   *  workflow.ts's self-heal passes false for a non-built-in user workflow name --
   *  the shared runtime/schemas are still needed, but no workflow directory is
   *  fabricated for a name that isn't a recognized built-in. */
  includeBuiltins?: boolean;
  builtinNames?: string[];
  warn?: (msg: string) => void;
}

/**
 * Extracts ~/.apra-fleet/{node_modules,schemas,workflows/<builtins>} from an
 * already-loaded asset manifest. THE canonical extraction code path -- shared
 * by install.ts's workflow-install step (apra-fleet-7pm.5) and workflow.ts's
 * self-heal launcher path (apra-fleet-7pm.8).
 */
export function extractWorkflowSubsystemAssets(opts: ExtractWorkflowSubsystemAssetsOptions): void {
  const { manifest, extractAssetBuffer, version } = opts;
  const includeBuiltins = opts.includeBuiltins ?? true;
  const builtinNames = opts.builtinNames ?? BUILTIN_WORKFLOW_NAMES;
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  if (!hasWorkflowSubsystemAssets(manifest)) {
    warn('  [!] This build has no workflow-subsystem assets (older manifest) -- skipping workflow runtime install. Rebuild the binary or run apra-fleet update to get this feature.');
    return;
  }

  // (1) ~/.apra-fleet/node_modules -- grouped by top-level package so a lock on
  // one package (Windows EBUSY) never blocks extracting the others. Each
  // namespacedKey already encodes "<pkg>/<relpath-within-pkg>" (see
  // scripts/gen-sea-config.mjs's collectPackageTree / install.ts's
  // collectPackageTree), so join(NODE_MODULES_DIR, key) is the final layout.
  const runtimeByPackage = new Map<string, Record<string, string>>();
  for (const [namespacedKey, assetKey] of Object.entries(manifest.workflowRuntime!)) {
    const parts = namespacedKey.split('/');
    const pkgName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    const relWithinPkg = (parts[0].startsWith('@') ? parts.slice(2) : parts.slice(1)).join('/');
    if (!runtimeByPackage.has(pkgName)) runtimeByPackage.set(pkgName, {});
    runtimeByPackage.get(pkgName)![relWithinPkg] = assetKey;
  }
  for (const [pkgName, files] of runtimeByPackage) {
    extractPackageTree(path.join(NODE_MODULES_DIR, pkgName), files, `node_modules/${pkgName}`, extractAssetBuffer, warn);
  }

  // (2) ~/.apra-fleet/schemas
  for (const [namespacedKey, assetKey] of Object.entries(manifest.agentSchemas!)) {
    const relPath = namespacedKey.replace(/^agentSchemas\//, '');
    const content = extractAssetBuffer(assetKey);
    const dest = path.join(SCHEMAS_DIR, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  if (!includeBuiltins) return;

  // (3) ~/.apra-fleet/workflows/{auto-sprint,hello-world} -- clear+extract ONLY the
  // named built-in subdirectory; the workflows/ root (and any sibling
  // user-authored workflow directories) is never cleared.
  for (const name of builtinNames) {
    const files: Record<string, string> = {};
    const prefix = `${name}/`;
    for (const [namespacedKey, assetKey] of Object.entries(manifest.builtinWorkflows!)) {
      if (namespacedKey.startsWith(prefix)) {
        files[namespacedKey.slice(prefix.length)] = assetKey;
      }
    }
    if (Object.keys(files).length === 0) {
      warn(`  [!] No assets found for built-in workflow "${name}" -- skipping.`);
      continue;
    }
    extractPackageTree(path.join(WORKFLOWS_DIR, name), files, `workflows/${name}`, extractAssetBuffer, warn);
  }

  // .installed.json -- records which subdirectories are built-in (vs. user-authored)
  // and the installing/self-healing binary's version, consumed by workflow.ts
  // (--list, R10 skew warning).
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(WORKFLOWS_DIR, '.installed.json'),
    JSON.stringify({ version, builtin: builtinNames }, null, 2) + '\n'
  );
}
