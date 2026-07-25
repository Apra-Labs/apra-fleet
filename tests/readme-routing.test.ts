import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('README routing verification', () => {
  let readmeContent: string;

  beforeEach(() => {
    const readmePath = join(process.cwd(), 'README.md');
    readmeContent = readFileSync(readmePath, 'utf-8');
  });

  it('contains /auto-sprint descriptors (local, claude-only, deterministic)', () => {
    expect(readmeContent).toContain('/auto-sprint');
    expect(readmeContent).toMatch(/local[\s\S]*?claude-only[\s\S]*?deterministic/i);
  });

  it('contains /pm descriptors (fleet, cross-provider, model-driven)', () => {
    expect(readmeContent).toContain('/pm');
    expect(readmeContent).toContain('cross-provider');
    expect(readmeContent).toContain('model-driven');
  });

  it('contains "amplifiers for both" framing', () => {
    expect(readmeContent).toMatch(/amplifiers[\s\S]*?decision-makers/i);
  });

  it('mentions execution-only-roles', () => {
    expect(readmeContent).toContain('execution-only');
    expect(readmeContent).toContain('planner');
    expect(readmeContent).toContain('doer');
    expect(readmeContent).toContain('reviewer');
    expect(readmeContent).toContain('deployer');
    expect(readmeContent).toContain('harvester');
  });

  it('verifies all routing distinctions are present', () => {
    // Comprehensive check: the routing paragraph section should exist
    const hasAutoSprintSection = readmeContent.includes('`/auto-sprint` vs `/pm`');
    expect(hasAutoSprintSection).toBe(true);

    // Verify all four acceptance criteria are somewhere in the document
    expect(readmeContent).toMatch(/local[\s\S]*?claude-only[\s\S]*?deterministic/i);
    expect(readmeContent).toContain('cross-provider');
    expect(readmeContent).toContain('model-driven');
    expect(readmeContent).toMatch(/amplifiers[\s\S]*?decision-makers/i);
    expect(readmeContent).toContain('execution-only');
  });
});
