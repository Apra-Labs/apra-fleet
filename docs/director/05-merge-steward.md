# Director: merge steward (risk classifier, merge policy, parallel PRs)

Status: DRAFT spec, v0.5. Vocabulary: `01-concepts.md`.

---

## 1. Why this is the critical path

The v0.5 sprint plan's own wall-clock estimate assumes the owner squash-merges
each finished PR within about 2 hours (plan section 1 item 5 and assumption A4).
In practice PASS PRs wait days to weeks (example: PR #676, verdict PASS on
2026-10-06, still open on 2026-11-02). Fleet throughput can never exceed the
operator's review throughput while every merge is manual. Scheduling and
grooming improvements are wasted if this gate is not addressed.

Evidence that it can be addressed safely: Vercel's rollout of an LLM risk
classifier over 400+ PRs/week reached 58% of PRs merging without human review,
zero reverts among 671 auto-approved PRs, with a phased silent -> visible ->
enforced rollout and pre-agreed kill switches. This spec copies the mechanism,
not the scale.

## 2. Risk classifier

Module: `packages/apra-fleet-se/src/director/risk-classifier.mjs`; role prompt
`packages/apra-fleet-se/apra-pm/agents/risk-classifier.md` with output schema
`agents/schemas/risk-classifier-output.json`.

### 2.1 Deterministic pre-rules (evaluated first, override the LLM)

A PR is HIGH without asking the model when ANY holds:
- touches `.fleet/vision.yaml` or `.fleet/policy.yaml`
- touches a path listed in the project's `CODEOWNERS` or in
  `policy.merge.high_paths` (globs)
- changes more than `policy.merge.max_files` files (default 60) or
  `max_lines` (default 1500)
- carries a label in `customer_visible_labels`
- the sprint verdict is not PASS, or the final review is not APPROVED
- CI is not green on all required checks
- author is not the fleet (no sprint run id in the PR body marker)

### 2.2 Model verdict

