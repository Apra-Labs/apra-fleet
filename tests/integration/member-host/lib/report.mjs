// Verdict + report.md for the member-host run, built on fresh-install's shared
// verdict logic (PASS / FAIL / INCONCLUSIVE, same exit codes: 0 / 1 / 3).
import { evaluatePass, finalVerdict, renderMarkdown } from '../../fresh-install/lib/verdict.mjs';
import { buildChecklist } from './scenarios.mjs';

/**
 * `recordsByPass`: { RF: [records], ... }; `driverErrors`: { RF: 'message' }.
 * `inconclusive`: reasons that stop the run from proving its claim (stale or
 * missing baseline). Returns { passResults, final, markdown }.
 */
export function buildReport({ passIds, recordsByPass = {}, driverErrors = {}, inconclusive = [], candidate = {}, baselineTag = null, startedAt, finishedAt, notes = [] }) {
  const checklist = buildChecklist();
  const passResults = passIds.map(pass => evaluatePass({
    checklist, pass, platform: 'windows', driver: 'member-host',
    records: recordsByPass[pass] ?? [], driverError: driverErrors[pass] ?? null,
  }));
  const final = finalVerdict(passResults, inconclusive);
  const markdown = renderMarkdown({
    candidate, vars: { baselineVersion: baselineTag },
    startedAt, finishedAt, driver: 'member-host (localhost OpenSSH + Git Bash)',
    summary: final, passes: passResults, notes,
  }).replace('# Fresh-install release test report', '# Member-host upgrade test report');
  return { passResults, final, markdown };
}
