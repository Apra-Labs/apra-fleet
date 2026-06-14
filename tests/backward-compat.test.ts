import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getProvider } from '../src/providers/index.js';
import type { LlmProvider } from '../src/types.js';

const VENDOR_PM = join(__dirname, '..', 'vendor', 'apra-pm');
const SKILL_DIR = join(VENDOR_PM, 'skills', 'pm');
const AGENTS_DIR = join(VENDOR_PM, 'agents');

function readSkill(file: string): string {
  return readFileSync(join(SKILL_DIR, file), 'utf-8');
}

// -- (a) Old /pm commands map to equivalents in the new pm skill ----------------

describe('old /pm commands have equivalents in new pm skill', () => {
  const skillMd = readSkill('SKILL.md');
  const allSkillFiles = [
    skillMd,
    readSkill('sprint.md'),
    readSkill('doer-reviewer-loop.md'),
    readSkill('beads.md'),
    readSkill('simple-sprint.md'),
    readSkill('fleet-addendum.md'),
  ].join('\n');

  const commands: Array<{ name: string; pattern: RegExp }> = [
    { name: '/pm init', pattern: /\/pm init/i },
    { name: '/pm pair', pattern: /\/pm pair/i },
    { name: '/pm plan', pattern: /\/pm plan/i },
    { name: '/pm start', pattern: /\/pm start/i },
    { name: '/pm status', pattern: /\/pm status/i },
    { name: '/pm resume', pattern: /\/pm resume/i },
    { name: '/pm deploy', pattern: /\/pm deploy/i },
    { name: '/pm recover', pattern: /\/pm recover/i },
    { name: '/pm cleanup', pattern: /\/pm cleanup/i },
    { name: '/pm backlog', pattern: /\/pm backlog/i },
    { name: '/pm tasks', pattern: /\/pm tasks/i },
  ];

  for (const cmd of commands) {
    it(`${cmd.name} is documented in the new pm skill`, () => {
      expect(cmd.pattern.test(allSkillFiles)).toBe(true);
    });
  }
});

// -- (b) Old state-file formats still work (filenames unchanged) ----------------

describe('sprint state-file names are preserved', () => {
  const allContent = [
    readSkill('SKILL.md'),
    readSkill('sprint.md'),
    readSkill('doer-reviewer-loop.md'),
  ].join('\n');

  const stateFiles = [
    'PLAN.md',
    'progress.json',
    'feedback.md',
    'status.md',
    'requirements.md',
  ];

  for (const file of stateFiles) {
    it(`${file} is referenced in the new pm skill`, () => {
      expect(allContent).toContain(file);
    });
  }

  it('tpl-progress.json template exists', () => {
    expect(existsSync(join(SKILL_DIR, 'tpl-progress.json'))).toBe(true);
  });
});

// -- (c) Beads lifecycle hooks unchanged ----------------------------------------

describe('beads lifecycle hooks are preserved', () => {
  const beadsMd = readSkill('beads.md');
  const skillMd = readSkill('SKILL.md');
  const allContent = beadsMd + '\n' + skillMd;

  const lifecycleTerms = [
    'bd create',
    'bd close',
    'bd ready',
    'bd update',
    'bd list',
    'bd show',
  ];

  for (const term of lifecycleTerms) {
    it(`beads command "${term}" is documented`, () => {
      expect(allContent.toLowerCase()).toContain(term.toLowerCase());
    });
  }

  it('beads.md references epic lifecycle', () => {
    expect(beadsMd.toLowerCase()).toContain('epic');
  });
});

// -- (d) Provider-specific context-file filenames preserved ---------------------

describe('provider instruction filenames are correct', () => {
  const expected: Record<LlmProvider, string> = {
    claude: 'CLAUDE.md',
    gemini: 'GEMINI.md',
    codex: 'AGENTS.md',
    copilot: 'COPILOT.md',
    agy: 'AGY.md',
    opencode: 'AGENTS.md',
  };

  for (const [provider, filename] of Object.entries(expected)) {
    it(`${provider} -> ${filename}`, () => {
      const adapter = getProvider(provider as LlmProvider);
      expect(adapter.instructionFileName).toBe(filename);
    });
  }
});

// -- Agent files exist ----------------------------------------------------------

describe('agent definition files are present in vendor/apra-pm', () => {
  const agents = ['planner.md', 'doer.md', 'reviewer.md', 'plan-reviewer.md'];

  for (const agent of agents) {
    it(`agents/${agent} exists`, () => {
      expect(existsSync(join(AGENTS_DIR, agent))).toBe(true);
    });
  }
});

// -- Skill sub-documents exist --------------------------------------------------

describe('pm skill sub-documents are present', () => {
  const docs = [
    'SKILL.md',
    'beads.md',
    'doer-reviewer-loop.md',
    'sprint.md',
    'worktrees.md',
    'simple-sprint.md',
    'fleet-addendum.md',
    'tpl-progress.json',
  ];

  for (const doc of docs) {
    it(`skills/pm/${doc} exists`, () => {
      expect(existsSync(join(SKILL_DIR, doc))).toBe(true);
    });
  }
});
