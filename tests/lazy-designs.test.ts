import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-designs-'));
const prevLazy = process.env.LAZYFLEET_DIR;
process.env.LAZYFLEET_DIR = path.join(tmp, 'lazy');
const designs = await import('../src/lazy/sprints/designs.js');

afterAll(() => {
  process.env.LAZYFLEET_DIR = prevLazy;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('built-in sprint designs', () => {
  it('every built-in design passes the engine validator', async () => {
    for (const d of designs.BUILT_IN_DESIGNS) await expect(designs.checkDesign(d), d.id).resolves.toBeUndefined();
    expect(designs.BUILT_IN_DESIGNS.some(d => d.id === designs.DEFAULT_DESIGN)).toBe(true);
    expect(new Set(designs.BUILT_IN_DESIGNS.map(d => d.id)).size).toBe(designs.BUILT_IN_DESIGNS.length);
  });

  it('maps each design onto the engine mode it needs', () => {
    const mode = (id: string) => designs.launchPlanFor(designs.getDesign(id)).mode;
    expect(mode('pipeline')).toBe('pipeline');
    expect(mode('fast-pipeline')).toBe('pipeline');
    expect(mode('classic')).toBe('classic');
    expect(mode('solo')).toBe('classic');
    expect(mode('e2e-only')).toBe('classic');
  });

  it('describes its steps in order, with the off ones marked', () => {
    const steps = designs.designSteps(designs.getDesign('features-only'));
    expect(steps.map(s => s.step)).toEqual(['Plan', 'Build', 'Review', 'Test', 'Final review', 'Wrap up']);
    expect(steps.filter(s => !s.on).map(s => s.step)).toEqual(['Review', 'Final review', 'Wrap up']);
    const e2e = designs.designSteps(designs.getDesign('e2e-only'));
    expect(e2e.map(s => s.step)).toContain('Write end-to-end tests');
  });
});

describe('your own designs', () => {
  it('saves, lists and deletes a design, and never overwrites a built-in', async () => {
    const saved = await designs.saveDesign({ id: '', name: 'My Lean', description: 'no docs', build: { mode: 'classic' }, finish: { harvest: false } });
    expect(saved).toMatchObject({ id: 'my-lean', source: 'mine' });
    expect(designs.listDesigns().find(d => d.id === 'my-lean')).toMatchObject({ name: 'My Lean', source: 'mine' });
    await expect(designs.saveDesign({ id: 'classic', name: 'Classic', description: '' })).rejects.toThrow(/built-in/);
    expect(() => designs.deleteDesign('classic')).toThrow(/cannot be deleted/);
    designs.deleteDesign('my-lean');
    expect(designs.listDesigns().some(d => d.id === 'my-lean')).toBe(false);
  });

  it('refuses a design the engine cannot run, with the reason', async () => {
    await expect(designs.saveDesign({ id: '', name: 'Broken', description: '', plan: { run: 'sometimes' as any } })).rejects.toThrow(/plan\.run must be one of/);
    await expect(designs.saveDesign({ id: '', name: 'Idle', description: '', build: { mode: 'off' }, plan: { run: 'off' }, test: { run: 'off' }, finish: { finalReview: false } })).rejects.toThrow(/does nothing/);
    await expect(designs.saveDesign({ id: '', name: 'Loop', description: '', cycles: 99 })).rejects.toThrow(/Cycles/);
  });

  it("a project's design wins over yours and over a built-in with the same id", () => {
    const repo = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(repo, '.lazyfleet', 'designs'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.lazyfleet', 'designs', 'classic.json'), JSON.stringify({ name: 'Team classic', description: 'ours', build: { mode: 'classic' } }));
    expect(designs.getDesign('classic', repo)).toMatchObject({ name: 'Team classic', source: 'project' });
    expect(designs.getDesign('classic')).toMatchObject({ name: 'Classic', source: 'built-in' });
  });
});
