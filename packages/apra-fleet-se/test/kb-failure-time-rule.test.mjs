import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Every KB-capable session is told to ask the KB with the error text BEFORE
// diagnosing a failure, and how to treat a scope / access 401 or 403.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS = path.join(HERE, '..', 'apra-pm', 'agents');
const FLEET_SKILL = path.join(HERE, '..', '..', '..', 'skills', 'fleet', 'SKILL.md');
const ROLES = ['doer', 'reviewer', 'deployer', 'integ-test-runner', 'regression-test-runner', 'harvester', 'planner', 'plan-reviewer', 'ci-watcher', 'backlog-groomer', 'kb-reconciler'];

const squash = (s) => s.replace(/\s+/g, ' ');
const files = [...ROLES.map((r) => [r, path.join(AGENTS, `${r}.md`)]), ['fleet skill', FLEET_SKILL]];

for (const [name, file] of files) {
    test(`${name}: failure-time kb_query rule and the 401/403 scope rule are present`, () => {
        const text = squash(fs.readFileSync(file, 'utf8'));
        assert.match(text, /call `kb_query` with the exact error text \(the `error_text` input, plus the `files` and `symbols` you are touching\) BEFORE diagnosing or escalating|call `kb_query` with the exact error text \(the `error_text` input, plus the `files` and `symbols` involved\) BEFORE diagnosing or escalating/);
        assert.match(text, /A missing `kb_query` tool or a failing KB call is never a reason to stop/);
        assert.match(text, /401\/403 that is about scope or access/);
        assert.match(text, /re-provision the credential with the access level the action needs/);
        assert.match(text, /Escalate to the owner only if the tool refuses/);
        assert.match(text, /check how the engine already performs the same action/);
    });

    test(`${name}: the rule text cites no bead id and is ASCII`, () => {
        const raw = fs.readFileSync(file, 'utf8');
        const i = raw.indexOf('Failure-time Knowledge Bank lookup');
        assert.ok(i >= 0);
        const section = raw.slice(i, raw.indexOf('\n## ', i + 10));
        assert.ok(!/apra-fleet-[a-z0-9]+/.test(section));
        // eslint-disable-next-line no-control-regex
        assert.ok(!/[^\x00-\x7F]/.test(section));
    });
}
