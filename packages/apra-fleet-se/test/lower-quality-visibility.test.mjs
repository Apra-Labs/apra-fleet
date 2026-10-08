import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerQuality, logLowerQualityWarn } from '../fleet-sprint/lower-quality.mjs';
import { renderKbCodeIntelHtml, kbCodeIntelExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { createMemberInitProbe, MEMBER_INIT_STATE_NAMESPACE } from '../fleet-sprint/member-init-probe.mjs';

// b4g.65: lower quality of service is visible (banner, tab, summary/init WARN, PR body).

const BANNER = 'KB/code unavailable on 1 of 3 members -- lower quality, expect higher token spend';
const rec = (member, verified, reason = null, fix = null) => ({ member, verified, reason, fix });
const oneOfThree = [rec('a', true), rec('b', false, 'mcp-entry-missing', 'Re-run compose_permissions'), rec('c', true)];
const allVerified = [rec('a', true), rec('b', true), rec('c', true)];

test('banner: one of three members unverified reads "on 1 of 3 members"; none when all verified', () => {
    assert.equal(lowerQuality(oneOfThree).banner, BANNER);
    assert.equal(lowerQuality(allVerified).banner, null);
    assert.equal(lowerQuality([]).banner, null);
});

test('tab: reason and fix for the unverified member only, escaped; nothing when all verified', () => {
    const html = renderKbCodeIntelHtml(null, { members: oneOfThree, banner: BANNER });
    assert.ok(html.includes(BANNER));
    assert.match(html, /data-kb-lower-quality-member="b"/);
    assert.ok(html.includes('mcp-entry-missing') && html.includes('Re-run compose_permissions'));
    assert.doesNotMatch(html, /data-kb-lower-quality-member="a"|data-kb-lower-quality-member="c"/);

    const evil = renderKbCodeIntelHtml(null, { members: [rec('<b>x</b>', false, '<script>alert(1)</script>', '"><img src=x>')], banner: '<i>b</i>' });
    assert.ok(!evil.includes('<script>') && !evil.includes('<img') && !evil.includes('<i>b'));
    assert.ok(evil.includes('&lt;script&gt;'));

    const clean = renderKbCodeIntelHtml(null, { members: allVerified, banner: null });
    assert.doesNotMatch(clean, /data-kb-lower-quality/);
});

test('the tab subscribes to the memberInit state namespace', () => {
    assert.ok(kbCodeIntelExtension.js.includes(JSON.stringify(MEMBER_INIT_STATE_NAMESPACE)));
});

test('PR body: exactly one lower-quality line when a member is unverified, none otherwise', () => {
    const withLine = buildSprintPrBody({ verdict: 'PASS', branch: 'b', details: [lowerQuality(oneOfThree).banner], notes: 'ok' });
    assert.equal(withLine.split('\n').filter((l) => l.includes('lower quality')).length, 1);
    const without = buildSprintPrBody({ verdict: 'PASS', branch: 'b', details: [lowerQuality(allVerified).banner], notes: 'ok' });
    assert.ok(!without.includes('lower quality'));
});

test('publish phase passes the banner into the PR body as one detail line', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../fleet-sprint/phases/publish-pr.mjs', import.meta.url), 'utf8');
    assert.match(src, /lowerQualityBanner \|\| null/);
    assert.equal(typeof runPublishPrPhase, 'function');
});

test('init: a real probe of one unverified member yields the init banner source', async () => {
    const callTool = async (tool, args) => {
        const body = { id: `u-${args.member_name}`, type: 'local', llmProvider: args.member_name === 'b' ? 'opencode' : 'claude', folder: '/w' };
        if (args.refresh) body.fleetMcp = { state: 'available', checkedAt: 'x' };
        return { content: [{ text: JSON.stringify(body) }] };
    };
    const memberCall = async (_m, tool) => ({ content: [{ text: JSON.stringify(tool === 'kb_stats' ? { totals: { by_confidence: { CONFIRMED: 1 } } } : { outcome: 'unavailable' }) }] });
    const listTools = async () => ({ tools: [{ name: 'kb_query' }, { name: 'code_query' }] });
    const logs = [];
    const probe = createMemberInitProbe({ members: ['a', 'b', 'c'], callTool, memberCall, listTools, resolveTarget: async () => ({ os: 'linux', shell: 'bash' }), log: (l) => logs.push(l) });
    const records = await probe.probeAll();
    assert.equal(lowerQuality(records).banner, BANNER);
});

test('WARN lines: init and sprint-summary lines for an unverified member; none when all verified', () => {
    const logs = [];
    logLowerQualityWarn((l) => logs.push(l), '[member-init]', oneOfThree, 'init');
    logLowerQualityWarn((l) => logs.push(l), '[member-init]', oneOfThree, 'summary');
    assert.deepEqual(logs, [`[member-init] WARN ${BANNER}`, `[member-init] WARN sprint summary: ${BANNER}`]);
    const none = [];
    logLowerQualityWarn((l) => none.push(l), '[member-init]', allVerified, 'init');
    logLowerQualityWarn((l) => none.push(l), '[member-init]', allVerified, 'summary');
    assert.deepEqual(none, []);
});

test('runner wires both WARN calls and the published banner', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../fleet-sprint/runner.js', import.meta.url), 'utf8');
    assert.match(src, /logLowerQualityWarn\(log, MEMBER_INIT_LOG_PREFIX, sprintState\.memberInit, 'init'\)/);
    assert.match(src, /logLowerQualityWarn\(log, MEMBER_INIT_LOG_PREFIX, sprintState\.memberInit, 'summary'\)/);
    assert.match(src, /banner: lowerQuality\(sprintState\.memberInit\)\.banner/);
});
