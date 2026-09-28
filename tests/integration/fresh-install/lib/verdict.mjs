// Pure verdict/report logic for the fresh-install release harness.
// No side effects on import: unit-tested by verdict.test.ts under `npm test`.
//
// In-box pass scripts only RECORD facts, one JSON line per step:
//   { pass, id, cmd, exit, keyline, observed, na? }
// `exit` is a process exit code, an HTTP status, or a string (e.g. "ERR ...").
// `na` (optional) is set by the box when a platform capability is absent
// (e.g. no systemd in the container) -- the step is then N/A with that reason.
// Every expectation lives in checklist.json and is applied here.

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  WARN: 'WARN',          // advisory step that did not meet expectation
  NA: 'N/A',
  ENV: 'ENV-LIMITED',    // failed only because of a documented environment limit
});

/** Replace ${name} placeholders from vars; unknown names are left untouched. */
export function expand(pattern, vars = {}) {
  return String(pattern).replace(/\$\{(\w+)\}/g, (m, k) =>
    vars[k] === undefined || vars[k] === null ? m : escapeRegex(String(vars[k])));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip anything outside printable ASCII (tab kept) -- report files are ASCII only. */
export function asciiOnly(s) {
  return String(s ?? '').replace(/[^\t\x20-\x7e]/g, '');
}

function exitMatches(want, got) {
  if (want === undefined) return true;
  const n = typeof got === 'number' ? got : Number(got);
  const isNum = got !== null && got !== undefined && got !== '' && Number.isFinite(n);
  if (want === 'nonzero') return isNum && n !== 0;
  if (Array.isArray(want)) return isNum && want.includes(n);
  return isNum && n === want;
}

function regexMatches(pattern, text, vars) {
  if (pattern === undefined || pattern === null) return true;
  // A pattern whose placeholder has no value (e.g. no --expect-version given)
  // cannot be checked: treat it as satisfied rather than inventing a failure.
  const expanded = expand(pattern, vars);
  if (/\$\{\w+\}/.test(expanded)) return true;
  return new RegExp(expanded, 'i').test(String(text ?? ''));
}

/** Does `rule` ({exit?, keyline?, observed?}) match `rec`? */
export function ruleMatches(rule, rec, vars = {}) {
  if (!rule) return false;
  return exitMatches(rule.exit, rec.exit)
    && regexMatches(rule.keyline, rec.keyline, vars)
    && regexMatches(rule.observed, rec.observed, vars);
}

/** Steps of `pass` that apply on `platform`. */
export function stepsFor(checklist, pass, platform) {
  const p = checklist.passes?.[pass];
  if (!p) throw new Error(`unknown pass "${pass}"`);
  return p.steps.filter(s => !s.platforms || s.platforms.includes(platform));
}

/**
 * Evaluate one step against its record (or undefined when the box never
 * reported it). Returns { status, reason }.
 */
export function evaluateStep(step, rec, { platform, vars = {} } = {}) {
  const severity = step.severity ?? 'required';
  const failStatus = severity === 'required' ? STATUS.FAIL : STATUS.WARN;
  if (!rec) return { status: failStatus, reason: 'no result recorded (box script did not reach this step)' };
  if (rec.na) return { status: STATUS.NA, reason: asciiOnly(rec.na) };
  if (step.na && ruleMatches(step.na, rec, vars)) {
    return { status: STATUS.NA, reason: step.na.reason ?? 'not served by this build' };
  }
  if (ruleMatches(step.expect ?? {}, rec, vars)) return { status: STATUS.PASS, reason: '' };
  for (const env of step.envLimited ?? []) {
    if ((!env.platforms || env.platforms.includes(platform)) && ruleMatches(env, rec, vars)) {
      return { status: STATUS.ENV, reason: env.note ?? 'environment limit' };
    }
  }
  return { status: failStatus, reason: describeExpectation(step.expect ?? {}, vars) };
}

export function describeExpectation(expect, vars = {}) {
  const parts = [];
  if (expect.exit !== undefined) parts.push(`exit ${Array.isArray(expect.exit) ? expect.exit.join('|') : expect.exit}`);
  if (expect.keyline !== undefined) parts.push(`keyline ~ /${expand(expect.keyline, vars)}/`);
  if (expect.observed !== undefined) parts.push(`observed ~ /${expand(expect.observed, vars)}/`);
  return `expected ${parts.join(', ') || 'a result'}`;
}

/** Parse results.jsonl text; malformed lines are reported, not thrown. */
export function parseResults(text) {
  const records = [];
  const errors = [];
  for (const [i, line] of String(text ?? '').split(/\r?\n/).entries()) {
    const t = line.replace(/^\uFEFF/, '').trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch (e) { errors.push(`line ${i + 1}: ${e.message}`); }
  }
  return { records, errors };
}

/**
 * Evaluate a whole pass. `records` may contain other passes' lines; the last
 * record per id wins. `driverError` (string) marks a pass whose sandbox or
 * container never produced results.
 */
export function evaluatePass({ checklist, pass, platform, records = [], vars = {}, informational = false, driverError = null }) {
  const byId = new Map();
  for (const r of records) if (!r.pass || r.pass === pass) byId.set(r.id, r);
  const steps = stepsFor(checklist, pass, platform).map(step => {
    const rec = byId.get(step.id);
    const { status, reason } = evaluateStep(step, rec, { platform, vars });
    return {
      id: step.id,
      title: step.title,
      severity: step.severity ?? 'required',
      cmd: asciiOnly(rec?.cmd ?? ''),
      exit: rec?.exit ?? null,
      keyline: asciiOnly(rec?.keyline ?? ''),
      observed: asciiOnly(rec?.observed ?? ''),
      status,
      reason,
    };
  });
  const failed = steps.filter(s => s.status === STATUS.FAIL);
  const verdict = driverError || failed.length > 0 ? STATUS.FAIL : STATUS.PASS;
  return {
    pass,
    platform,
    title: checklist.passes[pass].title,
    informational,
    driverError: driverError ? asciiOnly(driverError) : null,
    verdict,
    blocking: verdict === STATUS.FAIL && !informational,
    counts: countBy(steps.map(s => s.status)),
    steps,
  };
}

function countBy(list) {
  const out = {};
  for (const k of list) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Overall result: exit code non-zero iff a non-informational pass failed. */
export function summarize(passResults) {
  const blocking = passResults.filter(p => p.blocking).map(p => `${p.platform}/${p.pass}`);
  return { exitCode: blocking.length ? 1 : 0, blocking };
}

function mdCell(s) {
  return asciiOnly(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function renderMarkdown(report) {
  const L = [];
  L.push(`# Fresh-install release test report`);
  L.push('');
  L.push(`- Candidate: ${mdCell(report.candidate?.path)} (${mdCell(report.candidate?.sha256)})`);
  if (report.vars?.expectVersion) L.push(`- Expected version: ${mdCell(report.vars.expectVersion)}`);
  if (report.vars?.baselineVersion) L.push(`- Baseline: ${mdCell(report.vars.baselineVersion)}`);
  L.push(`- Started: ${mdCell(report.startedAt)}  Finished: ${mdCell(report.finishedAt)}`);
  L.push(`- Overall: ${report.summary.exitCode === 0 ? 'PASS' : 'FAIL'}${report.summary.blocking.length ? ` (blocking: ${report.summary.blocking.join(', ')})` : ''}`);
  L.push('');
  for (const p of report.passes) {
    L.push(`## ${p.platform} / pass ${p.pass}: ${mdCell(p.title)} -- ${p.verdict}${p.informational ? ' (informational)' : ''}`);
    L.push('');
    if (p.driverError) { L.push(`Driver error: ${mdCell(p.driverError)}`); L.push(''); }
    L.push('| Step | Severity | Status | Exit | Key output | Command | Note |');
    L.push('|---|---|---|---|---|---|---|');
    for (const s of p.steps) {
      const key = [s.keyline, s.observed && s.observed !== s.keyline ? `[${s.observed}]` : ''].filter(Boolean).join(' ');
      L.push(`| ${mdCell(`${s.id} ${s.title}`)} | ${s.severity} | ${s.status} | ${mdCell(String(s.exit ?? ''))} | ${mdCell(key)} | ${mdCell(s.cmd)} | ${mdCell(s.reason)} |`);
    }
    L.push('');
  }
  if (report.notes?.length) {
    L.push('## Notes');
    L.push('');
    for (const n of report.notes) L.push(`- ${asciiOnly(n)}`);
    L.push('');
  }
  return L.join('\n');
}