Input: diff (truncated per file with a manifest), PR title/body, sprint
verdict, bead titles in scope, `policy.merge.risk_guide` text (project-specific
description of what is risky, e.g. "auth, credential store, Dolt sync, install
and upgrade paths, permission composition").

Sandboxing: `execute_prompt` has no per-call tool allowlist, so the
classifier runs on a pool member whose permission profile (via
`compose_permissions`) grants NO tools; the classifier client asserts that
profile (no write or shell tools granted) before every dispatch and refuses to
dispatch otherwise. `max_turns: 1`.

Output (schema-validated JSON):
`{verdict: LOW|HIGH, reasons: [{category, file, snippet}], confidence}`.

- The model MUST cite at least one verbatim snippet per HIGH reason.
- Invalid output, timeout or error -> HIGH (fail closed, I9).
- Prompt-injection hardening: strip invisible Unicode from diff and body before
  classification; the classifier output maps to exactly two actions (label LOW,
  label HIGH); it never sees credentials.

### 2.3 Rollout stages (per project, `policy.merge.stage`)

Effective stage = the more cautious of `policy.merge.stage` (git, operator)
and the stored demotion (`merge_state` table, written by kill switches).
Only the operator clears a demotion (operator credential). This keeps one
direction of change automatic (toward caution) and the other human.

| stage | behaviour | exit criterion to next stage |
|---|---|---|
| `silent` | classify every fleet PR; record verdict in the decision store; no visible output | 30 classified PRs |
| `visible` | label + PR comment with verdict and reasons; operator can mark "incorrect" (API / dashboard), which records a disagreement | operator-agreement >= 95% over the last 30 PRs, zero LOW-labelled PRs reverted |
| `enforced` | `merge_pr.low` authority applies (policy decides `do`/`do_notify`/`propose`) | -- |

Stage changes are operator actions (`policy_file_change`), not automatic.

### 2.4 Kill switches (automatic demotion record to `visible`)

- any auto-merged PR reverted within 7 days -> demote + debit `reverted_merges`
  + notify urgent
- integration branch red for > 2 h after an auto-merge -> demote + notify
- disagreement rate > 10% over the last 20 PRs -> demote + notify

## 3. Merge execution

The merge steward is a deterministic worker inside the supervisor (Refinery
pattern: merging is its own retrying step, separate from the sprint).

- Forge access: existing `fleet-sprint/vcs-providers` builders only create,
  comment, find and update PRs through member shells. The director needs a
  supervisor-side forge client (`src/director/forge/github.mjs`, REST, using
  the same GitHub App / token credential the PR publisher uses, read from the
  credential store) that lists PRs, reads checks and reviews, detects reverts,
  calls update-branch and merges. Built in D3a (read) and D6a (write).
- Watches PRs created by fleet runs (PR body marker
  `fleet-sprint:run-history`) targeting the project's integration branch.
- For each PR with `merge_pr.*` mode `do`/`do_notify`: confirm CI green on the
  exact head SHA, confirm the branch is up to date with the base (or rebase via
  the forge's update-branch API and wait for CI again), then squash-merge with
  the forge API (squash matches the integration branch rule in `CLAUDE.md`).
- Serial per integration branch: one merge in flight at a time; after each
  merge, re-check the next PR's mergeability.
- On merge conflict: do NOT resolve automatically in v0.5. Emit
  `pr.conflicted`; the event router may queue a rebase sprint (class
  `ci_fix_sprint` caps apply).
- The PR body's "Do NOT auto-merge" sentence (pm skill rule) is replaced, for
  fleet-sprint PRs on projects with `stage=enforced`, by "Merge policy:
  <class>, decided by <rule>".
- Never merges into a branch listed in `policy.merge.protected_targets`
  (default: the release branch, e.g. `main`); promotion stays an operator
  action (`promote_release`, `propose_blocking`).

## 4. Parallel PRs while merges are blocked

Rule (operator's idea): if members are free but merges are blocked, keep making
progress with additional PRs, within bounds.

`parallel_prs_when_merge_blocked` is evaluated by the scheduler when it has a
ready sprint and a free eligible member but the project is in a
merge-blocked state.

### 4.1 Blocked reasons (computed, not guessed)

| reason | detected by | parallel work allowed? |
|---|---|---|
| `awaiting_human_review` | open fleet PRs with mode propose/propose_blocking | yes |
| `ci_infra_outage` | CI gate reports infra/not-started on >= 2 consecutive PRs, or forge status API degraded | yes |
| `merge_freeze` | operator flag or `release_candidate` phase for feature work | yes, fixes only in RC |
| `integration_red` | the integration branch's latest CI is red from a code failure | NO: all capacity goes to fixing the branch (vision trade-off "reliability over features") |
| `conflict_storm` | >= 2 open fleet PRs conflicting with base | NO: rebase/fix first |

### 4.2 Shape of allowed parallel work

A new sprint may start while merges are blocked only if its expected file set
is INDEPENDENT of every open fleet PR (no overlapping paths at directory depth
2, computed from the planner's file list for the candidate and the diffs of
open PRs), OR it is explicitly stacked on exactly one open PR with stack depth
<= 2 (branch from that PR's head; PR targets that PR's branch; retargeted by
the merge steward when the parent merges).

### 4.3 Bounds

- `max_open_prs` per project (policy) counts all open fleet PRs.
- Backpressure (`max_prs_awaiting_human`) counts only PRs that need a human
  (classifier HIGH, or stage != enforced). LOW PRs that the steward will merge
  do not count.
- When the block clears, the steward merges in dependency order (stack parents
  first) and the scheduler returns to normal launches.

## 5. Acceptance

- Pre-rule table tests: every rule in 2.1 forces HIGH regardless of model output.
- Fail-closed tests: invalid JSON, timeout, error -> HIGH.
- Stage tests: `silent` produces no PR comment; `visible` comments; `enforced`
  merges only with policy mode do/do_notify.
- Kill-switch tests with a fake forge: revert detection demotes to `visible`.
- Merge execution tests with a fake forge: stale branch -> update + wait CI;
  conflict -> `pr.conflicted`, no merge; protected target -> refused.
- Parallel-PR tests: each blocked reason yields the allowed/denied result in
  4.1; overlapping path sets are refused; stack depth 3 refused.
