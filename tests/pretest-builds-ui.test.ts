import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ciYml = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('root pretest builds the UI workspaces', () => {
  it('runs build:contract and then a UI build', () => {
    const pretest: string = pkg.scripts.pretest;
    const contractAt = pretest.indexOf('build:contract');
    const uiMatch = /build:ui(:checked)?(?![\w:-])/.exec(pretest);
    expect(contractAt).toBeGreaterThanOrEqual(0);
    expect(uiMatch).not.toBeNull();
    expect(uiMatch!.index).toBeGreaterThan(contractAt);
  });

  it('build:ui builds ui-kit before shell-ui', () => {
    const ui: string = pkg.scripts['build:ui'];
    const kit = ui.indexOf('@apralabs/apra-fleet-ui-kit');
    const shell = ui.indexOf('@apralabs/apra-fleet-shell-ui');
    expect(kit).toBeGreaterThanOrEqual(0);
    expect(shell).toBeGreaterThan(kit);
  });

  it('ci.yml has no stale "not in the root files list" comment while files includes the shell dist', () => {
    const files: string[] = pkg.files ?? [];
    expect(files.some((f) => f.replace(/\/+$/, '') === 'packages/apra-fleet-shell-ui/dist')).toBe(true);
    expect(ciYml).not.toContain('not in the root files list');
  });
});
