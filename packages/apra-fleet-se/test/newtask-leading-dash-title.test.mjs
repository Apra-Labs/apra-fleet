import { test, describe } from 'node:test';
import assert from 'node:assert';
import { validateNewTask, createChildBeadWithAllocatedId } from '../fleet-sprint/runner.js';

// Reviewer-authored newTask titles are the first positional argument of
// `bd create`; a leading '-' would be parsed as a flag. validateNewTask strips
// leading dashes and keeps the original title in the description.

const NOOP_ALLOCATOR = {
    async allocate() { return { childId: null, token: null }; },
    async confirm() { return true; },
    async release() { return true; },
};

// Captures every dispatched command; stages bodies in memory keyed by a fake path.
function makeCapturingCommand() {
    const calls = [];
    const bodies = new Map();
    const command = async (cmd) => {
        calls.push(cmd);
        const m = cmd.match(/^node -e "[\s\S]*" "([A-Za-z0-9+/=]*)"\s*$/);
        if (m) {
            const p = `/tmp/fake-body-${bodies.size}.txt`;
            bodies.set(p, Buffer.from(m[1], 'base64').toString('utf-8'));
            return p;
        }
        return '';
    };
    return { command, calls, bodies };
}

async function fileTask(raw) {
    // dedupCheck: v0.5 requires backlog-search evidence on every newTask (#660).
    const validation = validateNewTask({
        title: raw, description: 'Do the thing.', priority: 'P2',
        dedupCheck: { query: 'leading dash title', candidateIds: [], verdict: 'no-overlap' },
    });
    if (!validation.ok) return { validation };
    const cap = makeCapturingCommand();
    await createChildBeadWithAllocatedId({
        command: cap.command, allocator: NOOP_ALLOCATOR, member: 'local',
        title: validation.title, description: validation.description,
        priority: validation.priority, parentId: 'parent-1',
    });
    const createCmd = cap.calls.find((c) => c.startsWith('bd create '));
    const bodyPath = createCmd.match(/--body-file "([^"]*)"/)[1];
    return { validation, createCmd, body: cap.bodies.get(bodyPath) };
}

describe('newTask titles with a leading dash', () => {
    for (const raw of ['--help', '-p 0', '--force', '- leading space']) {
        test(`${JSON.stringify(raw)} never reaches bd create as a flag; original kept in description`, async () => {
            const { validation, createCmd, body } = await fileTask(raw);
            assert.strictEqual(validation.ok, true);
            const titleToken = createCmd.match(/^bd create "([^"]*)"/)[1];
            assert.ok(!titleToken.startsWith('-'), `title token must not start with '-': ${createCmd}`);
            assert.ok(titleToken.length > 0);
            assert.ok(body.includes(JSON.stringify(raw)), `original title missing from body: ${body}`);
            assert.ok(body.includes('Do the thing.'));
        });
    }

    test('a title of only dashes is rejected (falls to the parent-notes fallback)', () => {
        for (const raw of ['---', '-', '- - -']) {
            const r = validateNewTask({ title: raw, description: 'x', priority: 'P2', dedupCheck: { query: 'dash title', candidateIds: [], verdict: 'no-overlap' } });
            assert.strictEqual(r.ok, false, `expected ${JSON.stringify(raw)} to be rejected`);
            assert.match(r.reason, /title/);
        }
    });

    test('a normal title yields the byte-identical bd create command and untouched description', async () => {
        const { validation, createCmd, body } = await fileTask('Fix 401 handling in client.js');
        assert.strictEqual(validation.title, 'Fix 401 handling in client.js');
        assert.strictEqual(body, 'Do the thing.');
        assert.match(createCmd, /^bd create "Fix 401 handling in client\.js" --body-file "[^"]*" -p "P2" --parent parent-1 --silent$/);
    });

    test('a dash inside a title is untouched', () => {
        const r = validateNewTask({ title: 'Fix a-b handling - now', description: 'x', priority: 'P2', dedupCheck: { query: 'dash title', candidateIds: [], verdict: 'no-overlap' } });
        assert.strictEqual(r.title, 'Fix a-b handling - now');
        assert.strictEqual(r.description, 'x');
    });
});
