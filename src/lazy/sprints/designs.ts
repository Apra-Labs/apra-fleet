/**
 * Sprint designs: which steps a sprint runs, and how.
 *
 * A design is the engine's recipe (packages/apra-fleet-se/fleet-sprint/recipe.mjs)
 * plus the few settings the launcher owns: how many cycles, the check run after
 * each landing, and how many helpers a classic sprint uses. Built-in designs
 * live here; your own live in ~/.lazyfleet/designs/, and a project can ship its
 * own in <project>/.lazyfleet/designs/ (those win over yours with the same id).
 * The engine's normalizeRecipe() is the one validator for the recipe part.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lazyDir } from '../config.js';
import { engineCli } from './engine-path.js';

export type PlanRun = 'always' | 'when-needed' | 'first-cycle' | 'off';
export type BuildMode = 'classic' | 'pipeline' | 'off';
export type Tier = 'cheap' | 'standard' | 'premium';

export interface DesignBlock {
  slot?: 'after-build' | 'finish';
  kind: 'check' | 'work' | 'command';
  name: string;
  instructions?: string;
  command?: string;
  model?: Tier;
  onFail?: 'new-task' | 'ignore';
}

export interface Design {
  id: string;
  name: string;
  description: string;
  source?: 'built-in' | 'mine' | 'project';
  /** Launcher settings. */
  cycles?: number;
  check?: string;
  helpers?: number;
  /** Recipe settings (engine). */
  plan?: { run?: PlanRun; review?: boolean };
  build?: { mode?: BuildMode; minModel?: Tier; acceptanceTasks?: boolean };
  review?: { run?: 'on' | 'off'; split?: 'auto' | 'always' | 'never'; splitMinFiles?: number };
  test?: { run?: 'auto' | 'off' };
  blocks?: DesignBlock[];
  finish?: { finalReview?: boolean; harvest?: boolean };
  /** Set on designs the advisor wrote from your sprint history (advisor.ts). */
  auto?: { basedOn: string; evidence: string[]; runs: number; updatedAt: string; locked?: boolean };
}

// Chosen by the design benchmarks (docs/lazy-sprint-designs.md): as correct as
// the others, fastest on the larger task, and half the cost of Pipeline.
export const DEFAULT_DESIGN = 'fast-pipeline';

