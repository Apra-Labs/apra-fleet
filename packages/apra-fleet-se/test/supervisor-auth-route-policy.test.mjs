// Every route the supervisor registers must appear in the route policy table
// (src/supervisor/auth.mjs ROUTE_POLICY), and every policy entry must name a
// route that exists. The route list is derived from the code itself: every
// `route('<METHOD>', '<path>', ...)` / `supervisor.route(...)` call in
// src/supervisor/*.mjs and bin/*.mjs. A new route registered without a policy
// entry fails here (asserted callers would otherwise be denied by default,
// which is safe but almost certainly not what the author meant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE_POLICY, policyFor, POLICY_LOCAL_ONLY, POLICY_AUTHENTICATED, ROLES } from '../src/supervisor/auth.mjs';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_CALL = /(?:^|[^\w$])(?:supervisor\.)?route\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/gm;

function registeredRoutes() {
    const files = [
        ...fs.readdirSync(path.join(pkgRoot, 'src', 'supervisor')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(pkgRoot, 'src', 'supervisor', f)),
        ...fs.readdirSync(path.join(pkgRoot, 'bin')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(pkgRoot, 'bin', f)),
    ];
    const out = new Map();
    for (const file of files) {
        // Drop line comments so commented-out examples are not counted.
        const src = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
        for (const m of src.matchAll(ROUTE_CALL)) {
            out.set(`${m[1]} ${m[2]}`, path.relative(pkgRoot, file));
        }
    }
    return out;
}

test('the route scan finds the supervisor\'s routes (guards against a vacuous pass)', () => {
    const routes = registeredRoutes();
    for (const known of ['GET /', 'GET /api/health', 'POST /api/shutdown', 'GET /api/whoami', 'POST /api/sprints', 'GET /sprints/:id/live', 'POST /api/reservations/:sprintId/force-release', 'POST /api/child-id-allocator/confirm']) {
        assert.ok(routes.has(known), `scan missed ${known}`);
    }
    assert.ok(routes.size >= 35, `only ${routes.size} routes found`);
});

test('every registered route has exactly one policy entry', () => {
    const policyKeys = ROUTE_POLICY.map((p) => `${p.method} ${p.path}`);
    assert.equal(new Set(policyKeys).size, policyKeys.length, 'duplicate policy entries');
    const missing = [...registeredRoutes()].filter(([key]) => !policyKeys.includes(key)).map(([key, file]) => `${key} (${file})`);
    assert.deepEqual(missing, [], `routes registered but missing from ROUTE_POLICY in src/supervisor/auth.mjs:\n${missing.join('\n')}`);
});

test('every policy entry names a registered route (no stale entries)', () => {
    const routes = registeredRoutes();
    const stale = ROUTE_POLICY.filter((p) => !routes.has(`${p.method} ${p.path}`)).map((p) => `${p.method} ${p.path}`);
    assert.deepEqual(stale, []);
});

test('every policy level is a role, authenticated, or local-only; callbacks are local-only', () => {
    for (const p of ROUTE_POLICY) {
        assert.ok([...ROLES, POLICY_AUTHENTICATED, POLICY_LOCAL_ONLY].includes(p.min), `${p.method} ${p.path}: ${p.min}`);
        if (p.path.startsWith('/api/dolt-push-mutex') || p.path.startsWith('/api/child-id-allocator')) assert.equal(p.min, POLICY_LOCAL_ONLY, p.path);
    }
});

test('policyFor resolves a concrete path for every registered route to its own entry', () => {
    for (const key of registeredRoutes().keys()) {
        const [method, pattern] = key.split(' ');
        const concrete = pattern.split('/').map((s) => (s.startsWith(':') ? 'x-1' : s)).join('/');
        const hit = policyFor(method, concrete);
        assert.ok(hit, `no policy for ${method} ${concrete}`);
        assert.equal(hit.path, pattern, `${method} ${concrete} resolved to ${hit.path}`);
    }
});
