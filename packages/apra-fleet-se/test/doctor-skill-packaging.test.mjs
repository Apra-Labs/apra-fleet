import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { REGISTRY_ENTRIES } from '../fleet-sprint/doctor-registry.mjs';

// =============================================================================
// apra-fleet-iiny.6.3: the sprint-doctor skill ships in both install paths
// and stays target-agnostic (design doc section 8).
//
// Pins packaging so the skill cannot silently stop shipping:
//
//   1. SHIPS AT THE CONTRACTED PATH. skills/sprint-doctor/SKILL.md exists
//      with parseable frontmatter naming both invocation modes.
//   2. THE NPM DIST SCRIPT VENDORS IT. scripts/dist-pm.mjs's real
//      source-directory -> dist-directory copy actually runs (executed for
//      real, not asserted against a copied literal path list) and produces a
//      byte-identical dist/skills/sprint-doctor/SKILL.md.
//   3. THE SEA BINARY ASSET LIST INCLUDES IT. scripts/gen-sea-config.mjs is
//      executed for real; the resulting manifest/asset-list entries are
//      checked against the skill directory's OWN real file listing (read
//      fresh in this test), not a hardcoded file-name list, so a new file
//      added to the skill and a removed manifest entry are both caught.
//   4. STAYS TARGET-AGNOSTIC. The same deny-list approach as the registry
//      genericity test (test/doctor-registry.test.mjs) applied to SKILL.md's
//      own text, plus a check that it does not inline the registry's own
//      symptom/remedy table (the skill's own stated single-source-of-truth
//      rule, section 2 of the SKILL.md).
//
// Every assertion here reads real files / runs the real scripts, so deleting
// the corresponding wiring (the skill directory, the dist-pm.mjs copy block,
// the gen-sea-config.mjs collectFiles() call, or adding target-specific text
// to SKILL.md) fails this file rather than a hand-maintained duplicate list
// silently drifting out of sync with the packaging scripts.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/apra-fleet-se/test -> packages/apra-fleet-se -> packages -> REPO ROOT
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SE_ROOT = path.resolve(__dirname, '..');

const SKILL_REL_DIR = path.join('packages', 'apra-fleet-se', 'fleet-sprint', 'skills', 'sprint-doctor');
const SKILL_DIR = path.join(REPO_ROOT, SKILL_REL_DIR);
const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md');

/** Recursively lists every file under `dir`, returned as POSIX-style paths relative to `dir`. */
function listFilesRecursive(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listFilesRecursive(full).map((p) => path.join(entry.name, p)));
        } else {
            out.push(entry.name);
        }
    }
    return out.map((p) => p.replace(/\\/g, '/'));
}

/** Extracts the `---`-delimited YAML frontmatter block from a markdown file's text. */
function parseFrontmatter(mdText) {
    const match = mdText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(match, 'SKILL.md must open with a --- delimited frontmatter block');
    const block = match[1];
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
        if (m) fields[m[1]] = m[2];
    }
    return fields;
}

describe('sprint-doctor skill: ships at the contracted path with parseable frontmatter', () => {
    test('the skill directory and SKILL.md exist at packages/apra-fleet-se/fleet-sprint/skills/sprint-doctor', () => {
        assert.ok(fs.statSync(SKILL_DIR).isDirectory(), `${SKILL_DIR} does not exist or is not a directory`);
        assert.ok(fs.existsSync(SKILL_MD_PATH), `${SKILL_MD_PATH} does not exist`);
    });

    test('frontmatter parses and names both invocation modes', () => {
        const text = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
        const fm = parseFrontmatter(text);
        assert.equal(fm.name, 'sprint-doctor', `frontmatter name should be "sprint-doctor", got: ${fm.name}`);
        assert.ok(fm.description && fm.description.length > 0, 'frontmatter description is empty');
        // Both invocation modes named in section 8 of the design doc: the
        // in-sprint (engine-consulted) mode and the post-mortem (operator/
        // agent-invoked, batch-of-runs) mode.
        assert.match(fm.description, /in-sprint/i, 'description does not mention the in-sprint mode');
        assert.match(fm.description, /post-mortem/i, 'description does not mention the post-mortem mode');
    });
});

