import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeployPermissionsProvisioner } from '../fleet-sprint/member-provisioning.mjs';

const DEPLOY_MD = '# Deploy\n\n## Permissions\n\n- `Bash(docker compose:*)`\n\n## Steps\n';

function build(composeText) {
    const logs = [];
    const calls = [];
    const command = async () => ({ ok: true, output: DEPLOY_MD });
    const callTool = async (name, args) => {
        if (name === 'compose_permissions') {
            calls.push(args);
            return { content: [{ type: 'text', text: composeText }] };
        }
        throw new Error(`unexpected tool ${name}`);
    };
    const ensure = createDeployPermissionsProvisioner({ callTool, command, log: (l) => logs.push(l) });
    return { ensure, logs, calls };
}

test('a NEVER_AUTO_GRANT refusal is logged as a failure, never ensured, and retried', async () => {
    const refusal = '\u274c Cannot auto-grant dangerous permissions: Bash(docker compose:*). Escalate to user.';
    const { ensure, logs, calls } = build(refusal);
    await ensure('dev1');
    await ensure('dev1');
    assert.equal(logs.some((l) => l.includes('ensured')), false, logs.join('\n'));
    assert.ok(logs.some((l) => l.includes('Cannot auto-grant dangerous permissions')), logs.join('\n'));
    assert.equal(calls.length, 2, 'compose_permissions invoked on both calls (not cached)');
});

test('a success result logs its text (no [object Object]) and is cached', async () => {
    const { ensure, logs, calls } = build('Permissions composed OK for dev1');
    await ensure('dev1');
    await ensure('dev1');
    const line = logs.find((l) => l.includes('ensured'));
    assert.ok(line, logs.join('\n'));
    assert.ok(line.includes('Permissions composed OK for dev1'), line);
    assert.ok(!line.includes('[object Object]'), line);
    assert.equal(calls.length, 1, 'second call served from cache');
});

test('a process-killing deploy.md grant is never requested; it is logged as refused and the other grants still land', async () => {
    const deployMd = '# Deploy\n\n## Permissions\n\n- `Bash(docker compose:*)`\n- `Bash(taskkill:*)`\n- `Bash(pkill -f app)`\n- `Bash(node scripts/kill-port.mjs:*)`\n\n## Steps\n';
    const logs = [];
    const calls = [];
    const command = async () => ({ ok: true, output: deployMd });
    const callTool = async (name, args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: 'Permissions composed OK' }] };
    };
    const ensure = createDeployPermissionsProvisioner({ callTool, command, log: (l) => logs.push(l) });
    await ensure('dev1');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].grant, ['Bash(docker compose:*)', 'Bash(node scripts/kill-port.mjs:*)']);
    const refused = logs.find((l) => l.includes('REFUSED (process_kill_refused)'));
    assert.ok(refused, logs.join('\n'));
    assert.ok(refused.includes('Bash(taskkill:*)') && refused.includes('Bash(pkill -f app)'), refused);
    assert.ok(logs.some((l) => l.includes('ensured')), logs.join('\n'));
});
