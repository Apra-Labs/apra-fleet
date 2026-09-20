import { describe, it, expect } from 'vitest';
import { runScan, formatReport } from '../scripts/check-secret-terminology.mjs';

// Guards the secret/secure terminology standardization (chore/secret-terminology):
// canonical spelling is {{secret.NAME}} / secret_variable_* / "secret variable";
// {{secure.NAME}} still resolves but must not be what new text recommends.
// See scripts/check-secret-terminology.mjs for the full rule and allowlist.
//
// NOTE: as of this rename, docs/**, skills/**, and some package docs still use
// the legacy spelling -- fixing those is tracked as separate follow-up work.
// This test is expected to fail until that doc pass lands; it is wired here
// (rather than left unwired) so the terminology drift is visible in `npm test`
// output instead of silently rotting.
describe('secret terminology check', () => {
  it('reports zero stale "secure"-spelling hits outside the allowlist', () => {
    const { findings } = runScan();
    expect(findings, formatReport(findings)).toEqual([]);
  });
});
