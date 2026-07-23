// Independent post-sprint validation gates.
//
// "All checkpoints PASS" is self-reported by the orchestrator and proves nothing.
// These gates assert, from the pushed branch and the real PR, that a disciplined
// plan -> doer -> review sprint actually took place:
//
//   1. pr-exists              a PR was raised for the branch
//   2. commits>=N             the work landed as N+ real commits (beads-only exports excluded)
//   3. final-changeset-clean  the PR's net diff carries NO process scaffolding
//                             (requirements.md, feedback.md)
//   4. process-discipline     those scaffolding files DID appear in intermediate commits
//                             AND feedback.md contained an APPROVED/CHANGES NEEDED verdict.
//                             skills/pm/*.md forbids the reviewer/plan-reviewer from ever
//                             writing feedback.md (structured output only), so every
//                             skill-driven suite (s1/s7/s8/s9) excludes this gate. s10 runs
//                             .claude/workflows/auto-sprint.js instead, which still writes
//                             and strips feedback.md as a file-based message bus, but it
//                             excludes the gate too (see suites.json history) -- so no
//                             suite currently exercises it. Left in place for a future
//                             suite that wants to assert on auto-sprint.js's feedback.md
//                             mechanism specifically.
//   5. planner-created-tasks  a "plan:" commit exists in the branch history
//   6. beads-closed           P1 issues were closed (from any durable source)
//   7. beads-sprint-closed    P1 closures evidenced in committed branch .beads/*.jsonl
//   8. harvester-ran          a harvest artifact (docs/, CHANGELOG, .analysis.md) is in
//                             the net diff
//
// evaluateGates() is pure (takes gathered facts, returns verdicts) so it is unit
// testable; validateSprint() gathers those facts from a git clone + the PR object.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const SCAFFOLD = ['requirements.md', 'feedback.md'];
const baseName = (p) => p.split('/').pop().toLowerCase();

// ---- pure verdict logic -------------------------------------------------------

export function evaluateGates(d) {
  const gates = [];
  const skip = new Set(d.excludeGates || []);
  const add = (name, pass, detail = '') => { if (!skip.has(name)) gates.push({ name, pass, detail }); };

  add('pr-exists', !!(d.pr && d.pr.url), d.pr ? `#${d.pr.number}` : 'no PR found');

  const minCommits = d.minCommits ?? 10;
  const real = d.realCommitCount ?? d.commitCount ?? 0;
  const total = d.commitCount ?? 0;
  add(`commits>=${minCommits}`, real >= minCommits,
    `${real} real commits (${total} total)`);

  const finalBases = (d.finalFiles || []).map(baseName);
  const leaked = SCAFFOLD.filter((f) => finalBases.includes(f));
  add('final-changeset-clean', leaked.length === 0,
    leaked.length ? `process files still in net diff: ${leaked.join(', ')}` : 'no process files in net diff');

  const touched = new Set((d.touchedBasenames || []).map((s) => s.toLowerCase()));
  const missing = SCAFFOLD.filter((f) => !touched.has(f));
  const hasVerdict = (d.feedbackVerdicts || []).length > 0;
  const disciplineFail = missing.length > 0 || !hasVerdict;
  add('process-discipline', !disciplineFail,
    disciplineFail
      ? [
          missing.length ? `never committed: ${missing.join(', ')}` : '',
          !hasVerdict ? 'feedback.md never contained APPROVED/CHANGES NEEDED' : '',
        ].filter(Boolean).join('; ')
      : 'scaffold committed and feedback.md contained a verdict');

  const plannerRan = !!(d.plannerRan);
  add('planner-created-tasks', plannerRan,
    plannerRan
      ? 'plan: commit found in branch history'
      : 'no plan: commit found in branch history -- planner may not have run');

  const expected = d.expectedIssues ?? 3;
  const closed = d.closedP1 || [];
  add('beads-closed', closed.length >= expected,
    `${closed.length} of the picked P1 issue(s) closed${closed.length ? ': ' + closed.join(', ') : ''}`);

  const sprintClosed = d.beadsSprintClosed || [];
  add('beads-sprint-closed', sprintClosed.length >= expected,
    sprintClosed.length >= expected
      ? `${sprintClosed.length} P1 issue(s) closed in committed branch jsonl: ${sprintClosed.join(', ')}`
      : `only ${sprintClosed.length}/${expected} P1 closures found in committed .beads/*.jsonl (sprint must commit beads state via bd export)`);

  const hasHarvestArtifact = (d.finalFiles || []).some(f =>
    /^docs\//i.test(f) || /changelog/i.test(baseName(f)) || /\.analysis\.md$/i.test(f));
  add('harvester-ran', hasHarvestArtifact,
    hasHarvestArtifact
      ? 'harvest artifact found in net diff (docs/, CHANGELOG, or .analysis.md)'
      : 'no harvest artifact in net diff -- harvester may not have run');

  // Suites that drive the /auto-sprint workflow (s10) additionally assert the
  // auto-sprint-args helper skill is BOTH installed AND actually exercised, so the
  // skill is proven useful end-to-end, not merely shipped.
  if (d.expectArgsSkill) {
    add('args-skill-installed', !!d.argsSkillInstalled,
      d.argsSkillInstalled
        ? 'auto-sprint-args skill present in the provider config dir'
        : 'auto-sprint-args skill NOT installed -- installer did not place it');
    add('args-skill-used', !!d.argsSkillUsed,
      d.argsSkillUsed
        ? 'orchestrator invoked the auto-sprint-args skill before launching /auto-sprint'
        : 'no auto-sprint-args skill invocation found in the run transcript');
  }

  return { gates, pass: gates.every((g) => g.pass) };
}

// Was the auto-sprint-args skill invoked (not merely mentioned) in the run log?
// Matches the stream-json tool-use shape ("skill"/"name": "auto-sprint-args"), which
// the prose scenario prompt does not produce, so a prompt echo is not a false positive.
function argsSkillUsedIn(logPath) {
  if (!logPath) return false;
  let log = '';
  try { log = readFileSync(logPath, 'utf-8'); } catch { return false; }
  return /"(?:skill|name)"\s*:\s*"auto-sprint-args"/.test(log);
}

// Is the auto-sprint-args skill installed in the provider's config dir? Claude installs
// it under ~/.claude/skills/auto-sprint-args/. Checked before teardown uninstalls it.
function argsSkillInstalledFor(provider) {
  const base = provider === 'claude' ? join(os.homedir(), '.claude') : null;
  if (!base) return false;
  return existsSync(join(base, 'skills', 'auto-sprint-args', 'SKILL.md'));
}

// ---- fact gathering -----------------------------------------------------------

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

const isP1 = (o) => o && (o.priority === 1 || o.priority === '1' || String(o.priority).toUpperCase() === 'P1');
const isClosed = (o) => o && String(o.status).toLowerCase() === 'closed';

function parseBeadsJsonl(text, map) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o.id) map.set(o.id, o); } catch { /* skip */ }
  }
  return map;
}

