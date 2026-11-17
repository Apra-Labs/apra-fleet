import { describe, it, expect } from 'vitest';
import { runScan, formatReport } from '../scripts/check-secret-terminology.mjs';

// Guards the secret/secure terminology standardization (chore/secret-terminology):
// canonical spelling is {{secret.NAME}} / secret_variable_* / "secret variable";
// {{secure.NAME}} still resolves but must not be what new text recommends.
// See scripts/check-secret-terminology.mjs for the full rule and allowlist.
describe('secret terminology check', () => {
  it('reports zero stale "secure"-spelling hits outside the allowlist', () => {
    const { findings } = runScan();
    expect(findings, formatReport(findings)).toEqual([]);
  });
});
