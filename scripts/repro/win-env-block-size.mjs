#!/usr/bin/env node
/**
 * Measure the environment block a local fleet member hands to bd/dolt/git,
 * before and after the child-env bounding rule (src/os/child-env-bound.ts).
 *
 * Evidence tool for the Windows "fork/exec ...git.exe: Not enough memory
 * resources are available to process this command" failure (CreateProcess
 * ERROR_NOT_ENOUGH_MEMORY while RAM is free). Run it ON the affected host,
 * from the same shell/service context the fleet server runs in:
 *
 *   npm run build
 *   node scripts/repro/win-env-block-size.mjs                 # this process's env
 *   node scripts/repro/win-env-block-size.mjs --env-json f.json  # a captured env
 *   node scripts/repro/win-env-block-size.mjs --sep ';'       # force PATH separator
 *
 * A captured env is a flat JSON object of NAME -> VALUE, e.g. from
 *   node -e "process.stdout.write(JSON.stringify(process.env))" > f.json
 *
 * Prints: total block size (UTF-16 code units, what CreateProcess copies),
 * the 10 largest variables, PATH length / entry count / duplicate count, and
 * the same figures after boundChildEnv(). Read-only: spawns nothing, writes
 * nothing.
 *
 * ASCII only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(path.resolve(here, '..', '..', 'dist', 'os', 'child-env-bound.js')).href;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pathStats(env, sep) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (!key) return { key: null, length: 0, entries: 0, duplicates: 0 };
  const entries = env[key].split(sep).map((e) => e.trim()).filter(Boolean);
  const norm = entries.map((e) => e.replace(/[\\/]+$/, '').toLowerCase());
  return { key, length: env[key].length, entries: entries.length, duplicates: norm.length - new Set(norm).size };
}

function largest(env, n) {
  return Object.entries(env)
    .map(([k, v]) => ({ name: k, chars: k.length + 1 + String(v).length + 1 }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, n);
}

const { boundChildEnv, envBlockSize, CHILD_ENV_BLOCK_CAP_CHARS } = await import(modUrl);

const file = arg('--env-json');
const raw = file ? JSON.parse(readFileSync(file, 'utf8')) : { ...process.env };
const env = {};
for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) env[k] = String(v);
const sep = arg('--sep') ?? (process.platform === 'win32' ? ';' : ':');

const before = { block: envBlockSize(env), vars: Object.keys(env).length, path: pathStats(env, sep) };
const { env: boundedEnv, report } = boundChildEnv(env, { sep });
const after = { block: envBlockSize(boundedEnv), vars: Object.keys(boundedEnv).length, path: pathStats(boundedEnv, sep) };

const out = {
  source: file ? `file:${file}` : 'process.env',
  platform: process.platform,
  pathSeparator: sep,
  capChars: CHILD_ENV_BLOCK_CAP_CHARS,
  before: { ...before, largest: largest(env, 10) },
  after: { ...after, dropped: report.dropped, overCap: report.overCap },
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