// Baseline issue state from the base branch (pristine, before the sprint).
function readBeadsRef(repo, ref) {
  const map = new Map();
  let names = (git(repo, ['ls-tree', '--name-only', `${ref}:.beads`]).stdout || '')
    .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.jsonl'));
  if (!names.length) names = ['issues.jsonl'];
  for (const n of names) parseBeadsJsonl(git(repo, ['show', `${ref}:.beads/${n}`]).stdout || '', map);
  return map;
}

// Post-run issue state from the ON-DISK .beads DB at the base checkout. The
// orchestrator runs every `bd close` here (the DB is deliberately kept OFF the track
// branch -- see beads.md), so closures never appear in the branch diff. Read the
// working-tree DB to see what was actually closed.
function readBeadsDisk(repo) {
  const map = new Map();
  const dir = join(repo, '.beads');
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return map; }
  if (!names.length) names = ['issues.jsonl'];
  for (const n of names) {
    try { parseBeadsJsonl(readFileSync(join(dir, n), 'utf-8'), map); } catch { /* skip */ }
  }
  return map;
}

// Ask the live bd DB whether an issue is closed, run from the base checkout (where
// the orchestrator ran every `bd` command). Backend-agnostic: works whether bd is
// jsonl-native or dolt-backed (the dolt backend leaves issues.jsonl stale, so this is
// the only on-disk source of truth). Returns false if bd is absent or the query fails.
// NOTE: `bd show --json` returns a single-element ARRAY, not an object.
function bdSaysClosed(repo, id) {
  const r = spawnSync('bd', ['show', id, '--json'], { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout) return false;
  try {
    const parsed = JSON.parse(r.stdout);
    const o = Array.isArray(parsed) ? parsed[0] : parsed;
    const st = o?.status ?? o?.issue?.status;
    return String(st).toLowerCase() === 'closed';
  } catch { return false; }
}

// Gather facts from the pushed branch and evaluate. `repo` is the local clone whose
// origin is the toy; the branch is fetched fresh so this works even though the work
// was done in a worktree sharing the same .git.
export function validateSprint({ repo, branch, pr, minCommits = 10, expectedIssues = 3, excludeGates = [], expectArgsSkill = false, logPath = null, provider = 'claude' }) {
  const argsSkillFacts = expectArgsSkill
    ? { expectArgsSkill: true, argsSkillInstalled: argsSkillInstalledFor(provider), argsSkillUsed: argsSkillUsedIn(logPath) }
    : {};

  git(repo, ['fetch', '-q', 'origin', 'main']);
  git(repo, ['fetch', '-q', 'origin', branch]);
  const head = (git(repo, ['rev-parse', 'FETCH_HEAD']).stdout || '').trim();
  const base = (git(repo, ['rev-parse', 'origin/main']).stdout || '').trim();

  if (!head || !base) {
    return evaluateGates({ pr, commitCount: 0, realCommitCount: 0, finalFiles: [], touchedBasenames: [], feedbackVerdicts: [], closedP1: [], beadsSprintClosed: [], plannerRan: false, minCommits, expectedIssues, excludeGates, ...argsSkillFacts });
  }
  const range = `${base}..${head}`;

  // Per-commit file lists -- needed to filter beads-only commits and for content checks
  const commitLog = (git(repo, ['log', range, '--format=COMMIT:%H', '--name-only']).stdout || '');
  const perCommit = [];
  let cur = null;
  for (const line of commitLog.split('\n')) {
    const t = line.trim();
    if (t.startsWith('COMMIT:')) { if (cur) perCommit.push(cur); cur = { sha: t.slice(7), files: [] }; }
    else if (t && cur) cur.files.push(t);
  }
  if (cur) perCommit.push(cur);

  // A commit counts as "real" only if it touches at least one source or test file.
  // Commits that only export beads state, write sprint-logs, or update process
  // scaffolding do not demonstrate sprint work and are excluded from the threshold.
  const isRealCommit = (files) => files.some(f =>
    /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|rb|swift|kt|php|sh|bash)$/i.test(f));
  const commitCount = perCommit.length;
  const realCommitCount = perCommit.filter(c => isRealCommit(c.files)).length;

  const finalFiles = (git(repo, ['diff', '--name-only', range]).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const touchedPaths = (git(repo, ['log', range, '--name-only', '--pretty=format:']).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const touchedBasenames = touchedPaths.map(baseName);

  // C1: read content of feedback.md at each commit that touched it, look for verdict tokens
  const feedbackShas = perCommit.filter(c => c.files.some(f => baseName(f) === 'feedback.md')).map(c => c.sha);
  const feedbackVerdicts = [];
  for (const sha of feedbackShas.slice(0, 15)) {
    const content = git(repo, ['show', `${sha}:feedback.md`]).stdout || '';
    if (/APPROVED|CHANGES NEEDED/i.test(content)) feedbackVerdicts.push(sha);
  }

  // beads P1 issues that were open at base and are closed after the sprint.
  // Baseline (open P1 candidates) comes from the base branch. For "closed now" read
  // the on-disk DB first (fast, correct when bd is jsonl-native); for any candidate
  // still showing open there, double-check the live bd DB -- `bd init --from-jsonl`
  // switches bd to a db backend that leaves issues.jsonl stale, so a closed issue can
  // still look open in the file (seen on the macOS runner).
  const baseB = readBeadsRef(repo, base);
  const headB = readBeadsRef(repo, head);
  const candidates = [...baseB].filter(([, o]) => isP1(o) && !isClosed(o)).map(([id]) => id);

  // C2: planner ran if there is a commit whose subject starts with "plan:"
  // Checking beads size diff is unreliable -- bd export only runs at cleanup,
  // so a timed-out sprint always fails even if the planner did run.
  const plannerRan = (git(repo, ['log', range, '--grep=^plan[: ]', '-i', '--oneline']).stdout || '').trim().length > 0;

  // An issue counts as closed if ANY durable source says so (dolt leaves the file
  // stale, and the live db may sit in a since-removed worktree, so no single source
  // is reliable across platforms):
  //   1. the branch's committed .beads/issues.jsonl (durable if the skill ran `bd export`)
  //   2. the on-disk .beads/issues.jsonl at the base checkout
  //   3. the live bd db via `bd show`
  const diskB = readBeadsDisk(repo);
  const closedP1 = candidates.filter((id) =>
    isClosed(headB.get(id)) || isClosed(diskB.get(id)) || bdSaysClosed(repo, id));

  // C3/C4: closure evidenced in committed branch jsonl (headB), not just disk/live db
  const beadsSprintClosed = candidates.filter(id => isClosed(headB.get(id)));

  return evaluateGates({ pr, commitCount, realCommitCount, finalFiles, touchedBasenames, touchedPaths, feedbackVerdicts, closedP1, beadsSprintClosed, plannerRan, minCommits, expectedIssues, excludeGates, ...argsSkillFacts });
}
