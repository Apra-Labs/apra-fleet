# Mock-only coverage gap audit (apra-fleet-j918.6)

Feature apra-fleet-j918.6 enumerated six places in `packages/apra-fleet-se`
where a mock or hand-typed fixture stood in for a real execution path, each
tracked by its own implementation bead (j918.6.1-j918.6.5). This document is
the feature-level audit (apra-fleet-j918.6.6) confirming what actually landed
on this branch, since a bead's CLOSED status on this branch does not by
itself guarantee its deliverable is still reachable from HEAD (see "Branch
history finding" below).

All evidence below was gathered by running the named test files directly
against the tree at commit `ec70c3ce` on `chore/j918-test-suite-cleanup`.

## Branch history finding: two closed beads' work was silently dropped

`chore/j918-test-suite-cleanup` was reset to a stale `origin/...` ref twice
during this sprint (`git reflog show chore/j918-test-suite-cleanup`). The KB
already flagged one casualty (commit `d8696944`). Auditing all six gaps for
this task surfaced two more, both from the **second** reset (reflog entry
`{6}`, "moving to origin/chore/j918-test-suite-cleanup"):

| Bead | Dropped commit | Deliverable | Found missing from HEAD |
|---|---|---|---|
| apra-fleet-j918.6.1 | `cac307bc` | `test/git-sync-real-repo.test.mjs` + `test/helpers/git-repo-fixture.mjs` | yes -- files absent from disk despite the bead's detailed CLOSED notes describing them |
| apra-fleet-j918.6.5 | `3bb545d0` | `test/dolt-sync-tip-fingerprint-real.test.mjs` | yes -- file absent from disk despite the bead's CLOSED status |
| apra-fleet-j918.6.4 | `946e49e2` | the "real shell" cases in `test/newtask-body-file-roundtrip.test.mjs` / `test/newtask-body-member-side-transport.test.mjs` | yes -- both files existed (from an earlier feature) but neither contained the real-shell additions the bead's CLOSED notes described |

Both beads' review verdicts were accurate for the tree they were reviewed
against; the reset happened afterward and nothing re-synced the beads'
status with the branch. All three commits were still present as reachable
git objects (not garbage-collected), so each was restored via
`git cherry-pick` with **zero conflicts** rather than re-implemented, and
reverified against the current tree before landing:

- `f9f142a9` -- restores `cac307bc` (gap 1) and `3bb545d0` (gap 5)
- `ec70c3ce` -- restores `946e49e2` (gap 6)

Each restoration was independently re-verified non-vacuous on the *current*
tree (not just trusted from the original commit message) by reverting the
production fix the test guards, confirming the restored test fails, then
restoring production code:

- gap 1: weakening `member-sync.mjs`'s `git merge --ff-only` to `git merge`
  makes `git-sync-real-repo.test.mjs`'s G-pull subtest fail (3 pass / 1 fail).
- gap 5: widening `dolt-sync.mjs`'s `parseLsRemoteTip` ref match to accept
  any ref makes `dolt-sync-tip-fingerprint-real.test.mjs`'s extra-refs
  subtest fail (4 pass / 1 fail).
- gap 6: changing `member-provisioning.mjs`'s `stageCommandBodyMemberSide` to
  interpolate raw content instead of the base64 argv reproduces the exact
  mangled-bytes failure the original commit message recorded (0 pass / 2
  fail on the two new "real shell" cases).

All three were reverted immediately after and the full apra-fleet-se suite
was re-run clean (see "Full suite" below). No production file carries a
diff from this audit.

## Gap disposition table

| # | Gap | Disposition | Real-execution test(s) | Tests | Wall clock |
|---|---|---|---|---|---|
| 1 | Unconditional git/gh success mock in `mock-sprint-harness.mjs` | Real-execution test added (apra-fleet-j918.6.1); restored this task after the branch-reset drop | `test/git-sync-real-repo.test.mjs` | 4/4 pass | 5.1-5.7s (isolated re-runs) |
| 2 | Hand-typed stderr fixtures behind `classifyGitFailure`/`classifyDoltFailure` | Real-execution test added (apra-fleet-j918.6.2, commit `9d458106`); present and green | `test/git-sync-brackets.test.mjs`, `test/dolt-sync-brackets.test.mjs` | 38/38, 58/58 pass | ~0.7s, ~1.1s |
| 3 | Windows orphan-killer PowerShell stand-in | Real-execution test added (apra-fleet-j918.6.3, commit `c5671c5e`); present and green | `test/supervisor-dolt-orphan-sweep.test.mjs` | 19/19 pass | ~1.9s |
| 4 | Vacuous `se-os-commands` `typeof` assertion | Real-execution test added (apra-fleet-j918.6.3, same commit as #3); present and green | `test/se-os-commands-shell-matrix.test.mjs` | 46/46 pass | ~4.0s |
| 5 | `refs/dolt/data` tip fingerprint hand-built `ls-remote` fixture | Real-execution test added (apra-fleet-j918.6.5); restored this task after the branch-reset drop | `test/dolt-sync-tip-fingerprint-real.test.mjs` | 5/5 pass | 4.6-5.1s (isolated re-runs) |
| 6 | Never-executed `node -e` staging command in the two newtask transport tests | Real-shell cases added (apra-fleet-j918.6.4); restored this task after the branch-reset drop | `test/newtask-body-file-roundtrip.test.mjs`, `test/newtask-body-member-side-transport.test.mjs` (the two "real shell:" subtests) | 11/11 pass (both files, includes pre-existing subtests) | ~0.8-1.4s combined |

All six gaps now have a real-execution test committed on this branch, and
**none is an accepted-risk-only disposition** -- no `docs/` accepted-risk
entry was needed because every gap ended up with genuine coverage. Gaps 3/4
and 6 are host-gated (real PowerShell / real bash), each with a named
`DEGRADED-skip` reason (not a silent pass) when the required shell is absent
from `PATH`; this host has `pwsh 7.5.4` and `bash`, so every gate ran for
real when the evidence above was gathered.

## Lane: all six land in the DEFAULT suite, not `test/slow`

Every file above matches `packages/apra-fleet-se/test/*.test.mjs`, the glob
`npm test` (`scripts/run-tests.mjs mock`) runs by default, which is what
`.github/workflows/ci.yml`'s "Run workspace package test suites (node:test)"
step executes on every PR (`npm test --workspaces --if-present`). None of
this coverage was placed in `test/slow`, which is excluded from the default
suite and only reached by `npm run test:slow` -- the exact trap the KB entry
for `test/slow/dispatch-watchdog-timer-ref.test.mjs` warns about.

## Additivity: `mock-sprint-harness.mjs`'s git/gh mock and failure hook are unchanged

`git log --oneline -- packages/apra-fleet-se/test/helpers/mock-sprint-harness.mjs`
shows the last commit touching that file was `16cf4a2d`, the merge this
sprint branched from, when this section was first written. That is no
longer true at branch HEAD: commit `82892236` (apra-fleet-j918.8.8) later
touched the file, but only to correct the harness's fabricated Azure DevOps
PR-create response body (`_links.web.href`, which no consumer ever read) to
match the fields `vcs-providers/azure-devops.mjs`'s `mapPullRequestResponse`
and the real `vcs-http-stub.test.mjs` `AZURE_CREATE_PR_201` fixture actually
return -- unrelated to this feature's git/dolt real-execution scope
(`git diff 16cf4a2d 82892236 -- packages/apra-fleet-se/test/helpers/mock-sprint-harness.mjs`
confirms the diff is confined to that one response body). The unconditional
git/gh mock (`mockCmdResult(0, 'ok (mocked -- no real git remote in this
mock sprint)', '')`, guarded on `/^(git|gh)\s/`) and the `gitGhFailurePattern`
failure-injection hook remain byte-identical to before this feature started.
99 files under `packages/apra-fleet-se/test/` still reference the harness
(94 of the `*.test.mjs` files directly), confirming this feature's
real-execution additions are purely additive, not a replacement.

## Side effects: no artifacts outside each test's own sandbox

- `git-sync-real-repo.test.mjs`: `/tmp` entry count unchanged across two
  isolated re-runs (7702 before, 7702 after both times). Its fixture
  (`test/helpers/git-repo-fixture.mjs`) redirects
  `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME`/`GIT_CONFIG_GLOBAL`/
  `GIT_CONFIG_SYSTEM` into its own tempdir with `GIT_CONFIG_NOSYSTEM=1`, so
  real git cannot write outside the sandbox.
- `dolt-sync-tip-fingerprint-real.test.mjs`: same check, same result (7702
  before/after, twice).
- `newtask-body-file-roundtrip.test.mjs` / `newtask-body-member-side-transport.test.mjs`:
  the two new "real shell" cases each use their own `stage-realshell-`/
  `stage-realshell-ps-` `mkdtemp` sandbox with an explicit `fs.rm(...,
  {recursive:true, force:true})` in a `finally`; zero `stage-realshell*`
  directories remained under `/tmp` after any run in this audit. (These two
  files also contain older, pre-existing `roundtrip-`/`degradation-`/
  `remote-member-emulated-` sandboxes with no such cleanup call -- a
  pre-existing leak in code this task did not touch and that is out of this
  audit's scope; noted here so it is not mistaken for something the
  restored "real shell" cases introduced.)

## Full apra-fleet-se suite

Two clean, unmodified `npm test` runs (no concurrent file edits during
either) both passed fully:

- Run 2 (`/tmp/full-suite-run2.log`): `SUMMARY pass=3619 fail=0` (102.5s)
- Run 3 (`/tmp/full-suite-run3.log`): `SUMMARY pass=3619 fail=0` (108.3s)

(An earlier attempt was discarded as invalid evidence: it was contaminated
by this audit's own `git cherry-pick`/verification edits landing on disk
mid-run, and is not counted as a suite result either way.)

**Known residual flake, out of this bead's scope:** that first, discarded
run did surface a real but unrelated concurrency defect --
`test/golden-transcript.test.mjs`'s `runGoldenScenario()` uses a hardcoded
branch (`auto-sprint/mock-sprint`) and never sets
`APRA_FLEET_SPRINT_LOCK_DIR`, unlike `test/helpers/mock-sprint-harness.mjs`'s
`runMockSprint` (apra-fleet-ot2z.14) and
`test/golden-transcript-3bead.test.mjs`, both of which isolate their sprint
lock. Under enough concurrent invocations of the same mock-sprint scenario
(e.g. `test/phase1-leaf-facade-completeness.test.mjs`'s and
`test/phase3-dispatch-engine-completeness.test.mjs`'s nested golden-transcript
children racing the top-level `golden-transcript.test.mjs` run), this can
intermittently surface as `SprintLockHeldError`/`SPRINT_LOCK_HELD`. This is
pre-existing on this branch, unrelated to any of the six gaps this feature
closes, and is documented separately (see `bd show apra-fleet-j918.13.1`'s
notes for the full repro) as a candidate for its own follow-up bead giving
`runGoldenScenario` a private lock directory. It is called out here only so
a future "full suite passes" run that hits it is not mistaken for a
regression in this feature's work.

## Summary

All six gaps have a committed, currently-green, real-execution disposition
in the DEFAULT test lane; the harness's mocked git/gh success remains
unchanged and still serves its other ~99 consumers; the three
branch-reset-dropped deliverables (gaps 1, 5, 6) were restored via
cherry-pick and independently reverified non-vacuous against the current
tree, not just trusted from history; and two clean full-suite runs both
passed 3619/3619.
