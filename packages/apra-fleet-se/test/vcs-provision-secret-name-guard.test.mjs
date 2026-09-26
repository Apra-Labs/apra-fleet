import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// MECHANICAL GUARD for the operator-chosen Azure DevOps PAT secret name.
//
// This class of bug has now shipped twice: a provisioning call site that does
// not forward `azdevopsPatSecretName` silently mints the PROVIDER DEFAULT
// secret ('azdevops_pat'). On an operator machine where that name already
// belongs to an unrelated project the damage is double -- the operation fails
// with HTTP 401 AND the wrong credential is written over the member's working
// git credential on disk, so even a plain git fetch breaks until someone
// re-provisions by hand.
//
// The behavioural tests (vcs-auth-pr-secret-name.test.mjs,
// mock-sprint-azure-devops-vcs-publish.test.mjs, vcs-auth-self-heal.test.mjs)
// prove each KNOWN path forwards it. What they cannot prove is that a NEW
// call site added later does too -- there is no runtime seam that observes
// "every call site". So this guard is deliberately source-text based: it
// enumerates the call sites and fails when one of them omits the parameter.
// A source-text assertion is the right shape here precisely because the
// invariant is about the set of call sites, not about any one behaviour.
//
// It is narrow on purpose: it only looks for the argument NAME inside the
// call's own argument object. It cannot be satisfied by passing undefined
// from a scope that has no value -- that is what code review is for -- but it
// does catch the omission that shipped, which is the failure mode that has
// actually occurred.

const HERE = dirname(fileURLToPath(import.meta.url));
const SPRINT_DIR = join(HERE, '..', 'fleet-sprint');

function sourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

// Find each `<fn>({ ... })` call and return its argument text, skipping the
// function's own declaration and any occurrence inside a // comment line.
function callArgumentTexts(source, fnName) {
    const texts = [];
    const re = new RegExp(`(?<!function\\s)\\b${fnName}\\s*\\(\\s*\\{`, 'g');
    let m;
    while ((m = re.exec(source)) !== null) {
        const lineStart = source.lastIndexOf('\n', m.index) + 1;
        const linePrefix = source.slice(lineStart, m.index);
        if (linePrefix.includes('//') || linePrefix.includes('*')) continue;
        let depth = 0;
        let i = source.indexOf('{', m.index);
        const start = i;
        for (; i < source.length; i += 1) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        texts.push(source.slice(start, i + 1));
    }
    return texts;
}

describe('every VCS provisioning call site forwards azdevopsPatSecretName', () => {
    for (const fnName of ['provisionVcsAuthForMember', 'provisionPrCapableAuthForMember', 'raiseVcsPrForMember']) {
        test(`${fnName}: no call site omits azdevopsPatSecretName`, () => {
            const offenders = [];
            let callSites = 0;
            for (const file of sourceFiles(SPRINT_DIR)) {
                const source = readFileSync(file, 'utf8');
                if (!source.includes(fnName)) continue;
                for (const args of callArgumentTexts(source, fnName)) {
                    callSites += 1;
                    if (!/\bazdevopsPatSecretName\b/.test(args)) {
                        offenders.push(`${file}: ${args.replace(/\s+/g, ' ').slice(0, 120)}`);
                    }
                }
            }
            assert.ok(callSites > 0, `sanity: no ${fnName} call sites were found -- the scanner is broken, not the code`);
            assert.deepEqual(
                offenders,
                [],
                `these ${fnName} call sites do not forward azdevopsPatSecretName; without it they provision the provider DEFAULT secret, which 401s AND overwrites the member's working git credential:\n${offenders.join('\n')}`,
            );
        });
    }
});
