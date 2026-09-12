import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const skillDir = join(root, 'skills', 'fleet');

const read = (rel: string) => readFileSync(join(skillDir, rel), 'utf-8');

// Files this change introduces. CLAUDE.md mandates ASCII-only; pre-existing skill
// docs predate that rule and are not in scope here.
const NEW_DOCS = ['autonomy.md', 'fast-local.md'];

describe('fleet skill: ASCII-only', () => {
  for (const name of NEW_DOCS) {
    it(`${name} contains no non-ASCII characters`, () => {
      const body = read(name);
      const offenders = body
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /[^\x00-\x7F]/.test(line))
        .map(({ n, line }) => `${name}:${n}: ${line}`);
      expect(offenders).toEqual([]);
    });
  }
});

describe('fleet skill: trigger description', () => {
  const skill = read('SKILL.md');
  const fm = skill.match(/^---\n([\s\S]*?)\n---/);

  it('has YAML frontmatter', () => {
    expect(fm).not.toBeNull();
  });

  it('is named fleet', () => {
    expect(fm![1]).toMatch(/^name:\s*fleet\s*$/m);
  });

  const desc = (fm?.[1].match(/^description:\s*(.+)$/m)?.[1] ?? '').toLowerCase();

  it('describes task shapes, not just mechanics', () => {
    // The skill must fire on ordinary work ("build these three things"), not only
    // when someone already knows the word "fleet".
    expect(desc).toMatch(/parallel/);
    expect(desc).toMatch(/independent/);
    expect(desc).toMatch(/long-running/);
  });

  it('does not regress to a pure mechanics description', () => {
    expect(desc.startsWith('fleet infrastructure mechanics')).toBe(false);
  });

  it('points at the decision docs before the tool tables', () => {
    const startHere = skill.indexOf('## Start here');
    const toolTable = skill.indexOf('## Core Fleet Tools');
    expect(startHere).toBeGreaterThan(-1);
    expect(startHere).toBeLessThan(toolTable);
    expect(skill).toMatch(/`autonomy\.md`/);
    expect(skill).toMatch(/`fast-local\.md`/);
  });
});

describe('fleet skill: cross-references resolve', () => {
  it('every sibling .md referenced by SKILL.md exists', () => {
    const skill = read('SKILL.md');
    // Lowercase names only - excludes provider context files (CLAUDE.md, AGY.md).
    const refs = new Set(
      [...skill.matchAll(/`([a-z][a-z0-9-]*\.md)`/g)].map((m) => m[1]),
    );
    expect(refs.size).toBeGreaterThan(0);
    const missing = [...refs].filter((r) => !existsSync(join(skillDir, r)));
    expect(missing).toEqual([]);
  });
});

describe('fleet skill: autonomy policy', () => {
  const autonomy = read('autonomy.md');

  it('states all four fan-out conditions', () => {
    expect(autonomy).toMatch(/two or more units/i);
    expect(autonomy).toMatch(/disjoint files/i);
    expect(autonomy).toMatch(/non-trivial each/i);
    expect(autonomy).toMatch(/independently checkable/i);
  });

  it('biases toward inline work', () => {
    expect(autonomy).toMatch(/bias toward inline/i);
  });

  it('caps concurrency at 3 by default', () => {
    expect(autonomy).toMatch(/ceiling:\s*3 concurrent workers/i);
  });

  it('gates billable and remote actions behind a question', () => {
    const gate = autonomy.slice(autonomy.indexOf('## Cost gate'));
    expect(gate).toMatch(/cloud_control/);
    expect(gate).toMatch(/credential_store_set/);
    expect(gate).toMatch(/it bills/i);
  });

  it('requires reaping auto-created workers', () => {
    expect(autonomy).toMatch(/tags:\s*\["auto"\]/);
    expect(autonomy).toMatch(/step 6 is not optional/i);
  });

  it('forbids fleet jargon in user-facing output', () => {
    const contract = autonomy.slice(autonomy.indexOf('## Language contract'));
    for (const banned of ['dispatch', 'provision', 'onboard', 'execute_prompt']) {
      expect(contract).toMatch(new RegExp(banned));
    }
    expect(contract).toMatch(/never write these to the user/i);
  });
});

describe('fleet skill: local path is the default', () => {
  it('fast-local.md keeps setup to four steps', () => {
    const fast = read('fast-local.md');
    expect(fast).toMatch(/## The four steps/);
    expect(fast).toMatch(/member_type:\s*"local"/);
    expect(fast).toMatch(/unattended:\s*"auto"/);
    // One worktree per worker - shared folders corrupt concurrent edits.
    expect(fast).toMatch(/git worktree add/);
  });

  it('onboarding.md routes local members away to the fast path', () => {
    const onboarding = read('onboarding.md');
    const head = onboarding.slice(0, onboarding.indexOf('## Step 1'));
    expect(head).toMatch(/remote path/i);
    expect(head).toMatch(/`fast-local\.md`/);
  });
});

describe('vocabulary: user-facing output contract', () => {
  const vocab = readFileSync(join(root, 'docs', 'vocabulary.md'), 'utf-8');

  it('declares the output contract', () => {
    expect(vocab).toMatch(/## Output Contract: What The User Never Sees/);
  });

  it('lists the banned user-facing terms', () => {
    const section = vocab.slice(vocab.indexOf('## Output Contract'));
    for (const banned of ['dispatch', 'provision', 'onboard', 'execute_prompt', 'UUID']) {
      expect(section).toMatch(new RegExp(banned));
    }
  });
});
