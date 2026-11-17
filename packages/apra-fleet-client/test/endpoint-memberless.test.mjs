import test from 'node:test';
import assert from 'node:assert';
import { createMemberlessMethods } from '../src/endpoint/memberless.mjs';
import { CommandError, WorkflowError } from '../src/errors/workflow-errors.mjs';

// Guard for the two non-executePrompt FleetApi methods: the ones most likely
// to rot into silent lies about a machine that does not exist behind this
// transport. executePrompt's own contract is covered by
// endpoint-shapes.test.mjs / endpoint-core.test.mjs and is not repeated here.

test('executeCommand - always rejects with a typed engine error naming the limitation, never resolves', async () => {
    const { executeCommand } = createMemberlessMethods({});

    await assert.rejects(
        executeCommand({ command: 'echo hi' }),
        (err) => {
            // A typed engine error, not a bare Error -- FleetWorkflow.command()
            // re-throws `instanceof WorkflowError` untouched, so a look-alike
            // class here would surface as a generic FleetTransportError and
            // blame the network for a capability that never existed.
            assert.ok(err instanceof CommandError, `expected CommandError, got ${err.constructor.name}`);
            assert.ok(err instanceof WorkflowError);
            assert.match(err.message, /cannot execute commands/i);
            return true;
        }
    );
});

test('executeCommand - never resolves with a success-shaped payload (e.g. exit_code: 0)', async () => {
    const { executeCommand } = createMemberlessMethods({});

    // Explicit non-resolution check, independent of assert.rejects' own
    // pass/fail: prove there is no code path that resolves with something
    // like {exit_code: 0, stdout: ''} that a workflow could mistake for a
    // command that actually ran on a machine that does not exist. If
    // executeCommand were changed to resolve, `settled` would flip to
    // 'resolved' and the assertion below would fail.
    let settled = 'pending';
    try {
        await executeCommand({ command: 'echo hi' });
        settled = 'resolved';
    } catch {
        settled = 'rejected';
    }

    assert.strictEqual(settled, 'rejected', 'executeCommand must reject, never resolve');
});

test('executeCommand - behaves identically whether member_id/member_name-shaped fields are present or absent (no member either way)', async () => {
    const { executeCommand } = createMemberlessMethods({});

    const withMember = executeCommand({ command: 'ls', member_id: 'm-1', member_name: 'alice' });
    const withoutMember = executeCommand({ command: 'ls' });

    const [errWith, errWithout] = await Promise.all([
        assert.rejects(withMember).then(() => null).catch((e) => e),
        assert.rejects(withoutMember).then(() => null).catch((e) => e)
    ]);
    // Both rejected via assert.rejects (which itself throws if the promise
    // resolves), and neither assert.rejects call itself threw here.
    assert.strictEqual(errWith, null);
    assert.strictEqual(errWithout, null);
});

test('getMemberModelPricing - with config.pricing set, matches the exact shape pricing.mjs\'s consumer reads off get_member_model_pricing', async () => {
    const { getMemberModelPricing } = createMemberlessMethods({
        model: 'gpt-configured',
        pricing: { promptPrice: 5, completionPrice: 15 }
    });

    const res = await getMemberModelPricing();

    // Mirrors FleetWorkflow._getMemberPricing (packages/apra-fleet-workflow/
    // src/workflow/index.mjs): `res.content[0].text` is JSON-parsed, and a
    // payload is priced only when parsed.error is falsy AND parsed.pricing
    // is present.
    assert.strictEqual(typeof res.content[0].text, 'string');
    const parsed = JSON.parse(res.content[0].text);

    assert.strictEqual(parsed.error, undefined, 'a priced response must carry no error key');
    assert.ok(parsed.pricing, 'a priced response must carry a pricing key');

    // _resolveCost reads parsed.pricing[tier].promptPrice / .completionPrice
    // as numbers, for each of the three tier keywords the engine may pass
    // (there is no member here to resolve a tier against, so all three bill
    // at the one configured model's rate -- see memberless.mjs's header).
    for (const tier of ['cheap', 'standard', 'premium']) {
        const entry = parsed.pricing[tier];
        assert.ok(entry, `expected a pricing entry for tier '${tier}'`);
        assert.strictEqual(typeof entry.promptPrice, 'number');
        assert.strictEqual(typeof entry.completionPrice, 'number');
        assert.strictEqual(entry.promptPrice, 5);
        assert.strictEqual(entry.completionPrice, 15);
        assert.strictEqual(entry.model, 'gpt-configured');
    }
});

test('getMemberModelPricing - with no config.pricing, signals unpriced on the engine\'s existing fallback channel (error key, no pricing key)', async () => {
    const { getMemberModelPricing } = createMemberlessMethods({ model: 'gpt-configured' });

    const res = await getMemberModelPricing();
    const parsed = JSON.parse(res.content[0].text);

    // This is the exact condition FleetWorkflow._getMemberPricing checks to
    // degrade to null (use the tier-band/concrete-model calculateCost()
    // fallback in pricing.mjs) rather than silently defaulting a price:
    // `!parsed || parsed.error || !parsed.pricing`.
    assert.ok(parsed.error, 'an unpriced response must carry a truthy error key');
    assert.strictEqual(parsed.pricing, undefined, 'an unpriced response must carry no pricing key');

    // Simulate the engine's own decision inline, so a regression that adds a
    // spurious pricing key alongside error (or drops error) is caught here,
    // not just three services away in FleetWorkflow.
    const enginePricesFor = !parsed || parsed.error || !parsed.pricing ? null : parsed.pricing;
    assert.strictEqual(enginePricesFor, null, 'the engine must fall back to pricing.mjs, never silently default a price for an unconfigured model');
});

test('getMemberModelPricing - behaves identically regardless of member_id/member_name (there is no member either way)', async () => {
    const { getMemberModelPricing } = createMemberlessMethods({
        model: 'gpt-configured',
        pricing: { promptPrice: 5, completionPrice: 15 }
    });

    const noArgs = await getMemberModelPricing();
    const withMemberId = await getMemberModelPricing({ member_id: 'm-1' });
    const withMemberName = await getMemberModelPricing({ member_name: 'alice' });
    const withBoth = await getMemberModelPricing({ member_id: 'm-1', member_name: 'alice' });

    assert.deepStrictEqual(noArgs, withMemberId);
    assert.deepStrictEqual(noArgs, withMemberName);
    assert.deepStrictEqual(noArgs, withBoth);
});
