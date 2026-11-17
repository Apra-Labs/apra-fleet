// vcs-stderr-corpus.mjs -- loader for the recorded real-git/real-dolt stderr
// corpus (apra-fleet-j918.6.2).
//
// The corpus itself (../fixtures/vcs-stderr/vcs-stderr-corpus.json) is
// RECORDED by ../fixtures/vcs-stderr/record-vcs-stderr.mjs against real git
// and real `bd dolt`; see that directory's README.md for why, and for the
// re-record procedure. This module only reads it -- no test shells out, so
// the suite stays hermetic and offline.
//
// ASCII only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(__dirname, '..', 'fixtures', 'vcs-stderr', 'vcs-stderr-corpus.json');

let cached = null;

/** The whole corpus: { recordedAt, recordedOn, tools, samples[] }. */
export function loadVcsStderrCorpus() {
    if (!cached) cached = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
    return cached;
}

/** Every recorded sample for one tool ('git' | 'dolt'). */
export function stderrSamples(tool) {
    return loadVcsStderrCorpus().samples.filter((s) => s.tool === tool);
}

/** The one sample recorded under `id`. Throws (rather than returning
 *  undefined and degrading an assertion into a vacuous pass) when the id is
 *  absent -- e.g. after a re-record that dropped a sample the recorder could
 *  not provoke. */
export function stderrSample(id) {
    const hit = loadVcsStderrCorpus().samples.find((s) => s.id === id);
    if (!hit) {
        throw new Error(
            `vcs-stderr-corpus: no sample recorded under id "${id}". `
            + 'Re-record with test/fixtures/vcs-stderr/record-vcs-stderr.mjs (the auth samples need '
            + 'network and no ambient git credential helper), or update the id.',
        );
    }
    return hit;
}

/** The verbatim recorded output for `id` -- the value to feed a classifier. */
export function stderrText(id) {
    return stderrSample(id).stderr;
}

/** Distinct expected kinds present for a tool, for bucket-completeness tests. */
export function recordedKinds(tool) {
    return [...new Set(stderrSamples(tool).map((s) => s.expect))].sort();
}

/** A short, greppable provenance line for assertion messages, so a failure
 *  names the command and tool version that produced the text rather than just
 *  dumping the text. */
export function provenance(sample) {
    const version = sample.bdVersion ? `${sample.toolVersion} via ${sample.bdVersion}` : sample.toolVersion;
    return `${sample.id} [recorded from: ${sample.command} | ${version}]`;
}

export { CORPUS_PATH };