describe('sprint-doctor skill: the npm dist script vendors it for real', () => {
    test('scripts/dist-pm.mjs, executed for real, copies a byte-identical SKILL.md into dist/skills/sprint-doctor', () => {
        const distPmScript = path.join(REPO_ROOT, 'scripts', 'dist-pm.mjs');
        assert.ok(fs.existsSync(distPmScript), `${distPmScript} does not exist`);

        // Run the REAL script (dist/ is gitignored build output -- writing to
        // it here is exactly what `npm run dist`/prepublishOnly already does,
        // and is idempotent). This is what makes the assertion below prove
        // the wiring actually works end to end, rather than merely that the
        // script's source text mentions the skill's path somewhere.
        execFileSync(process.execPath, [distPmScript], { cwd: REPO_ROOT, stdio: 'pipe' });

        const distSkillMd = path.join(REPO_ROOT, 'dist', 'skills', 'sprint-doctor', 'SKILL.md');
        assert.ok(fs.existsSync(distSkillMd), `dist-pm.mjs did not produce ${distSkillMd}`);

        const source = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
        const shipped = fs.readFileSync(distSkillMd, 'utf-8');
        assert.equal(shipped, source, 'dist/skills/sprint-doctor/SKILL.md is not byte-identical to the vendored source');
    });
});

describe('sprint-doctor skill: the generated SEA asset list includes it', () => {
    test('scripts/gen-sea-config.mjs, executed for real, lists every real skill file in both the manifest and the asset map', () => {
        const genSeaScript = path.join(REPO_ROOT, 'scripts', 'gen-sea-config.mjs');
        assert.ok(fs.existsSync(genSeaScript), `${genSeaScript} does not exist`);

        execFileSync(process.execPath, [genSeaScript], { cwd: REPO_ROOT, stdio: 'pipe' });

        const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'dist', 'sea-manifest.json'), 'utf-8'));
        const seaConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'dist', 'sea-config.json'), 'utf-8'));

        // The expected file set is read FRESH from the real skill directory
        // here, never hand-copied -- so a file added to (or removed from) the
        // skill and a stale manifest are both caught, not just a missing
        // SKILL.md specifically.
        const realFiles = listFilesRecursive(SKILL_DIR).sort();
        assert.ok(realFiles.length > 0, `${SKILL_DIR} has no files to ship`);

        assert.ok(manifest.sprintDoctorSkill, 'dist/sea-manifest.json has no "sprintDoctorSkill" section');
        const manifestFiles = Object.keys(manifest.sprintDoctorSkill).sort();
        assert.deepEqual(manifestFiles, realFiles, 'manifest.sprintDoctorSkill file set does not match the real skill directory listing');

        for (const relFile of realFiles) {
            const assetKey = `${SKILL_REL_DIR.replace(/\\/g, '/')}/${relFile}`;
            assert.ok(
                Object.prototype.hasOwnProperty.call(seaConfig.assets, assetKey),
                `dist/sea-config.json assets is missing "${assetKey}"`
            );
            const assetDiskPath = seaConfig.assets[assetKey];
            assert.ok(fs.existsSync(assetDiskPath), `SEA asset "${assetKey}" points at a non-existent path: ${assetDiskPath}`);
            assert.equal(
                fs.readFileSync(assetDiskPath, 'utf-8'),
                fs.readFileSync(path.join(SKILL_DIR, relFile), 'utf-8'),
                `SEA asset "${assetKey}" content does not match the real skill file`
            );
        }
    });
});

describe('sprint-doctor skill: stays target-agnostic', () => {
    test('SKILL.md quotes no target-project-specific strings (same deny-list as the registry genericity test)', () => {
        // Deliberately the same pattern set as test/doctor-registry.test.mjs's
        // "no entry quotes target-project-specific strings" case, applied to
        // the skill's own prose instead of the registry's data entries.
        const bannedPatterns = [/apra-fleet-[a-z0-9]{2,}/i, /\bnpm run build\b/, /\bdist\/index\.js\b/, /localhost:8787/];
        const text = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
        for (const re of bannedPatterns) {
            assert.ok(!re.test(text), `SKILL.md quotes a target-specific string matching ${re}`);
        }
    });

    test('SKILL.md references the registry module but does not inline its symptom/remedy table', () => {
        const text = fs.readFileSync(SKILL_MD_PATH, 'utf-8');

        // It must point at the live module (single source of truth)...
        assert.match(text, /doctor-registry\.mjs/, 'SKILL.md does not reference doctor-registry.mjs as the live registry source');

        // ...but must not paste a copy of the table: at most a small number
        // of the registry's own entry ids may appear (an illustrative
        // example verdict is fine; reproducing most/all of them is the
        // inlined-copy this skill explicitly promises never to do).
        assert.ok(REGISTRY_ENTRIES.length > 0, 'doctor-registry.mjs exports no entries to check against');
        const idsFound = REGISTRY_ENTRIES.filter((entry) => text.includes(entry.id));
        assert.ok(
            idsFound.length < REGISTRY_ENTRIES.length / 2,
            `SKILL.md quotes ${idsFound.length}/${REGISTRY_ENTRIES.length} registry entry ids `
            + `(${idsFound.map((e) => e.id).join(', ')}) -- looks like an inlined copy of the registry table`
        );
    });
});
