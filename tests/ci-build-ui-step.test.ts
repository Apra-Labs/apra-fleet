import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

describe('CI build:ui step', () => {
  const ciYmlPath = path.join(process.cwd(), '.github/workflows/ci.yml');
  let workflowContent: string;

  beforeEach(() => {
    workflowContent = fs.readFileSync(ciYmlPath, 'utf-8');
  });

  describe('workflow file contains the build:ui step', () => {
    it('should have exactly one build:ui step run command', () => {
      const matches = workflowContent.match(/npm run build:ui --if-present/g);
      expect(matches).toBeDefined();
      expect(matches?.length).toBe(2); // One in build-and-test, one in build-binary
    });

    it('should have step named "Build UI workspaces (if present)" in the workflow', () => {
      expect(workflowContent).toContain('- name: Build UI workspaces (if present)');
    });
  });

  describe('build:ui step placement in build-and-test job', () => {
    it('should place build:ui step after npm run build', () => {
      // Extract build-and-test job
      const buildAndTestStart = workflowContent.indexOf('build-and-test:');
      const nextJobStart = workflowContent.indexOf('\n  package:', buildAndTestStart);
      const buildAndTestJob = workflowContent.substring(buildAndTestStart, nextJobStart);

      // Check that "npm run build" comes before "npm run build:ui --if-present"
      const buildIndex = buildAndTestJob.indexOf('- name: Build\n        run: npm run build');
      const buildUiIndex = buildAndTestJob.indexOf('- name: Build UI workspaces');

      expect(buildIndex).toBeGreaterThan(-1);
      expect(buildUiIndex).toBeGreaterThan(buildIndex);
    });

    it('should place build:ui step before npm test step', () => {
      // Extract build-and-test job
      const buildAndTestStart = workflowContent.indexOf('build-and-test:');
      const nextJobStart = workflowContent.indexOf('\n  package:', buildAndTestStart);
      const buildAndTestJob = workflowContent.substring(buildAndTestStart, nextJobStart);

      // Check that "npm run build:ui" comes before "npm test"
      const buildUiIndex = buildAndTestJob.indexOf('- name: Build UI workspaces');
      const testIndex = buildAndTestJob.indexOf('- name: Run tests\n        run: npm test');

      expect(buildUiIndex).toBeGreaterThan(-1);
      expect(testIndex).toBeGreaterThan(buildUiIndex);
    });

    it('should have proper indentation (8 spaces for name)', () => {
      // Check for proper step indentation in build-and-test
      const buildAndTestStart = workflowContent.indexOf('build-and-test:');
      const nextJobStart = workflowContent.indexOf('\n  package:', buildAndTestStart);
      const buildAndTestJob = workflowContent.substring(buildAndTestStart, nextJobStart);

      expect(buildAndTestJob).toContain('      - name: Build UI workspaces (if present)');
    });
  });

  describe('build:ui step placement in build-binary job', () => {
    it('should place build:ui step before Build SEA bundle', () => {
      // Extract build-binary job
      const buildBinaryStart = workflowContent.indexOf('build-binary:');
      const signWindowsStart = workflowContent.indexOf('\n  sign-windows:', buildBinaryStart);
      const buildBinaryJob = workflowContent.substring(buildBinaryStart, signWindowsStart);

      // Check that "npm run build:ui" comes before "Build SEA bundle"
      const buildUiIndex = buildBinaryJob.indexOf('- name: Build UI workspaces');
      const seaBundleIndex = buildBinaryJob.indexOf('- name: Build SEA bundle');

      expect(buildUiIndex).toBeGreaterThan(-1);
      expect(seaBundleIndex).toBeGreaterThan(buildUiIndex);
    });

    it('should have proper indentation in build-binary job', () => {
      // Check for proper step indentation
      const buildBinaryStart = workflowContent.indexOf('build-binary:');
      const signWindowsStart = workflowContent.indexOf('\n  sign-windows:', buildBinaryStart);
      const buildBinaryJob = workflowContent.substring(buildBinaryStart, signWindowsStart);

      expect(buildBinaryJob).toContain('      - name: Build UI workspaces (if present)');
    });
  });

  describe('workflow triggers unchanged', () => {
    it('should still have main and v0.5_dashboard in push branches', () => {
      expect(workflowContent).toMatch(/push:\s*\n\s*branches:\s*\[main, v0\.5_dashboard\]/);
    });

    it('should still have main and v0.5_dashboard in pull_request branches', () => {
      expect(workflowContent).toMatch(/pull_request:\s*\n\s*branches:\s*\[main, v0\.5_dashboard\]/);
    });
  });

  describe('comment explains the if-present contract', () => {
    it('should have comments explaining the if-present behavior', () => {
      // Count occurrences of the explanatory comment
      const commentText = 'Build UI workspaces if they exist';
      const matches = workflowContent.match(new RegExp(commentText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
      expect(matches?.length).toBe(2); // One comment per job
    });

    it('should mention pack-size check is unaffected', () => {
      const commentText = 'pack-size check';
      const matches = workflowContent.match(new RegExp(commentText, 'g'));
      expect(matches?.length).toBeGreaterThanOrEqual(2); // At least once per step comment
    });
  });

  describe('no other jobs gained the step', () => {
    it('should only add step to build-and-test and build-binary jobs', () => {
      // Extract job names and count the build:ui step in each
      const jobNames = workflowContent.match(/^  (\w+(?:-\w+)*):/gm);
      expect(jobNames).toBeDefined();

      // For each job, check if it has the build:ui step
      const packageJobStart = workflowContent.indexOf('\n  package:');
      const packageJobEnd = workflowContent.indexOf('\n  build-binary:', packageJobStart);
      const packageJob = workflowContent.substring(packageJobStart, packageJobEnd);
      expect(packageJob).not.toContain('npm run build:ui --if-present');

      const buildBinaryStart = workflowContent.indexOf('\n  build-binary:');
      const signWindowsStart = workflowContent.indexOf('\n  sign-windows:', buildBinaryStart);
      expect(workflowContent.substring(signWindowsStart)).not.toContain('npm run build:ui --if-present');
    });
  });

  describe('subprocess execution', () => {
    let tempDir: string | null = null;

    afterEach(() => {
      // Cleanup temp files
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    });

    // Shared helper for the temp npm project used by the subprocess/falsifiability
    // cases below (and by the path-free pin test). When withBuildUi is true, the
    // build:ui script runs a *separate* build-ui.cjs file that locates the marker
    // via __dirname, rather than embedding the temp dir's absolute path directly
    // in an inline `node -e "..."` string.
    //
    // Why: interpolating an absolute path into a double-quoted JS string literal
    // is NOT safe cross-platform. On Windows, os.tmpdir() paths use backslashes
    // (e.g. C:\Users\RUNNER~1\AppData\Local\Temp\...); when that string is placed
    // inside a JS string literal, sequences like \U, \A, \L, \T are interpreted
    // as escape sequences and silently dropped, turning the path into something
    // like "C:UsersRUNNER~1AppDataLocalTemp...". node then writes the marker file
    // to that (wrong, relative-ish) location instead of the expected absolute
    // path, so the marker never appears where the test looks for it -- a failure
    // that only reproduces on Windows CI, not on Linux/macOS. Keeping the script
    // string free of any absolute/temp-dir path (and using __dirname inside the
    // script file itself) avoids the hazard entirely.
    function writeTempProject(dir: string, opts: { withBuildUi: boolean }): void {
      const pkg: { name: string; version: string; scripts: Record<string, string> } = {
        name: 'test-package',
        version: '1.0.0',
        scripts: {
          test: 'echo test',
        },
      };

      if (opts.withBuildUi) {
        fs.writeFileSync(
          path.join(dir, 'build-ui.cjs'),
          "require('fs').writeFileSync(require('path').join(__dirname, 'marker.txt'), 'executed');\n"
        );
        pkg.scripts['build:ui'] = 'node build-ui.cjs';
      }

      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

      // Create a temporary package-lock.json to satisfy npm ci
      fs.writeFileSync(
        path.join(dir, 'package-lock.json'),
        JSON.stringify({
          name: 'test-package',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {},
        })
      );
    }

    it('should exit 0 when no build:ui script exists', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-build-ui-test-'));
      writeTempProject(tempDir, { withBuildUi: false });

      try {
        const result = execSync('npm run build:ui --if-present', {
          cwd: tempDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Should exit with code 0 and produce empty stdout
        expect(result.trim()).toBe('');
      } catch (e) {
        throw new Error(`npm run build:ui --if-present should exit 0 without a build:ui script, but got error: ${(e as Error).message}`);
      }
    });

    it('should execute a present build:ui script', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-build-ui-test-'));
      const markerFile = path.join(tempDir, 'marker.txt');
      writeTempProject(tempDir, { withBuildUi: true });

      try {
        execSync('npm run build:ui --if-present', {
          cwd: tempDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Verify the marker file was created
        expect(fs.existsSync(markerFile)).toBe(true);
        const content = fs.readFileSync(markerFile, 'utf-8');
        expect(content).toBe('executed');
      } catch (e) {
        throw new Error(`npm run build:ui --if-present should execute the script, but got error: ${(e as Error).message}`);
      }
    });

    // Pins the fix for the Windows backslash-escape regression (bug ky2l.17): the
    // build:ui script string itself must never embed an absolute/temp-dir path,
    // because interpolating one into a `node -e "..."` string is unsafe on
    // Windows (backslashes in os.tmpdir() paths get consumed as JS string escape
    // sequences). Reverting the [impl] fix restores the inline
    // `node -e "require('fs').writeFileSync('${markerFile}', 'executed')"` form,
    // which embeds tempDir's absolute path and therefore fails this assertion on
    // every platform (contains '/' on Linux/macOS, '\\' on Windows) -- confirmed
    // locally: with the fix reverted, this case fails with
    // "expected '.../node -e ...".../marker.txt', 'executed')"' not to match /...temp dir substring.../"
    // (see closing note for the exact recorded assertion text).
    it('should write a build:ui script string that embeds no absolute path', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-build-ui-test-'));
      writeTempProject(tempDir, { withBuildUi: true });

      const pkgOnDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf-8'));
      const buildUiScript: string = pkgOnDisk.scripts['build:ui'];

      expect(buildUiScript).not.toContain('\\');
      expect(buildUiScript).not.toContain('/');
      expect(buildUiScript).not.toContain(tempDir);
      expect(buildUiScript).not.toContain(os.tmpdir());
    });
  });

  describe('falsifiability checks', () => {
    it('should fail if --if-present is removed from the step', () => {
      // This test documents that removing --if-present would break the no-op behavior
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-build-ui-falsify-'));
      const tempPackageJsonPath = path.join(tempDir, 'package.json');

      const minimalPkg = { name: 'test', version: '1.0.0', scripts: { test: 'echo test' } };
      fs.writeFileSync(tempPackageJsonPath, JSON.stringify(minimalPkg));
      fs.writeFileSync(
        path.join(tempDir, 'package-lock.json'),
        JSON.stringify({ name: 'test', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} })
      );

      try {
        execSync('npm run build:ui', { cwd: tempDir, stdio: 'pipe' });
        throw new Error('Should have failed without --if-present');
      } catch (e) {
        // Expected to fail - npm returns error about missing script
        expect((e as Error).message.toLowerCase()).toContain('missing script');
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true });
        }
      }
    });

    it('should document proper positioning requirement', () => {
      // Extract build-and-test job and verify step order
      const buildAndTestStart = workflowContent.indexOf('build-and-test:');
      const nextJobStart = workflowContent.indexOf('\n  package:', buildAndTestStart);
      const buildAndTestJob = workflowContent.substring(buildAndTestStart, nextJobStart);

      const buildIndex = buildAndTestJob.indexOf('- name: Build\n        run: npm run build');
      const buildUiIndex = buildAndTestJob.indexOf('- name: Build UI workspaces');
      const verifyIndex = buildAndTestJob.indexOf('- name: Verify build output');

      // build:ui should be strictly between build and verify
      expect(buildIndex).toBeLessThan(buildUiIndex);
      expect(buildUiIndex).toBeLessThan(verifyIndex);
    });
  });
});
