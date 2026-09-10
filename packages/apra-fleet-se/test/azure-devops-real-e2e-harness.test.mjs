import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveRealAdoE2eConfig,
    realAdoE2eSkip,
    REAL_ADO_E2E_ENABLE_FLAG,
    REAL_ADO_E2E_SECRET_ENV,
} from './helpers/azure-devops-real-e2e.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-5co8.6.1 -- pin the opt-in gate for the real Azure DevOps E2E
// lane (azure-devops-real-e2e.mjs). This suite itself is an ordinary, always-
// on unit test: it never sets the real opt-in env vars and never touches the
// network, so it exercises the gate's default (skip) path plus the config
// shape once opted in -- proving the default-skip behavior end to end
// without depending on a live external org.
// =============================================================================

function withEnv(overrides, fn) {
    const saved = {};
    for (const key of Object.keys(overrides)) saved[key] = process.env[key];
    try {
        for (const [key, value] of Object.entries(overrides)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        return fn();
    } finally {
        for (const key of Object.keys(overrides)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

test('resolveRealAdoE2eConfig: skips by default when neither env var is set, naming both the flag and the secret env var', () => {
    withEnv({ [REAL_ADO_E2E_ENABLE_FLAG]: undefined, [REAL_ADO_E2E_SECRET_ENV]: undefined }, () => {
        const cfg = resolveRealAdoE2eConfig();
        check(typeof cfg.skip === 'string', `expected a skip message by default, got: ${JSON.stringify(cfg)}`);
        check(cfg.skip.includes(REAL_ADO_E2E_ENABLE_FLAG), `expected the skip message to name the enable flag, got: ${cfg.skip}`);
        check(cfg.skip.includes(REAL_ADO_E2E_SECRET_ENV), `expected the skip message to name the secret env var, got: ${cfg.skip}`);
        check(realAdoE2eSkip() === cfg.skip, 'realAdoE2eSkip() must mirror resolveRealAdoE2eConfig().skip');
    });
});

test('resolveRealAdoE2eConfig: skips when only the enable flag is set (secret name still missing)', () => {
    withEnv({ [REAL_ADO_E2E_ENABLE_FLAG]: '1', [REAL_ADO_E2E_SECRET_ENV]: undefined }, () => {
        const cfg = resolveRealAdoE2eConfig();
        check(typeof cfg.skip === 'string', `expected a skip message, got: ${JSON.stringify(cfg)}`);
        check(cfg.skip.includes(REAL_ADO_E2E_SECRET_ENV), `expected the skip message to still name the missing secret env var, got: ${cfg.skip}`);
    });
});

test('resolveRealAdoE2eConfig: skips when only the secret name is set (enable flag still unset)', () => {
    withEnv({ [REAL_ADO_E2E_ENABLE_FLAG]: undefined, [REAL_ADO_E2E_SECRET_ENV]: 'fleet-e2e-ado' }, () => {
        const cfg = resolveRealAdoE2eConfig();
        check(typeof cfg.skip === 'string', `expected a skip message, got: ${JSON.stringify(cfg)}`);
        check(cfg.skip.includes(REAL_ADO_E2E_ENABLE_FLAG), `expected the skip message to still name the missing enable flag, got: ${cfg.skip}`);
    });
});

test('resolveRealAdoE2eConfig: a non-"1" enable flag value is treated as unset (never a truthy-string trap)', () => {
    withEnv({ [REAL_ADO_E2E_ENABLE_FLAG]: 'true', [REAL_ADO_E2E_SECRET_ENV]: 'fleet-e2e-ado' }, () => {
        const cfg = resolveRealAdoE2eConfig();
        check(typeof cfg.skip === 'string', `expected APRA_FLEET_ALLOW_REAL_ADO_E2E='true' (not '1') to still skip, got: ${JSON.stringify(cfg)}`);
    });
});

test('resolveRealAdoE2eConfig: with both env vars set, reports skip:false and the resolved config -- defaults match the runbook target', () => {
    withEnv({ [REAL_ADO_E2E_ENABLE_FLAG]: '1', [REAL_ADO_E2E_SECRET_ENV]: 'fleet-e2e-ado' }, () => {
        const cfg = resolveRealAdoE2eConfig();
        check(cfg.skip === false, `expected skip:false when opted in, got: ${JSON.stringify(cfg)}`);
        check(cfg.secretName === 'fleet-e2e-ado', `expected the secret name to be threaded through unchanged, got: ${JSON.stringify(cfg)}`);
        check(cfg.orgUrl === 'https://dev.azure.com/apralabs', `expected the default org URL from the runbook target, got: ${cfg.orgUrl}`);
        check(
            cfg.remoteUrl === 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy',
            `expected the default remote URL from the runbook target, got: ${cfg.remoteUrl}`,
        );
        check(realAdoE2eSkip() === false, 'realAdoE2eSkip() must mirror resolveRealAdoE2eConfig().skip when opted in');
    });
});

test('resolveRealAdoE2eConfig: org URL and remote URL are overridable independently of the secret name', () => {
    withEnv({
        [REAL_ADO_E2E_ENABLE_FLAG]: '1',
        [REAL_ADO_E2E_SECRET_ENV]: 'some-other-secret',
        APRA_FLEET_ADO_E2E_ORG_URL: 'https://dev.azure.com/other-org',
        APRA_FLEET_ADO_E2E_REMOTE_URL: 'https://dev.azure.com/other-org/proj/_git/repo',
    }, () => {
        const cfg = resolveRealAdoE2eConfig();
        check(cfg.skip === false, `expected skip:false, got: ${JSON.stringify(cfg)}`);
        check(cfg.orgUrl === 'https://dev.azure.com/other-org', `expected the overridden org URL, got: ${cfg.orgUrl}`);
        check(cfg.remoteUrl === 'https://dev.azure.com/other-org/proj/_git/repo', `expected the overridden remote URL, got: ${cfg.remoteUrl}`);
    });
});

test('source: no token/secret VALUE literal appears in the harness module (names and placeholders only)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'helpers', 'azure-devops-real-e2e.mjs'), 'utf8');
    // Every credential reference in this module must be either a
    // `{{secure.*}}` placeholder or a bare variable/env name -- never a
    // realistic-looking PAT/token literal. Azure DevOps PATs are long
    // base64-ish strings with no spaces; this is a loose but effective
    // smoke check that nothing resembling one was pasted in.
    const suspicious = /['"][A-Za-z0-9+/=]{40,}['"]/.exec(src);
    check(!suspicious, `expected no long opaque string literal (possible pasted token) in the harness module, found: ${suspicious && suspicious[0]}`);
});
