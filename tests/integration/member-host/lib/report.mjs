// Verdict + report.md for the member-host run, built on fresh-install's shared
// verdict logic (PASS / FAIL / INCONCLUSIVE, same exit codes: 0 / 1 / 3).
import { STATUS, evaluatePass, finalVerdict, renderMarkdown } from '../../fresh-install/lib/verdict.mjs';
import { buildChecklist } from './scenarios.mjs';

/**
 * One line per known gap (an ENV-LIMITED step: it failed only with a
 * documented gap's signature, so it does not block), naming its steps.
 * Printed at the top of the report so a green run never hides one.
 */
export function knownGapLines(passResults) {
  const byNote = new Map();
  for (const p of passResults) {
    for (const s of p.steps) {
      if (s.status !== STATUS.ENV) continue;
      if (!byNote.has(s.reason)) byNote.set(s.reason, []);
      byNote.get(s.reason).push(`${p.platform}/${p.pass} ${s.id}`);
    }
  }
  return [...byNote].map(([note, steps]) => `${note}: ${steps.join(', ')} recorded, not counted as a failure`);
}

/**
 * `recordsByPass`: { RF: [records], ... }; `driverErrors`: { RF: 'message' }.
 * `inconclusive`: reasons that stop the run from proving its claim (stale or
 * missing baseline). Returns { passResults, final, knownGaps, markdown }.
 */
export function buildReport({ passIds, recordsByPass = {}, driverErrors = {}, inconclusive = [], candidate = {}, baselineTag = null, startedAt, finishedAt, notes = [] }) {
  const checklist = buildChecklist();
  const passResults = passIds.map(pass => evaluatePass({
    checklist, pass, platform: 'windows', driver: 'member-host',
    records: recordsByPass[pass] ?? [], driverError: driverErrors[pass] ?? null,
  }));
  const final = finalVerdict(passResults, inconclusive);
  const knownGaps = knownGapLines(passResults);
  let markdown = renderMarkdown({
    candidate, vars: { baselineVersion: baselineTag },
    startedAt, finishedAt, driver: 'member-host (localhost OpenSSH + Git Bash)',
    summary: final, passes: passResults, notes,
  }).replace('# Fresh-install release test report', '# Member-host upgrade test report');
  if (knownGaps.length) {
    markdown = markdown.replace(/^(- Overall: .*)$/m, m => [m, ...knownGaps.map(g => `- ${g}`)].join('\n'));
  }
  return { passResults, final, knownGaps, markdown };
}
