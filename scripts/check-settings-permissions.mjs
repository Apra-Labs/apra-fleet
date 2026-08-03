#!/usr/bin/env node
/**
 * Verifies apra-fleet-3ik.1: every Bash(...) prefix required by
 * integ-test-playbook.md and regression-test-playbook.md's '## Permissions'
 * sections is covered by SOME entry in .claude/settings.json's
 * permissions.allow -- the exact file regression-test-runner.md's and
 * integ-test-runner.md's Step 0/0a permission gate reads.
 *
 * This is a runnable simulation of that Step 0/0a dry run: it can be
 * invoked directly (`node scripts/check-settings-permissions.mjs`) by a
 * human or an agent before dispatching regression-test-runner/
 * integ-test-runner, to confirm the gate will not stop the dispatch.
 *
 * Exit 0 + "PASS" when every required prefix is covered.
 * Exit 1 + "FAIL" listing every uncovered prefix by name otherwise
 * (including when .claude/settings.json is missing, unparsable, or has no
 * permissions.allow -- the exact failure mode apra-fleet-3ik reported).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, '..');

/** Extract the Bash(...) permission prefixes named in a playbook's
 *  '## Permissions' section (one match per bullet's first backtick-quoted
 *  Bash(...) occurrence). */
export function extractRequiredBashPrefixes(playbookText) {
  const section = playbookText.split(/^## Permissions$/m)[1]?.split(/^## /m)[0] ?? '';
  return [...section.matchAll(/^- .*?`(Bash\([^)]+\))`/gm)].map(m => m[1]);
}

/** Normalize a Bash(...) allowlist pattern to its command prefix.
 *  "Bash(npm:*)" -> "npm"; "Bash(bd *)" -> "bd"; "Bash(npm test*)" -> "npm test" */
export function commandPrefix(pattern) {
  const m = pattern.match(/^Bash\((.+)\)$/);
  if (!m) return null;
  return m[1].replace(/:\*$/, '').replace(/\*$/, '').trim();
}

/** True when `entry` (an allowlist pattern) covers the command family
 *  required by `required` (a playbook-required pattern): exact match, or
 *  the required command prefix starts at a word boundary with the entry's
 *  command prefix (a broader entry, e.g. Bash(node:*), covers a narrower
 *  requirement, e.g. Bash(node scripts/x.mjs *)). */
export function covers(entry, required) {
  if (entry === required) return true;
  const entryPrefix = commandPrefix(entry);
  const requiredPrefix = commandPrefix(required);
  if (entryPrefix === null || requiredPrefix === null) return false;
  return requiredPrefix === entryPrefix || requiredPrefix.startsWith(`${entryPrefix} `);
}

/**
 * Runs the full check. Returns:
 *   { ok: boolean, missing: string[], errors: string[], required: string[], allow: string[] }
 * `errors` covers structural problems (missing file, bad JSON, no allow key)
 * -- when non-empty, `ok` is always false and `missing` lists every required
 * prefix (nothing could be verified covered).
 */
export function checkSettingsPermissions({ settingsPath, playbookPaths }) {
  const errors = [];
  let allow = [];

  if (!fs.existsSync(settingsPath)) {
    errors.push(`${settingsPath} does not exist`);
  } else {
    let raw;
    try {
      raw = fs.readFileSync(settingsPath, 'utf-8');
    } catch (e) {
      errors.push(`could not read ${settingsPath}: ${e.message}`);
    }
    if (raw !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        errors.push(`${settingsPath} is not valid JSON: ${e.message}`);
      }
      if (parsed !== undefined) {
        if (!parsed.permissions || !Array.isArray(parsed.permissions.allow)) {
          errors.push(`${settingsPath} has no permissions.allow array`);
        } else {
          allow = parsed.permissions.allow;
        }
      }
    }
  }

  const required = [];
  for (const playbookPath of playbookPaths) {
    if (!fs.existsSync(playbookPath)) {
      errors.push(`${playbookPath} does not exist`);
      continue;
    }
    const text = fs.readFileSync(playbookPath, 'utf-8');
    for (const prefix of extractRequiredBashPrefixes(text)) {
      if (!required.includes(prefix)) required.push(prefix);
    }
  }

  if (errors.length) {
    return { ok: false, missing: [...required], errors, required, allow };
  }

  const missing = required.filter(req => !allow.some(entry => covers(entry, req)));
  return { ok: missing.length === 0, missing, errors, required, allow };
}

function main() {
  const settingsPath = process.argv[2] ?? path.join(repoRoot, '.claude', 'settings.json');
  const playbookPaths = [
    path.join(repoRoot, 'integ-test-playbook.md'),
    path.join(repoRoot, 'regression-test-playbook.md'),
  ];

  const result = checkSettingsPermissions({ settingsPath, playbookPaths });

  if (result.errors.length) {
    console.error('FAIL -- could not verify permission coverage:');
    for (const e of result.errors) console.error(`  ${e}`);
  }
  if (result.missing.length) {
    console.error(result.errors.length ? '' : 'FAIL -- uncovered required permission prefixes:');
    for (const m of result.missing) console.error(`  ${m}`);
  }
  if (result.ok) {
    console.log(`PASS -- all ${result.required.length} required permission prefixes are covered by ${settingsPath}`);
  }
  process.exit(result.ok ? 0 : 1);
}

// Only run as CLI when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
