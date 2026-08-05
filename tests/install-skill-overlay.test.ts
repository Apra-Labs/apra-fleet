import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overlayDirSync } from '../src/cli/install.js';

/**
 * The root `skills/pm/` overlay is copied over the apra-fleet-se PM skill during
 * install (install.ts, PM skill step). Both directories carry `SKILL.md`,
 * `doer-reviewer-loop.md` and `simple-sprint.md`. With a plain recursive copy the
 * retired 4-role root `SKILL.md` silently replaces the vendored 8-role one, and
 * the install reports success. The overlay must be additive only.
 */
describe('PM skill overlay is additive and never clobbers vendored files', () => {
  let tmp: string;
  let src: string;
  let dest: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-overlay-'));
    src = path.join(tmp, 'src');
    dest = path.join(tmp, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('copies files that the destination does not already have', () => {
    fs.writeFileSync(path.join(src, 'kb-agent.md'), 'root-only addition');

    const skipped = overlayDirSync(src, dest);

    expect(fs.readFileSync(path.join(dest, 'kb-agent.md'), 'utf-8')).toBe('root-only addition');
    expect(skipped).toEqual([]);
  });

  it('does NOT overwrite a file the destination already owns, and reports it', () => {
    fs.writeFileSync(path.join(src, 'SKILL.md'), 'retired 4-role SKILL');
    fs.writeFileSync(path.join(dest, 'SKILL.md'), 'vendored 8-role SKILL');

    const skipped = overlayDirSync(src, dest);

    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8')).toBe('vendored 8-role SKILL');
    expect(skipped).toEqual(['SKILL.md']);
  });

  it('preserves the vendored 8-role PM skill across the full colliding set', () => {
    // The three real collisions between root skills/pm/ and apra-fleet-se/apra-pm/skills/pm/.
    for (const name of ['SKILL.md', 'doer-reviewer-loop.md', 'simple-sprint.md']) {
      fs.writeFileSync(path.join(src, name), `root ${name}`);
      fs.writeFileSync(path.join(dest, name), `vendored ${name}`);
    }
    fs.writeFileSync(path.join(src, 'tpl-planner.md'), 'root-only template');

    const skipped = overlayDirSync(src, dest);

    for (const name of ['SKILL.md', 'doer-reviewer-loop.md', 'simple-sprint.md']) {
      expect(fs.readFileSync(path.join(dest, name), 'utf-8')).toBe(`vendored ${name}`);
    }
    expect(fs.readFileSync(path.join(dest, 'tpl-planner.md'), 'utf-8')).toBe('root-only template');
    expect(skipped.sort()).toEqual(['SKILL.md', 'doer-reviewer-loop.md', 'simple-sprint.md'].sort());
  });

  it('recurses into subdirectories, applying the same no-clobber rule', () => {
    fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(src, 'nested', 'shared.md'), 'root nested');
    fs.writeFileSync(path.join(dest, 'nested', 'shared.md'), 'vendored nested');
    fs.writeFileSync(path.join(src, 'nested', 'new.md'), 'root nested addition');

    const skipped = overlayDirSync(src, dest);

    expect(fs.readFileSync(path.join(dest, 'nested', 'shared.md'), 'utf-8')).toBe('vendored nested');
    expect(fs.readFileSync(path.join(dest, 'nested', 'new.md'), 'utf-8')).toBe('root nested addition');
    expect(skipped).toEqual([path.join('nested', 'shared.md')]);
  });
});
