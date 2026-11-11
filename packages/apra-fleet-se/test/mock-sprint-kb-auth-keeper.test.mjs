import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { KB_AUTH_RESUME_NOTE } from '../fleet-sprint/kb-auth-keeper.mjs';

// The KB auth keeper through the REAL runner.js agent() wrapper: with an
// orchestrator KB that takes its token from a secret, a remote doer gets
// provision_kb_auth before its dispatch, and a doer whose toolErrors show a
// rejected KB token is healed (reason rejected) and resumed once in the same
// session. kb-auth-keeper.test.mjs covers the keeper's rules in isolation;
// this guards the lines that wire it into every dispatch.
//
// The keeper reads the orchestrator's KB config from its data dir, so each
// scenario runs with APRA_FLEET_DATA_DIR on a temp dir holding one.

const REMOTE = 'https://kb.example.test';

async function withOrchestratorKb(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keeper-orch-'));
    const before = process.env.APRA_FLEET_DATA_DIR;
    fs.mkdirSync(path.join(dir, 'knowledge'));
    fs.writeFileSync(path.join(dir, 'knowledge', 'config.json'), JSON.stringify({ provider: 'http', url: REMOTE, token_ref: '{{secret.kb-live}}' }));
    process.env.APRA_FLEET_DATA_DIR = dir;
    try {
        return await fn();
    } finally {
        if (before === undefined) delete process.env.APRA_FLEET_DATA_DIR;
        else process.env.APRA_FLEET_DATA_DIR = before;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A callTool factory answering member_detail (a remote member) and provision_kb_auth with `provision`. */
function keeperCallTools(provision) {
    return (executeCommand) => {
        const base = defaultMockCallTool({ executeCommand });
        return async (name, args) => {
            if (name === 'fleet_status') throw new Error('the keeper must not call fleet_status');
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ vcsProvider: 'github', id: '0b9d3a1e-5f2c-4c6e-9a7b-1c2d3e4f5a6b', type: 'remote', os: 'linux', folder: '/srv/mock/widget' }) }] };
            }
            if (name === 'provision_kb_auth') return provision(args);
            return base(name, args);
        };
    };
}

test('mock sprint: a remote doer gets its KB token before dispatch, and a rejected token is healed with one resume', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb auth keeper wiring', () => withOrchestratorKb(async () => {
        const provisions = [];
        const doerCalls = [];
        const callToolFactory = keeperCallTools((args) => {
            provisions.push(args);
            const exp = Date.now() + 3600_000;
            return { content: [{ type: 'text', text: '[OK]' }], structuredContent: { ok: true, expiresAt: new Date(exp).toISOString(), refreshAt: new Date(exp - 360_000).toISOString(), secretKind: 'live' } };
        });
        const doerHandler = async ({ opts, tempDir, runCmd }) => {
            doerCalls.push({ prompt: opts.prompt, resume: opts.resume });
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
            const first = doerCalls.length === 1;
            return {
                content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: first ? ids : [], notes: first ? 'done' : 'redid the KB lookups' }) }],
                ...(first ? { structuredContent: { toolErrors: { available: true, sinceSeconds: 30, total: 1, entries: [{ tool: 'kb_query', code: 'E-KB-HTTP-AUTH', reason: 'rejected', origin: 'session' }] } } } : {}),
            };
        };

        await runDevelopLoopScenario('kbauthkeeper', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the KB auth keeper through a real dispatch' }],
            maxCycles: 1,
            callToolFactory,
            doerHandler,
        });

        assert.ok(provisions.length >= 2, `expected a pre-dispatch push and a heal, got ${JSON.stringify(provisions)}`);
        assert.deepEqual(provisions[0], { member_name: 'local', secret: 'kb-live', remote: REMOTE, keep_member_kb: true });
        const heals = provisions.filter((p) => p.reason === 'rejected');
        assert.equal(heals.length, 1, 'one heal with reason rejected');
        assert.ok(doerCalls.length >= 2, 'the doer was resumed');
        assert.equal(doerCalls[1].prompt.startsWith(KB_AUTH_RESUME_NOTE), true, 'the resume carries the note');
        assert.equal(typeof doerCalls[1].resume, 'string', 'the resume targets the explicit session id');
        assert.equal(doerCalls.filter((c) => c.prompt.startsWith(KB_AUTH_RESUME_NOTE)).length, 1, 'resumed only once');
    }));
});

// The watchdog lease reaches the keeper through runner.js's agent() wrapper:
// with every push failing (no token recorded, so each dispatch start pushes),
// dispatch-role's pre-dispatch hook pushes once and marks the lease; the
// keeper's dispatch() sees the mark and does not push again inside the race.
// Without the lease handed over, every dispatch would push twice.
test('mock sprint: the runner hands dispatch-role\'s watchdog lease to the keeper (one push per dispatch, not two)', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb auth keeper lease', () => withOrchestratorKb(async () => {
        const provisions = [];
        const callToolFactory = keeperCallTools((args) => {
            provisions.push(args);
            return { isError: true, content: [{ type: 'text', text: 'E-PROVISION-AUTH: mint-failed' }], structuredContent: { ok: false, code: 'E-PROVISION-AUTH', reason: 'mint-failed' } };
        });
        const r = await runDevelopLoopScenario('kbauthlease', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: one dispatch per push' }],
            maxCycles: 1,
            callToolFactory,
        });
        assert.ok(r.dispatched.length > 0, 'the sprint dispatched');
        assert.equal(provisions.length, r.dispatched.length, `pushes ${provisions.length} for ${r.dispatched.length} dispatches`);
    }));
});
