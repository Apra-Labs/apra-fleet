import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pins the release-notes freshness requirement added to the harvester
// close-out contract: before prepending a new CHANGELOG entry, the harvester
// must re-read the carried-forward backlog list of every still-unreleased
// entry and correct any listed item that has since been closed (stating the
// closed behaviour rather than deleting the paragraph). Follows the
// read-the-prompt-file-from-disk precedent in
// kb-prompt-contract-wrapper-roles.test.mjs -- this test also reads
// apra-pm/agents/*.md and asserts on its content, not on the engine code
// that dispatches it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARVESTER_MD_PATH = path.join(__dirname, '..', 'apra-pm', 'agents', 'harvester.md');

/** Extracts a numbered "## Step N -- ..." section: heading line through the next "## " heading (or EOF). */
function extractStepSection(content, headingRe) {
    const lines = content.split('\n');
    const startIdx = lines.findIndex((l) => headingRe.test(l));
    if (startIdx === -1) return null;
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) { endIdx = i; break; }
    }
    return { headingLine: lines[startIdx], section: lines.slice(startIdx, endIdx).join('\n') };
}

/**
 * Semantic check for the release-notes freshness instruction: requires the
 * "carried-forward"/"carried forward" concept, the "backlog" concept, the
 * "unreleased" scoping, and an instruction to correct/state items that have
 * since been "closed" -- all within the same step section, but not tied to
 * exact wording, paragraph position, or line numbers, so ordinary prose
 * edits to the step do not break this test.
 */
function hasReleaseNotesFreshnessInstruction(section) {
    if (!section) return false;
    const collapsed = section.replace(/\s+/g, ' ');
    const hasCarriedForward = /carried[- ]forward/i.test(collapsed);
    const hasBacklog = /backlog/i.test(collapsed);
    const hasUnreleased = /unreleased/i.test(collapsed);
    const hasClosedCorrection = /\bclosed\b[\s\S]{0,80}?(behaviou?r|correct)|\bcorrect\b[\s\S]{0,80}?\bclosed\b/i.test(collapsed);
    return hasCarriedForward && hasBacklog && hasUnreleased && hasClosedCorrection;
}

test('harvester close-out contract: Step 4 requires re-checking carried-forward backlog entries for staleness', () => {
    assert.ok(fs.existsSync(HARVESTER_MD_PATH), `harvester prompt file does not exist: ${HARVESTER_MD_PATH}`);
    const content = fs.readFileSync(HARVESTER_MD_PATH, 'utf8');

    const step4 = extractStepSection(content, /^#+.*Step 4.*CHANGELOG/i);
    assert.ok(step4, 'harvester.md has no "Step 4 -- Update README.md and CHANGELOG.md" section to inspect');

    assert.ok(
        hasReleaseNotesFreshnessInstruction(step4.section),
        'harvester.md Step 4 no longer instructs re-reading the carried-forward backlog list of still-unreleased ' +
        'CHANGELOG entries and correcting items closed since they were written. Section content: ' +
        JSON.stringify(step4.section)
    );
});

test('harvester close-out contract: the freshness instruction names no apra-fleet-specific target and no bead id', () => {
    const content = fs.readFileSync(HARVESTER_MD_PATH, 'utf8');
    const step4 = extractStepSection(content, /^#+.*Step 4.*CHANGELOG/i);
    assert.ok(step4, 'harvester.md has no "Step 4 -- Update README.md and CHANGELOG.md" section to inspect');

    assert.ok(
        !/apra-fleet-[a-z0-9]+(\.[0-9]+)*/i.test(step4.section),
        `Step 4 section must not cite a bead id: ${JSON.stringify(step4.section)}`
    );
});

test('hasReleaseNotesFreshnessInstruction: does not flag Step 4 with the freshness clause removed (regression fixture)', () => {
    // Mirrors harvester.md's Step 4 with only the original two bullets --
    // the shape before this instruction was added.
    const section = [
        '## Step 4 -- Update README.md and CHANGELOG.md',
        '',
        '- Update `README.md` to reflect new features, changed behaviour, or removed capabilities',
        '- Prepend a new entry to `CHANGELOG.md` (create it if it does not exist) summarising',
        '  what was implemented, the sprint goal, and any items carried forward',
        '- Your task context includes a `costAnalysis` block. Insert it verbatim into the CHANGELOG',
        '  entry, after the summary paragraph, exactly as provided -- do not reformat or recompute it',
    ].join('\n');

    assert.equal(hasReleaseNotesFreshnessInstruction(section), false);
});

test('hasReleaseNotesFreshnessInstruction: flags a differently-worded but semantically equivalent instruction', () => {
    const section = [
        '## Step 4 -- Update README.md and CHANGELOG.md',
        '',
        '- Update `README.md` to reflect new features, changed behaviour, or removed capabilities',
        '- Before writing a new entry, look back over the backlog items carried forward by any entry',
        '  still marked unreleased, and correct any of them that has since been closed by stating',
        '  what the closed behaviour now is.',
        '- Prepend a new entry to `CHANGELOG.md` (create it if it does not exist)',
    ].join('\n');

    assert.equal(hasReleaseNotesFreshnessInstruction(section), true);
});