export const BUILT_IN_DESIGNS: Design[] = [
  {
    id: 'classic',
    name: 'Classic',
    description: 'Plans the work, builds it in small rounds, and reviews each round before the next. Careful and a bit slower; wrote the strongest tests in our tests.',
    helpers: 3,
    build: { mode: 'classic' },
  },
  {
    id: 'pipeline',
    name: 'Pipeline',
    description: 'Every task gets its own helper at the same time; finished work is merged one piece at a time, then several reviewers check it together.',
    build: { mode: 'pipeline' },
  },
  {
    id: 'fast-pipeline',
    name: 'Fast pipeline',
    description: 'Builds everything at once, like Pipeline, but skips the extra steps that slow small jobs down. The best all-rounder in our tests, and the default.',
    plan: { run: 'when-needed' },
    build: { mode: 'pipeline', minModel: 'standard', acceptanceTasks: false },
    review: { split: 'auto', splitMinFiles: 20 },
    finish: { harvest: false },
  },
  {
    id: 'features-only',
    name: 'Features only',
    description: 'Builds everything at once with no reviews at all. Very fast; only your check command (for example the tests) guards what gets merged.',
    plan: { run: 'when-needed', review: false },
    build: { mode: 'pipeline', minModel: 'standard', acceptanceTasks: false },
    review: { run: 'off' },
    finish: { finalReview: false, harvest: false },
  },
  {
    id: 'solo',
    name: 'Solo',
    description: 'One helper does the whole job in one go, then one final review. Cheapest and fastest; fine for small, focused changes.',
    helpers: 2,
    plan: { run: 'off' },
    build: { mode: 'classic', minModel: 'standard' },
    review: { run: 'off' },
    finish: { harvest: false },
  },
  {
    id: 'e2e-only',
    name: 'End-to-end tests only',
    description: 'Changes no product code: a helper writes and runs end-to-end tests of what you describe, and every failure becomes a task to fix later.',
    cycles: 1,
    helpers: 2,
    plan: { run: 'off' },
    build: { mode: 'off' },
    review: { run: 'off' },
    test: { run: 'off' },
    finish: { finalReview: false, harvest: false },
    blocks: [
      {
        kind: 'work',
        name: 'Write end-to-end tests',
        model: 'standard',
        instructions:
          'Write end-to-end tests for the behaviour described in the sprint issue, using the test tools this project ' +
          'already uses (add a separate test file or folder if it has none). Test through the public entry points only. ' +
          'Do NOT change any product code, even when a test fails: a failing test is a finding, not something to fix here. ' +
          'Run the tests, commit the test files, and list each failing behaviour in your notes.',
      },
      {
        kind: 'check',
        name: 'Report failures',
        instructions:
          'Run the end-to-end tests that were just added. For every behaviour that fails, return a newTask whose title ' +
          'names the broken behaviour and whose description gives the failing test, the expected result and the actual ' +
          'result. Do not reopen anything. Return APPROVED only if every end-to-end test passes.',
      },
    ],
  },
  {
    id: 'classic-docs-check',
    name: 'Classic + docs check',
    description: 'Classic, plus a check after every round that each example in the README actually runs and prints what it says.',
    helpers: 3,
    build: { mode: 'classic' },
    blocks: [
      {
        kind: 'check',
        name: 'Docs match the code',
        instructions:
          'Every usage example in README.md must run against the current code and produce exactly the output or value ' +
          'the README says it does. Run each one. Any example that fails, or that documents something the code does not ' +
          'export, is a finding.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function myDir(): string {
  return path.join(lazyDir(), 'designs');
}

function projectDir(repo?: string): string | null {
  return repo ? path.join(repo, '.lazyfleet', 'designs') : null;
}

export function designId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
}

function readDir(dir: string | null, source: 'mine' | 'project'): Design[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const out: Design[] = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Design;
      out.push({ ...d, id: d.id || f.replace(/\.json$/, ''), source });
    } catch {
      // A broken file is skipped rather than hiding every other design.
    }
  }
  return out;
}

/** Every design, built-ins first; a project's design wins over yours with the same id, and both over a built-in. */
export function listDesigns(repo?: string): Design[] {
  const byId = new Map<string, Design>();
  for (const d of BUILT_IN_DESIGNS) byId.set(d.id, { ...d, source: 'built-in' });
  for (const d of readDir(myDir(), 'mine')) byId.set(d.id, d);
  for (const d of readDir(projectDir(repo), 'project')) byId.set(d.id, d);
  return [...byId.values()];
}

export function getDesign(id: string | undefined, repo?: string): Design {
  const want = id || DEFAULT_DESIGN;
  const d = listDesigns(repo).find(x => x.id === want);
  if (!d) throw new Error(`There is no sprint design called "${want}"`);
  return d;
}

/** Save one of your designs (built-ins are copied, never changed). */
export async function saveDesign(input: Design): Promise<Design> {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Give the design a name');
  const id = designId(input.id && !BUILT_IN_DESIGNS.some(b => b.id === input.id) ? input.id : name);
  if (BUILT_IN_DESIGNS.some(b => b.id === id)) throw new Error(`"${name}" is a built-in design; save it under another name`);
  const design: Design = { ...input, id, name, description: String(input.description || '').trim() };
  delete design.source;
  await checkDesign(design);
  fs.mkdirSync(myDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(myDir(), `${id}.json`), JSON.stringify(design, null, 2) + '\n');
  return { ...design, source: 'mine' };
}

/** Write one of your designs as it is (the advisor's own, already derived from valid designs). */
export function saveDesignRaw(design: Design): void {
  const id = designId(design.id || design.name);
  if (BUILT_IN_DESIGNS.some(b => b.id === id)) throw new Error('Built-in designs cannot be replaced');
  const clean: Design = { ...design, id };
  delete clean.source;
  fs.mkdirSync(myDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(myDir(), `${id}.json`), JSON.stringify(clean, null, 2) + '\n');
}

