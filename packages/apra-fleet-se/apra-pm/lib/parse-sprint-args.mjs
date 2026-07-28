// Parses the raw args value passed to the auto-sprint workflow and returns
// a normalised options object. Kept in a separate module so it can be unit-tested
// without the workflow runtime.
//
// Accepted forms:
//   "BD-1"                             -> { issues: ["BD-1"] }
//   "BD-1 BD-2"  or  "BD-1,BD-2"      -> { issues: ["BD-1","BD-2"] }
//   '["BD-1","BD-2"]'                  -> { issues: ["BD-1","BD-2"] }
//   '{"issues":["BD-1"],"goal":"P1"}'  -> { issues: ["BD-1"], goal: "P1" }
//   null / undefined / ""              -> {}
//
// branch is intentionally NOT defaulted here; the caller defaults it to ''
// (which the setup agent resolves to the current git branch).

export function parseSprintArgs(args) {
  if (!args) return {};

  let parsed = null;
  try { parsed = JSON.parse(args); } catch {}

  if (Array.isArray(parsed)) {
    return { issues: parsed };
  }
  if (parsed && typeof parsed === 'object') {
    return parsed;
  }
  // bare string: space- or comma-separated issue IDs
  const ids = String(args).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  return { issues: ids };
}

export function resolveSprintOpts(args) {
  const opts = parseSprintArgs(args);
  const rawIssues = opts.issues || [];
  return {
    branch:           opts.branch           || '',
    rootIds:          Array.isArray(rawIssues) ? rawIssues : [rawIssues],
    goal:             opts.goal             || 'P1/P2',
    maxCycles:        Number(opts.max_cycles) || 5,
    requirementsFile: opts.requirementsFile  || '',
    base_branch:      opts.base_branch       || 'main',
  };
}
