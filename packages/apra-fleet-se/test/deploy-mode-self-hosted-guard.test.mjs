import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    resolveDeployMode,
    SelfHostedProductionDeployRefusedError,
} from '../fleet-sprint/phases/deploy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEPLOY_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/deploy.mjs');
const DEPLOY_PHASE_SOURCE = fs.readFileSync(DEPLOY_PHASE_PATH, 'utf8');

// my-beads-db-0cd.22: regression guard for the deploy-routing enforcement of
// my-beads-db-0cd.17. The routing used to be advisory prose in the deployer
// prompt ("use a sandbox mode if the runbook has one"), which the deployer
// agent ignored: on a SELF-HOSTED target it took the production path, which
// replaces the very instance running the sprint, and every deploy stalled.
// The fix made the routing machine-enforced in resolveDeployMode(). These
// tests assert the RESOLVED MODE and the THROWN ERROR -- the observable
// outputs -- not that any helper was called, and they spawn no process and
// run no deploy: resolveDeployMode() is pure and side-effect-free.
//
// The mode labels below are deliberately made-up, target-neutral strings.
// The engine is generic: it must carry no literal for any particular
// target's isolated deploy mode, so a test that pinned this repo's own
// deploy.md heading would be asserting the opposite of the invariant.
const ISOLATED_MODE_LABEL = 'Isolated Test Deploy';

describe('resolveDeployMode -- a non-self-hosted target is not over-blocked', () => {
    test('no deploy target at all resolves to the runbook as written', () => {
        assert.deepStrictEqual(resolveDeployMode(), {
            mode: 'runbook-as-written',
            isolatedDeployMode: null,
        });
    });

    test('an empty target descriptor resolves to the runbook as written', () => {
        assert.deepStrictEqual(resolveDeployMode({}), {
            mode: 'runbook-as-written',
            isolatedDeployMode: null,
        });
    });

    test('an explicitly remote target keeps the production path reachable', () => {
        assert.deepStrictEqual(resolveDeployMode({ selfHosted: false }), {
            mode: 'runbook-as-written',
            isolatedDeployMode: null,
        });
    });

    test('a remote target is not blocked even when it also declares an isolated mode', () => {
        assert.deepStrictEqual(
            resolveDeployMode({ selfHosted: false, isolatedDeployMode: ISOLATED_MODE_LABEL }),
            { mode: 'runbook-as-written', isolatedDeployMode: null },
        );
    });

    test('only the boolean true opts in -- a truthy non-boolean does not self-host by accident', () => {
        assert.deepStrictEqual(resolveDeployMode({ selfHosted: 'yes' }), {
            mode: 'runbook-as-written',
            isolatedDeployMode: null,
        });
    });
});

describe('resolveDeployMode -- a self-hosted target is pinned to its isolated mode', () => {
    test('resolves to the isolated mode, never the production path', () => {
        const resolved = resolveDeployMode({
            selfHosted: true,
            isolatedDeployMode: ISOLATED_MODE_LABEL,
        });
        assert.strictEqual(resolved.mode, 'isolated');
        assert.strictEqual(resolved.isolatedDeployMode, ISOLATED_MODE_LABEL);
        assert.notStrictEqual(resolved.mode, 'runbook-as-written');
    });

    test('the target-authored label is threaded through verbatim, whatever it says', () => {
        const otherLabel = 'Ephemeral Container Deploy (testing only)';
        assert.deepStrictEqual(
            resolveDeployMode({ selfHosted: true, isolatedDeployMode: otherLabel }),
            { mode: 'isolated', isolatedDeployMode: otherLabel },
        );
    });

    test('surrounding whitespace on the label is trimmed', () => {
        assert.deepStrictEqual(
            resolveDeployMode({ selfHosted: true, isolatedDeployMode: `  ${ISOLATED_MODE_LABEL}\n` }),
            { mode: 'isolated', isolatedDeployMode: ISOLATED_MODE_LABEL },
        );
    });

    test('does not mutate the caller\'s target descriptor', () => {
        const target = { selfHosted: true, isolatedDeployMode: `  ${ISOLATED_MODE_LABEL}  ` };
        resolveDeployMode(target);
        assert.deepStrictEqual(target, {
            selfHosted: true,
            isolatedDeployMode: `  ${ISOLATED_MODE_LABEL}  `,
        });
    });
});