export function deleteDesign(id: string): void {
  if (BUILT_IN_DESIGNS.some(b => b.id === id)) throw new Error('Built-in designs cannot be deleted');
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('Not a design id');
  const f = path.join(myDir(), `${id}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ---------------------------------------------------------------------------
// Translation to what the launcher and the engine take
// ---------------------------------------------------------------------------

export interface LaunchPlan {
  /** Engine mode: 'pipeline' passes --pipeline. A build turned off runs the engine's classic path with Build off. */
  mode: 'pipeline' | 'classic';
  recipe: Record<string, unknown>;
  maxCycles?: number;
  gateCommand?: string;
  helpers?: number;
}

export function launchPlanFor(design: Design): LaunchPlan {
  const buildMode = design.build?.mode ?? 'pipeline';
  const mode = buildMode === 'pipeline' ? 'pipeline' : 'classic';
  const blocks: DesignBlock[] = [...(design.blocks ?? [])];
  let gateCommand: string | undefined;
  if (design.check) {
    // The pipeline gates each landing on the check; classic runs it once after the build.
    if (mode === 'pipeline') gateCommand = design.check;
    else blocks.unshift({ kind: 'command', name: 'Check', command: design.check, onFail: 'new-task' });
  }
  const recipe: Record<string, unknown> = {
    name: design.name,
    plan: design.plan ?? {},
    build: { ...(design.build ?? {}), mode: buildMode },
    review: design.review ?? {},
    test: design.test ?? {},
    finish: design.finish ?? {},
    blocks,
  };
  return {
    mode,
    recipe,
    ...(design.cycles ? { maxCycles: design.cycles } : {}),
    ...(gateCommand ? { gateCommand } : {}),
    ...(design.helpers ? { helpers: design.helpers } : {}),
  };
}

let engineRecipe: Promise<{ normalizeRecipe: (r: unknown) => unknown; recipeProblems: (r: unknown) => string[] }> | null = null;
function engineRecipeModule() {
  engineRecipe ??= import(pathToFileURL(path.join(path.dirname(engineCli()), '..', 'fleet-sprint', 'recipe.mjs')).href);
  return engineRecipe;
}

const FIELD_WORDS: Record<string, string> = {
  'plan.run': 'Plan the work', 'plan.review': 'Review the plan', 'build.mode': 'How tasks are built', 'build.minModel': 'Model for builders',
  'build.acceptanceTasks': 'Acceptance-test tasks', 'review.run': 'Review', 'review.split': 'Reviewers', 'review.splitMinFiles': 'Big means at least this many files',
  'test.run': 'Project tests', 'finish.finalReview': 'Final review', 'finish.harvest': 'Wrap up',
};

/** The engine's validation message in the designer's own words. */
export function humanizeDesignError(message: string, design: Design): string {
  const m = /^blocks\[(\d+)\]\.(\w+) (.*)$/.exec(message);
  if (m) {
    const i = Number(m[1]);
    const b = design.blocks?.[i];
    const who = `Step ${i + 1}${b?.name ? ` (${b.name})` : ''}`;
    if (m[2] === 'instructions' && /required/.test(m[3])) return `${who}: write ${b?.kind === 'check' ? 'the rule to check' : 'what it should do'}.`;
    if (m[2] === 'command' && /required/.test(m[3])) return `${who}: write the command to run.`;
    if (m[2] === 'name') return `${who}: ${m[3].replace(/^is required$/, 'needs a name')}.`;
    return `${who}: ${m[3]}.`;
  }
  const f = /^([a-z]+\.[A-Za-z]+) (.*)$/.exec(message);
  if (f && FIELD_WORDS[f[1]]) return `${FIELD_WORDS[f[1]]}: ${f[2]}.`;
  return /[.!?]$/.test(message) ? message : message + '.';
}

/** Things that can run but that you probably want to know about. */
export function designWarnings(design: Design): string[] {
  const out: string[] = [];
  const reviewOff = design.review?.run === 'off';
  const finalOff = design.finish?.finalReview === false;
  const checks = (design.blocks ?? []).some(b => b.kind === 'check' || b.kind === 'command');
  if (reviewOff && finalOff && !design.check && !checks && (design.build?.mode ?? 'pipeline') !== 'off') {
    out.push('Nothing checks this work: no review, no final review and no check command. Fine for throwaway work; risky for anything you will merge.');
  }
  if ((design.build?.mode ?? 'pipeline') === 'pipeline' && !design.check) out.push('Tip: set "Check after each merge" (for example your test command) so a broken task is never merged.');
  return out;
}

/** Throws with a readable message when the design cannot run. */
export async function checkDesign(design: Design): Promise<void> {
  if (design.cycles !== undefined && (!Number.isInteger(design.cycles) || design.cycles < 1 || design.cycles > 10)) {
    throw new Error('Cycles must be a whole number from 1 to 10');
  }
  if (design.helpers !== undefined && (!Number.isInteger(design.helpers) || design.helpers < 2 || design.helpers > 64)) {
    throw new Error('Helpers must be a whole number from 2 to 64 (one of them keeps the books)');
  }
  if (design.check !== undefined && design.check !== '' && (typeof design.check !== 'string' || design.check.length > 300 || /[\r\n]/.test(design.check))) {
    throw new Error('The check must be one line of at most 300 characters');
  }
  const { normalizeRecipe } = await engineRecipeModule();
  try {
    normalizeRecipe(launchPlanFor(design).recipe);
  } catch (e) {
    throw new Error(humanizeDesignError((e as Error).message, design));
  }
}

/** The steps a design runs, in order, for display. */
export function designSteps(design: Design): Array<{ step: string; detail: string; on: boolean }> {
  const plan = design.plan?.run ?? 'always';
  const build = design.build?.mode ?? 'pipeline';
  const review = design.review?.run ?? 'on';
  const blocks = design.blocks ?? [];
  const planDetail = { always: 'every cycle', 'when-needed': 'again only for new work', 'first-cycle': 'first cycle only', off: '' }[plan];
  const steps = [
    { step: 'Plan', detail: plan === 'off' ? 'off' : `${planDetail}${design.plan?.review === false ? ', not reviewed' : ''}`, on: plan !== 'off' },
    {
      step: 'Build',
      detail: build === 'off' ? 'off' : `${build === 'pipeline' ? 'all ready tasks at once' : 'round by round'}${design.build?.minModel ? `, at least ${design.build.minModel}` : ''}${design.check ? `, check: ${design.check}` : ''}`,
      on: build !== 'off',
    },
    ...blocks.filter(b => (b.slot ?? 'after-build') === 'after-build').map(b => ({ step: b.name, detail: blockDetail(b), on: true })),
    {
      step: 'Review',
      detail: review === 'off' ? 'off' : build === 'pipeline' ? (design.review?.split === 'auto' ? 'end of cycle, split when big' : design.review?.split === 'never' ? 'end of cycle, one reviewer' : 'end of cycle, split') : 'after every round',
      on: review !== 'off',
    },
    { step: 'Test', detail: design.test?.run === 'off' ? 'off' : 'only if your project has test instructions', on: design.test?.run !== 'off' },
    ...blocks.filter(b => b.slot === 'finish').map(b => ({ step: b.name, detail: blockDetail(b), on: true })),
    { step: 'Final review', detail: design.finish?.finalReview === false ? 'off (done means no tasks left open)' : 'yes', on: design.finish?.finalReview !== false },
    { step: 'Wrap up', detail: design.finish?.harvest === false ? 'off' : 'docs and changelog', on: design.finish?.harvest !== false },
  ];
  return steps;
}

function blockDetail(b: DesignBlock): string {
  if (b.kind === 'command') return `runs ${b.command}`;
  if (b.kind === 'check') return b.onFail === 'ignore' ? 'custom check, report only' : 'custom check';
  return `custom work${b.model ? `, ${b.model}` : ''}`;
}
