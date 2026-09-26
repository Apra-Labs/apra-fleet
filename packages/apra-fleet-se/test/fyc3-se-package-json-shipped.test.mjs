import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-fyc.3.2 -- regression pin for apra-fleet-fyc.3 (missing
// packages/apra-fleet-se/package.json in the root npm 'files' allowlist,
// which crashed `apra-fleet workflow fleet-sprint --help` on a real
// npm-pack install because the installed workflow tree had no package.json
// to resolve as ESM). Covers three failure surfaces:
//   1. the static 'files' allowlist entry + the shipped file's own contents
//   2. the actual install-time extraction path (buildDevManifest /
//      extractWorkflowSubsystemAssets), which a tarball-only check misses --
//      a file-level filter could still drop the file after packing
//   3. that test/ and sprint-logs/ never leak into the installed tree

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('fyc.3 regression: packages/apra-fleet-se/package.json ships and installs', () => {
    test('static allowlist assertion: root package.json files array carries the path, and the file itself is a real ESM manifest', () => {
        const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        assert.ok(
            Array.isArray(rootPkg.files) && rootPkg.files.includes('packages/apra-fleet-se/package.json'),
            `root package.json 'files' array is missing "packages/apra-fleet-se/package.json": ${JSON.stringify(rootPkg.files)}`
        );

        const sePkgPath = path.join(ROOT, 'packages', 'apra-fleet-se', 'package.json');
        assert.ok(fs.existsSync(sePkgPath), `${sePkgPath} does not exist on disk`);
        const sePkg = JSON.parse(fs.readFileSync(sePkgPath, 'utf-8'));
        assert.strictEqual(sePkg.type, 'module', 'packages/apra-fleet-se/package.json must declare "type":"module"');
    });

    test('extraction assertion: buildDevManifest + extractWorkflowSubsystemAssets install a package.json ("type":"module") into workflows/fleet-sprint', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-fyc3-home-'));
        const previousHome = process.env.HOME;
        const previousUserProfile = process.env.USERPROFILE;
        try {
            // dist/cli/config.js captures os.homedir() at module-load time, so
            // HOME/USERPROFILE must be set before it (transitively) first loads.
            process.env.HOME = tmpHome;
            process.env.USERPROFILE = tmpHome;

            const cacheBust = `${Date.now()}-${Math.random()}`;
            const installMod = await import(`../../../dist/cli/install.js?fyc3=${cacheBust}`);
            const assetsMod = await import(`../../../dist/cli/workflow-assets.js?fyc3=${cacheBust}`);
            const configMod = await import(`../../../dist/cli/config.js?fyc3=${cacheBust}`);

            const manifest = installMod.buildDevManifest(ROOT);
            assert.ok(manifest.builtinWorkflows, 'buildDevManifest() did not produce a builtinWorkflows section');

            const feSePackageJsonKey = 'fleet-sprint/package.json';
            assert.ok(
                Object.prototype.hasOwnProperty.call(manifest.builtinWorkflows, feSePackageJsonKey),
                `manifest.builtinWorkflows is missing "${feSePackageJsonKey}": ${Object.keys(manifest.builtinWorkflows).slice(0, 20).join(', ')}...`
            );

            assetsMod.extractWorkflowSubsystemAssets({
                manifest,
                extractAssetBuffer: (key) => fs.readFileSync(path.join(ROOT, key)),
                version: '0.0.0-test',
                builtinNames: ['fleet-sprint'],
            });

            const installedPkgPath = path.join(configMod.WORKFLOWS_DIR, 'fleet-sprint', 'package.json');
            assert.ok(
                fs.existsSync(installedPkgPath),
                `extracted workflow tree is missing package.json at ${installedPkgPath}`
            );
            const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8'));
            assert.strictEqual(installedPkg.type, 'module', 'installed workflows/fleet-sprint/package.json must declare "type":"module"');
        } finally {
            if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
            if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    test('shipped tree excludes packages/apra-fleet-se/test/ and packages/apra-fleet-se/sprint-logs/', () => {
        const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        const excludedPrefixes = [
            'packages/apra-fleet-se/test',
            'packages/apra-fleet-se/sprint-logs',
        ];
        for (const entry of rootPkg.files) {
            for (const excluded of excludedPrefixes) {
                assert.ok(
                    !(entry === excluded || entry.startsWith(`${excluded}/`)),
                    `root 'files' allowlist entry "${entry}" would ship excluded path "${excluded}"`
                );
            }
        }
    });
});