describe('resolveDeployMode -- a self-hosted target with no isolated mode is refused', () => {
    /** Runs resolveDeployMode and returns the error it threw, failing if it did not throw. */
    function captureRefusal(target) {
        try {
            const resolved = resolveDeployMode(target);
            assert.fail(
                'expected a refusal for a self-hosted target with no isolated deploy mode, '
                + `but it resolved to ${JSON.stringify(resolved)}`,
            );
        } catch (err) {
            if (err instanceof assert.AssertionError) throw err;
            return err;
        }
    }

    test('throws the named refusal error rather than falling back to the production path', () => {
        const err = captureRefusal({ selfHosted: true });
        assert.ok(
            err instanceof SelfHostedProductionDeployRefusedError,
            `expected SelfHostedProductionDeployRefusedError, got ${err && err.constructor && err.constructor.name}`,
        );
        assert.strictEqual(err.name, 'SelfHostedProductionDeployRefusedError');
    });

    test('the message names the offending config and the two ways to fix it', () => {
        const err = captureRefusal({ selfHosted: true });
        assert.match(err.message, /deploy_target\.self_hosted/);
        assert.match(err.message, /deploy_target\.isolated_deploy_mode is unset/);
        assert.match(err.message, /Refusing to dispatch the deploy/);
    });

    test('a blank or whitespace-only isolated mode is not a valid isolated mode', () => {
        for (const blank of ['', '   ', '\n\t']) {
            const err = captureRefusal({ selfHosted: true, isolatedDeployMode: blank });
            assert.strictEqual(
                err.name,
                'SelfHostedProductionDeployRefusedError',
                `expected a refusal for isolatedDeployMode ${JSON.stringify(blank)}`,
            );
        }
    });

    test('a non-string isolated mode is not a valid isolated mode', () => {
        for (const bad of [true, 42, {}, ['a']]) {
            const err = captureRefusal({ selfHosted: true, isolatedDeployMode: bad });
            assert.strictEqual(
                err.name,
                'SelfHostedProductionDeployRefusedError',
                `expected a refusal for isolatedDeployMode ${JSON.stringify(bad)}`,
            );
        }
    });
});

// Dead-code prevention, not a "was the helper called" assertion. The mode
// assertions above all exercise resolveDeployMode() directly, so they would
// stay green even if runDeployPhase stopped consulting it -- at which point
// the guard is unwired and the self-hosted target reaches the production path
// again, which is the exact regression this bead exists to prevent. Same
// call-site-wiring scan convention as test/rejected-newtask-resurface.test.mjs.
describe('runDeployPhase wiring -- the guard runs before anything is dispatched', () => {
    test('phases/deploy.mjs calls resolveDeployMode before its dispatchRole call site', () => {
        const guardAt = DEPLOY_PHASE_SOURCE.indexOf('resolveDeployMode(deployTarget)');
        const dispatchAt = DEPLOY_PHASE_SOURCE.indexOf('dispatchRole(dispatchCtx');
        assert.notStrictEqual(guardAt, -1, 'runDeployPhase no longer calls resolveDeployMode(deployTarget) -- the guard is unwired');
        assert.notStrictEqual(dispatchAt, -1, 'the deployer dispatchRole call site moved; re-anchor this scan');
        assert.ok(
            guardAt < dispatchAt,
            'the deploy-mode guard must resolve BEFORE the deployer is dispatched, so a refused self-hosted deploy spends no agent turn',
        );
    });

    test('the self-hosted prompt branch forbids the production path and names the configured mode', () => {
        assert.match(
            DEPLOY_PHASE_SOURCE,
            /deployMode\.isolatedDeployMode/,
            'the self-hosted prompt line must interpolate the target-authored mode label, never a hardcoded section name',
        );
        assert.match(DEPLOY_PHASE_SOURCE, /is FORBIDDEN here/);
        assert.match(DEPLOY_PHASE_SOURCE, /do NOT fall back to the production path/);
    });
});
