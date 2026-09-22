import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveRealBitbucketE2eConfig,
    realBitbucketE2eSkip,
    REAL_BITBUCKET_E2E_ENABLE_FLAG,
    REAL_BITBUCKET_E2E_SECRET_ENV,
    REAL_BITBUCKET_E2E_EMAIL_ENV,
    REAL_BITBUCKET_E2E_REMOTE_URL_ENV,
} from './helpers/bitbucket-real-e2e.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-qeq1.6.1 -- pin the opt-in gate for the real Bitbucket E2E lane
// (bitbucket-real-e2e.mjs), mirroring azure-devops-real-e2e-harness.test.mjs.
// This suite itself is an ordinary, always-on unit test: it never sets the
// real opt-in env vars and never touches the network, so it exercises the
// gate's default (skip) path plus the config shape once opted in -- proving
// the default-skip behavior end to end without depending on a live external
// workspace. This file is also what makes bitbucket-real-e2e.mjs an IMPORTED
// module rather than dead code with no test coverage of its own.
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

const OPTED_IN = {
    [REAL_BITBUCKET_E2E_ENABLE_FLAG]: '1',
    [REAL_BITBUCKET_E2E_SECRET_ENV]: 'fleet-e2e-bitbucket',
    [REAL_BITBUCKET_E2E_EMAIL_ENV]: 'e2e-bot@example.com',
};

test('resolveRealBitbucketE2eConfig: skips by default when none of the env vars are set, naming the flag, the secret env var and the email env var', () => {
    withEnv({ [REAL_BITBUCKET_E2E_ENABLE_FLAG]: undefined, [REAL_BITBUCKET_E2E_SECRET_ENV]: undefined, [REAL_BITBUCKET_E2E_EMAIL_ENV]: undefined }, () => {
        const cfg = resolveRealBitbucketE2eConfig();
        check(typeof cfg.skip === 'string', `expected a skip message by default, got: ${JSON.stringify(cfg)}`);
        check(cfg.skip.includes(REAL_BITBUCKET_E2E_ENABLE_FLAG), `expected the skip message to name the enable flag, got: ${cfg.skip}`);
        check(cfg.skip.includes(REAL_BITBUCKET_E2E_SECRET_ENV), `expected the skip message to name the secret env var, got: ${cfg.skip}`);
        check(cfg.skip.includes(REAL_BITBUCKET_E2E_EMAIL_ENV), `expected the skip message to name the email env var, got: ${cfg.skip}`);
        check(!/apra-fleet-[a-z0-9]/i.test(cfg.skip), `expected the runtime-printed skip message to name no bead id, got: ${cfg.skip}`);
        check(realBitbucketE2eSkip() === cfg.skip, 'realBitbucketE2eSkip() must mirror resolveRealBitbucketE2eConfig().skip');
    });
});

test('resolveRealBitbucketE2eConfig: skips when the secret name and email are set but the enable flag is missing', () => {
    withEnv({ ...OPTED_IN, [REAL_BITBUCKET_E2E_ENABLE_FLAG]: undefined }, () => {
        const cfg = resolveRealBitbucketE2eConfig();
        check(typeof cfg.skip === 'string', `expected a skip message, got: ${JSON.stringify(cfg)}`);
        check(cfg.skip.includes(REAL_BITBUCKET_E2E_ENABLE_FLAG), `expected the skip message to still name the missing enable flag, got: ${cfg.skip}`);
    });
});

test('resolveRealBitbucketE2eConfig: skips when the flag and email are set but the secret name is missing', () => {
    withEnv({ ...OPTED_IN, [REAL_BITBUCKET_E2E_SECRET_ENV]: undefined }, () => {
        const cfg = resolveRealBitbucketE2eConfig();
        check(typeof cfg.skip === 'string', `expected a skip message, got: ${JSON.stringify(cfg)}`);
        check(cfg.skip.includes(REAL_BITBUCKET_E2E_SECRET_ENV), `expected the skip message to still name the missing secret env var, got: ${cfg.skip}`);
    });
});

test('resolveRealBitbucketE2eConfig: skips when the flag and secret name are set but the email is missing', () => {
    withEnv({ ...OPTED_IN, [REAL_BITBUCKET_E2E_EMAIL_ENV]: undefined }, () => {
        const cfg = resolveRealBitbucketE2eConfig();
        check(typeof cfg.skip === 'string', `expected a skip message, got: ${JSON.stringify(cfg)}`);
        check(cfg.skip.includes(REAL_BITBUCKET_E2E_EMAIL_ENV), `expected the skip message to still name the missing email env var, got: ${cfg.skip}`);
    });
});

test('resolveRealBitbucketE2eConfig: a non-"1" enable flag value is treated as unset (never a truthy-string trap)', () => {
    withEnv({ ...OPTED_IN, [REAL_BITBUCKET_E2E_ENABLE_FLAG]: 'true' }, () => {
        const cfg = resolveRealBitbucketE2eConfig();
        check(typeof cfg.skip === 'string', `expected APRA_FLEET_ALLOW_REAL_BITBUCKET_E2E='true' (not '1') to still skip, got: ${JSON.stringify(cfg)}`);
    });
});

test('resolveRealBitbucketE2eConfig: with all env vars set, reports skip:false and the resolved config -- defaults match the runbook target', () => {
    withEnv(OPTED_IN, () => {
        const cfg = resolveRealBitbucketE2eConfig();
        check(cfg.skip === false, `expected skip:false when opted in, got: ${JSON.stringify(cfg)}`);
        check(cfg.secretName === 'fleet-e2e-bitbucket', `expected the secret name to be threaded through unchanged, got: ${JSON.stringify(cfg)}`);
        check(cfg.email === 'e2e-bot@example.com', `expected the email to be threaded through unchanged, got: ${JSON.stringify(cfg)}`);
        check(
            cfg.remoteUrl === 'git@bitbucket.org:kumaakh/apra-analytics.git',
            `expected the default remote URL from the runbook target, got: ${cfg.remoteUrl}`,
        );
        check(cfg.baseBranch === 'main', `expected the default base branch 'main', got: ${cfg.baseBranch}`);
        check(realBitbucketE2eSkip() === false, 'realBitbucketE2eSkip() must mirror resolveRealBitbucketE2eConfig().skip when opted in');
    });
});

test('resolveRealBitbucketE2eConfig: remote URL is overridable independently of the secret name and email', () => {
    withEnv({
        ...OPTED_IN,
        [REAL_BITBUCKET_E2E_SECRET_ENV]: 'some-other-secret',
        [REAL_BITBUCKET_E2E_REMOTE_URL_ENV]: 'git@bitbucket.org:other-workspace/other-repo.git',
    }, () => {
        const cfg = resolveRealBitbucketE2eConfig();
        check(cfg.skip === false, `expected skip:false, got: ${JSON.stringify(cfg)}`);
        check(cfg.remoteUrl === 'git@bitbucket.org:other-workspace/other-repo.git', `expected the overridden remote URL, got: ${cfg.remoteUrl}`);
    });
});

test('source: no token/secret VALUE literal appears in the harness module (names and placeholders only)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'helpers', 'bitbucket-real-e2e.mjs'), 'utf8');
    // Every credential reference in this module must be either a
    // `{{secret.*}}` placeholder or a bare variable/env name -- never a
    // realistic-looking app-password/token literal. This is a loose but
    // effective smoke check that nothing resembling one was pasted in.
    const suspicious = /['"][A-Za-z0-9+/=]{40,}['"]/.exec(src);
    check(!suspicious, `expected no long opaque string literal (possible pasted token) in the harness module, found: ${suspicious && suspicious[0]}`);
});
