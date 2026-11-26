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

function buildWith(deployMd) {
    const logs = [];
    const calls = [];
    const command = async () => ({ ok: true, output: deployMd });
    const callTool = async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: 'Permissions composed OK' }] };
    };
    const ensure = createDeployPermissionsProvisioner({ callTool, command, log: (l) => logs.push(l) });
    return { ensure, logs, calls };
}

test('a Permissions section with no valid bullet warns (file, section, expected shape) and grants nothing', async () => {
    const { ensure, logs, calls } = buildWith('# Deploy\n\n## Permissions\n\n* Bash(x)\n- Bash(y)\n\n## Steps\n');
    await ensure('dev1');
    assert.equal(calls.length, 0, 'compose_permissions not called');
    const warns = logs.filter((l) => l.includes('WARNING'));
    assert.equal(warns.length, 1, logs.join('\n'));
    assert.ok(warns[0].includes('deploy.md') && warns[0].includes('## Permissions'), warns[0]);
    assert.ok(warns[0].includes('backtick'), warns[0]);
    assert.ok(warns[0].includes('* Bash(x)') && warns[0].includes('- Bash(y)'), warns[0]);
});

test('a mixed Permissions section grants the valid bullet and names the invalid line', async () => {
    const { ensure, logs, calls } = buildWith('# Deploy\n\n## Permissions\n\n- `Bash(ok:*)`\n- Bash(bad)\n\n## Steps\n');
    await ensure('dev1');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.grant, ['Bash(ok:*)']);
    const warn = logs.find((l) => l.includes('WARNING'));
    assert.ok(warn && warn.includes('- Bash(bad)'), logs.join('\n'));
});

test('no Permissions heading stays silent and makes no call', async () => {
    const { ensure, logs, calls } = buildWith('# Deploy\n\n## Steps\n\n- do it\n');
    await ensure('dev1');
    assert.equal(calls.length, 0);
    assert.equal(logs.some((l) => l.includes('WARNING')), false, logs.join('\n'));
});

test('a fully valid Permissions section grants without a warning', async () => {
    const { ensure, logs, calls } = buildWith('# Deploy\n\n## Permissions\n\n- `Bash(npm run build:*)`\n\n## Steps\n');
    await ensure('dev1');
    assert.equal(calls.length, 1);
    assert.equal(logs.some((l) => l.includes('WARNING')), false, logs.join('\n'));
});
