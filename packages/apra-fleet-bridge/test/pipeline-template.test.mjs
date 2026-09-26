// Drift guard for templates/azure-pipelines.yml and the example that extends it.
//
// WHY: the first template was written against the design document and never
// run. Every flag it passed was wrong and nothing noticed, because the CLI
// ignored unknown flags and nothing executed the YAML. The CLI now rejects
// unknown flags (src/cli/flags.mjs), but that only fires when a pipeline
// actually runs -- on a self-hosted agent, possibly weeks after the rename
// that broke it. This test moves the failure to `npm test`: it extracts every
// `fleet-bridge <verb>` invocation from the template and checks each `--flag`
// against the SAME per-verb declaration the CLI enforces. Rename a flag in the
// CLI without updating the template, or add a stale flag to the template, and
// this goes red.
//
// It also pins the injection fix mechanically: no script body may contain a
// `${{ ... }}` template expression (a parameter value pasted into bash is
// shell injection for anyone who can queue the pipeline), and every `$FBP_*`
// environment variable a script reads must be expanded inside double quotes.
//
// One `fleet-bridge <verb>` per step is a rule of the template (stated in its
// header), so every `--flag` token in a step can be attributed to that verb.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { VERB_FLAGS, GLOBAL_FLAGS, BOOLEAN_FLAGS } from '../src/cli/flags.mjs';
import { VERBS } from '../src/cli/args.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'azure-pipelines.yml');
const EXAMPLE_PATH = path.join(__dirname, '..', 'examples', 'azure-devops-toy', 'azure-pipelines.yml');
const SCRIPT_KEYS = ['bash', 'script', 'pwsh', 'powershell'];

/** Every step-like object that carries an inline script, however deeply it
 *  sits inside `${{ each }}` / `${{ if }}` blocks. */
export function collectScriptSteps(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectScriptSteps(item, out);
  } else if (node && typeof node === 'object') {
    const key = SCRIPT_KEYS.find((k) => typeof node[k] === 'string');
    if (key) out.push({ shell: key, script: node[key], env: node.env || {}, displayName: node.displayName || '(unnamed)' });
    for (const value of Object.values(node)) collectScriptSteps(value, out);
  }
  return out;
}

/** The verb of each `fleet-bridge <verb>` call in a script (not the helper
 *  function's own definition). */
