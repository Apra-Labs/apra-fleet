import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('CI npm-publish job validation', () => {
  let workflowContent: string;

  beforeAll(() => {
    const workflowPath = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');
    workflowContent = fs.readFileSync(workflowPath, 'utf-8');
  });

  it('npm-publish job exists in ci.yml', () => {
    expect(workflowContent).toMatch(/^\s*npm-publish:/m);
  });

  it('npm-publish job has needs: build-and-test', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/needs:\s*(build-and-test|\[build-and-test\])/);
  });

  it('npm-publish job has if: startsWith(github.ref, \'refs/tags/v\')', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(
      /if:\s*startsWith\(\s*github\.ref\s*,\s*'refs\/tags\/v'\s*\)/
    );
  });

  it('npm-publish job has job-level permissions.id-token: write', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/permissions:[\s\S]*?id-token:\s*write/);
  });

  it('npm-publish job includes version lockstep guard step', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/Version lockstep guard/i);
  });

  it('npm-publish job includes shebang check step', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/Verify shebang/i);
  });

  it('npm-publish job includes dry-run pack verification step', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/Dry-run pack verification/i);
  });

  it('npm-publish job includes already-published idempotency check step', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/Check if version already published/i);
  });

  it('npm-publish job includes clean-pack guard rejecting exe/sea artifacts', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/Clean-pack guard/i);
    // Verify the guard checks for .exe and sea artifacts
    expect(npmPublishSection).toMatch(/exe.*sea|sea.*exe/);
  });

  it('release job does NOT list npm-publish in its needs', () => {
    const releaseSection = workflowContent.match(/^\s*release:[\s\S]*?(?=\n  [a-z-]+:|$)/m)?.[0];
    expect(releaseSection).toBeDefined();
    // Extract the needs line
    const needsMatch = releaseSection?.match(/needs:\s*(\[.*?\]|[\w,-\s]+)/);
    expect(needsMatch).toBeDefined();
    const needsValue = needsMatch?.[1] ?? '';
    expect(needsValue).not.toMatch(/npm-publish/);
  });

  it('npm-publish job runs on ubuntu-latest', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/runs-on:\s*ubuntu-latest/);
  });

  it('npm-publish job has environment: npm', () => {
    const npmPublishSection = workflowContent.match(/npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0];
    expect(npmPublishSection).toBeDefined();
    expect(npmPublishSection).toMatch(/environment:\s*npm/);
  });

  it('existing jobs (build-and-test, package, build-binary, sign-windows, release) still exist', () => {
    expect(workflowContent).toMatch(/^\s*build-and-test:/m);
    expect(workflowContent).toMatch(/^\s*package:/m);
    expect(workflowContent).toMatch(/^\s*build-binary:/m);
    expect(workflowContent).toMatch(/^\s*sign-windows:/m);
    expect(workflowContent).toMatch(/^\s*release:/m);
  });

  it('no npm publish command runs outside ci.yml npm-publish job', () => {
    // Check that there's no `npm publish` in any other job
    const otherJobsContent = workflowContent.replace(
      /npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)/,
      ''
    );
    // Verify npm publish only appears in npm-publish job (context: NODE_AUTH_TOKEN)
    expect(otherJobsContent).not.toMatch(/npm\s+publish\s+--provenance/);
  });
});
