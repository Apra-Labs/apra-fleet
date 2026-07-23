import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- harvester prompt Step 1: write analysis artifact first ------------------

test('harvester prompt instructs writing analysisText to .analysis.md as Step 1', () => {
  const harvestLabel = src.indexOf("label: harvestLabel");
  assert.ok(harvestLabel >= 0, 'harvester dispatch with label: harvestLabel must exist');

  // Look backward for the prompt text (up to 2000 chars before the label).
  const region = src.slice(Math.max(0, harvestLabel - 2000), harvestLabel);

  assert.match(region, /FIRST action.*Step 1|Step 1.*FIRST action/s,
    'harvester prompt must identify Step 1 as the FIRST action');
  assert.match(region, /\.analysis\.md|analysisArtifactFile/,
    'harvester prompt Step 1 must reference the .analysis.md artifact file');
});

test('harvester prompt Step 1 says to write analysis artifact before anything else', () => {
  const harvestLabel = src.indexOf("label: harvestLabel");
  const region = src.slice(Math.max(0, harvestLabel - 2000), harvestLabel);

  // The instruction must say to write and commit the artifact before doing other things.
  assert.match(region, /before doing anything else|commit it before/i,
    'harvester prompt must instruct writing the artifact before any other action');
});

// ---- no separate sprint-analysis-write dispatch -----------------------------

test('no sprint-analysis-write dispatch exists in source', () => {
  // The old two-step approach used a separate dispatch labeled "sprint-analysis-write".
  // After auh.2, the harvester writes the artifact itself as Step 1.
  assert.doesNotMatch(src, /sprint-analysis-write/,
    'sprint-analysis-write dispatch must not exist (absorbed into harvester Step 1)');
});

// ---- JS fallback: write .analysis.md when harvester returns null/non-OK -----

test('JS fallback exists when harvestResult is null or not OK', () => {
  // The fallback triggers when harvestResult.status !== 'OK'.
  assert.match(src, /harvestResult.*status.*OK|status.*!==.*OK/s,
    'source must check harvestResult.status for OK');
  assert.match(src, /harvest.*fallback|harvest-analysis-fallback/i,
    'source must have a harvest fallback path');
});

test('JS fallback writes .analysis.md via dispatchShell', () => {
  const fallbackIdx = src.indexOf('harvest-analysis-fallback');
  assert.ok(fallbackIdx >= 0, '"harvest-analysis-fallback" label must exist in source');

  // Look backward for the dispatchShell call containing the fallback.
  const region = src.slice(Math.max(0, fallbackIdx - 1500), fallbackIdx);
  assert.match(region, /dispatchShell\s*\(/, 'JS fallback must use dispatchShell');
  assert.match(region, /\.analysis\.md|analysisArtifactFile/,
    'JS fallback must write the .analysis.md artifact');
});

test('JS fallback writes summaryText from sprintSummary (not a bare analysisText)', () => {
  const fallbackIdx = src.indexOf('harvest-analysis-fallback');
  const region = src.slice(Math.max(0, fallbackIdx - 1500), fallbackIdx);

  // The fallback must use sprintSummary.summaryText (not raw analysisText).
  assert.match(region, /sprintSummary\.summaryText/,
    'JS fallback must write sprintSummary.summaryText to the artifact file');
});

test('JS fallback commits the analysis artifact', () => {
  const fallbackIdx = src.indexOf('harvest-analysis-fallback');
  const region = src.slice(Math.max(0, fallbackIdx - 1500), fallbackIdx);

  assert.match(region, /git.*commit/,
    'JS fallback must commit the analysis artifact');
  assert.match(region, /sprint-analysis fallback/,
    'JS fallback commit message must include "sprint-analysis fallback"');
});

test('JS fallback returns early with harvest:"failed" after writing artifact', () => {
  const fallbackIdx = src.indexOf('harvest-analysis-fallback');
  // Look forward for the early return.
  const region = src.slice(fallbackIdx, fallbackIdx + 400);

  assert.match(region, /harvest.*failed|return.*harvest/s,
    'JS fallback must return with harvest: "failed" to signal the orchestrator');
});

// ---- harvester dispatch passes analysisText for Step 1 ----------------------

test('harvester prompt passes summaryText for the artifact write', () => {
  const harvestLabel = src.indexOf("label: harvestLabel");
  const region = src.slice(Math.max(0, harvestLabel - 2000), harvestLabel);

  // The summaryText must be embedded directly in the prompt for Step 1.
  assert.match(region, /sprintSummary\.summaryText|summaryText/,
    'harvester prompt must embed sprintSummary.summaryText for the Step 1 artifact write');
});