export function invokedVerbs(script) {
  const verbs = [];
  const re = /(^|[\s;&|(])fleet-bridge[ \t]+([a-z-]+)/g;
  let m;
  while ((m = re.exec(script)) !== null) verbs.push(m[2]);
  return verbs;
}

/** Every `--flag` token in a script, with `--no-x` folded to `x` for a
 *  declared boolean. */
export function flagTokens(script) {
  const names = [];
  const re = /(?<![A-Za-z0-9_-])--([A-Za-z][A-Za-z0-9-]*)/g;
  let m;
  while ((m = re.exec(script)) !== null) {
    let name = m[1];
    if (name.startsWith('no-') && BOOLEAN_FLAGS.has(name.slice(3))) name = name.slice(3);
    names.push(name);
  }
  return names;
}

/** `$FBP_X` / `${FBP_X}` expansions that bash performs OUTSIDE double quotes
 *  (inside single quotes nothing expands, so those are fine). A tiny quote
 *  tracker, good enough for the template's own scripts. */
export function unquotedEnvExpansions(script) {
  const hits = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (!inSingle && ch === '\\') { i++; continue; }
    if (!inDouble && ch === "'") { inSingle = !inSingle; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && ch === '#' && (i === 0 || /\s/.test(script[i - 1]))) {
      while (i < script.length && script[i] !== '\n') i++;
      continue;
    }
    if (!inSingle && !inDouble && ch === '$') {
      const m = /^\$\{?(FBP_[A-Z0-9_]+)/.exec(script.slice(i));
      if (m) hits.push(m[1]);
    }
  }
  return hits;
}

/** The file with every comment line removed, for whole-text checks: the
 *  template's header explains, in prose, the very things these checks forbid. */
function withoutCommentLines(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

function loadYaml(file) {
  return YAML.parse(readFileSync(file, 'utf8'));
}

describe('templates/azure-pipelines.yml against the real CLI', () => {
  const rawText = readFileSync(TEMPLATE_PATH, 'utf8');
  const text = withoutCommentLines(rawText);
  const doc = loadYaml(TEMPLATE_PATH);
  const steps = collectScriptSteps(doc);

  test('is a single YAML document (a stray --- separator splits it in two)', () => {
    assert.strictEqual(YAML.parseAllDocuments(rawText).length, 1);
  });

  test('actually invokes preflight, ingest and launch (the guard below is not vacuous)', () => {
    const all = steps.flatMap((s) => invokedVerbs(s.script));
    for (const verb of ['preflight', 'ingest', 'launch']) assert.ok(all.includes(verb), `no "fleet-bridge ${verb}" found`);
  });

  test('every step invokes at most one verb, and only real verbs', () => {
    for (const s of steps) {
      const verbs = invokedVerbs(s.script);
      assert.ok(verbs.length <= 1, `step "${s.displayName}" invokes ${verbs.join(', ')}; keep one verb per step`);
      for (const v of verbs) assert.ok(VERBS.includes(v), `step "${s.displayName}" invokes unknown verb "${v}"`);
    }
  });

  test('every --flag in a step is one its verb accepts (src/cli/flags.mjs VERB_FLAGS)', () => {
    for (const s of steps) {
      const [verb] = invokedVerbs(s.script);
      const tokens = flagTokens(s.script);
      if (!verb) {
        assert.deepStrictEqual(tokens, [], `step "${s.displayName}" has --flags but invokes no fleet-bridge verb`);
        continue;
      }
      const accepted = new Set([...VERB_FLAGS[verb], ...GLOBAL_FLAGS]);
      const bad = tokens.filter((t) => !accepted.has(t));
      assert.deepStrictEqual(
        bad, [],
        `step "${s.displayName}": fleet-bridge ${verb} does not accept ${bad.map((b) => `--${b}`).join(', ')}. `
        + `It accepts: ${[...VERB_FLAGS[verb]].map((f) => `--${f}`).join(', ')}`,
      );
    }
  });

  test('no script body contains a ${{ }} template expression (parameters reach scripts only via env:)', () => {
    for (const s of steps) {
      assert.ok(!s.script.includes('${{'), `step "${s.displayName}" interpolates a template expression into its script body`);
    }
  });

  test('every $FBP_* variable is expanded inside double quotes', () => {
    for (const s of steps) {
      assert.deepStrictEqual(unquotedEnvExpansions(s.script), [], `step "${s.displayName}" expands env unquoted`);
    }
  });

  test('every $FBP_* a script reads is mapped in that step\'s env:', () => {
    for (const s of steps) {
      const used = new Set([...s.script.matchAll(/FBP_[A-Z0-9_]+/g)].map((m) => m[0]));
      for (const name of used) assert.ok(name in s.env, `step "${s.displayName}" reads ${name} but its env: does not map it`);
    }
  });

  test('no credential is mapped into any step, and System.AccessToken is never referenced', () => {
    assert.ok(!/System\.AccessToken/i.test(text), 'the template references System.AccessToken');
    for (const s of steps) {
      for (const key of Object.keys(s.env)) {
        // A credential NAME (..._NAME) is fine; anything that looks like a
        // credential VALUE is not.
        const looksLikeCredential = /(^|_)(PAT|TOKEN|SAS|PASSWORD|SECRET|ACCESSTOKEN)(_|$)/i.test(key) && !/_NAME$/.test(key);
        assert.ok(!looksLikeCredential, `step "${s.displayName}" maps env ${key}`);
      }
    }
  });

  test('never fetches fleet-bridge from a package registry', () => {
    assert.ok(!/npm\s+exec|npx\s/.test(text), 'the template invokes npm exec / npx');
  });

  test('every ${{ parameters.X }} it references is a declared parameter', () => {
    const declared = new Set(doc.parameters.map((p) => p.name));
    for (const m of text.matchAll(/\$\{\{\s*parameters\.([A-Za-z0-9_]+)/g)) {
      assert.ok(declared.has(m[1]), `\${{ parameters.${m[1]} }} is not declared`);
    }
  });
});

describe('examples/azure-devops-toy/azure-pipelines.yml', () => {
  const doc = loadYaml(EXAMPLE_PATH);
  const template = loadYaml(TEMPLATE_PATH);

  test('extends the template through a repository resource pinned to main, a tag, or a commit', () => {
    assert.match(doc.extends.template, /^packages\/apra-fleet-bridge\/templates\/azure-pipelines\.yml@[A-Za-z0-9_-]+$/);
    const alias = doc.extends.template.split('@')[1];
    const repo = doc.resources.repositories.find((r) => r.repository === alias);
    assert.ok(repo, `no repository resource named ${alias}`);
    assert.match(String(repo.ref), /^(refs\/heads\/main|refs\/tags\/[^\s]+|[0-9a-f]{40})$/, `ref ${repo.ref} is a dev branch`);
  });

  test('passes only parameters the template declares, and every one the template requires', () => {
    const declared = new Map(template.parameters.map((p) => [p.name, p]));
    const passed = Object.keys(doc.extends.parameters);
    for (const name of passed) assert.ok(declared.has(name), `example passes unknown template parameter ${name}`);
    for (const [name, p] of declared) {
      if (p.default === undefined) assert.ok(passed.includes(name), `example omits required template parameter ${name}`);
    }
  });

  test('contains no scripts of its own', () => {
    assert.deepStrictEqual(collectScriptSteps(doc), []);
  });
});
