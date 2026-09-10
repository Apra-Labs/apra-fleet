# Roadmap

A living list of where apra-pm is headed. See `docs/pm-direction.md` for
the design intent behind these.

## Shipped

- **Per-task model assignment.** The planner assigns each task a model tier
  based on complexity (`cheap` for mechanical work, `standard` for standard
  development, `premium` for planning and high-ambiguity tasks). The reviewer
  escalates to at least `standard` regardless of the doer's tier.
- **Sprint cost estimation and calibration loop.** The plan-reviewer classifies
  each task into a complexity bucket (S/M/L) and reads the assigned model.
  After plan approval, a pure-JavaScript cost function generates an optimistic /
  expected / pessimistic quote and writes it to beads. At sprint end, actual
  spend is compared against the quote and the calibration file is updated with
  rolling-average actuals so future estimates improve automatically.
- **Durable per-sprint cost logs.** Each sprint writes a JSONL file at
  `sprint-logs/<branch>-<yyyymmdd_hhmmss>.jsonl`. Logs are never deleted and
  never collide across parallel sprints on the same branch.
- **Bucket calibration from log data.** `accumulateBucketTokens` joins doer log
  entries back to their S/M/L buckets, so the calibration loop updates
  `historical.bucket_avg_tokens` alongside the per-role token averages.

## Near term

- **Deploy runbook template.** A starter `deploy.md` structure for teams that
  have not yet written one.
- **Parallel doers by default.** Worktree fan-out exists but ships opt-in
  (`parallelism.max_doers` defaults to 1) until cross-platform worktree handling
  is hardened. See `docs/auto-sprint-parallel-doers.md`.
- **Broader e2e coverage.** More scenarios across providers.

## Open questions

- Whether `design.md` is required for every full sprint or only when complexity
  warrants it.
- The exact command-verb surface and how `recover` reconstructs in-flight state
  from beads + git after a cold start.
- A lightweight way to inspect a running sprint's beads state from outside the
  workflow.
