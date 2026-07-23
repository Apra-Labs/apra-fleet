# Roadmap

A living list of where apra-pm is headed. See `docs/pm-direction.md` for
the design intent behind these.

## Shipped

- **Per-task model assignment.** The planner assigns each task an exact model
  based on complexity (haiku for mechanical work, sonnet for standard
  development, opus for planning and high-ambiguity tasks). The reviewer
  escalates to at least sonnet regardless of the doer's model.
- **Sprint cost estimation and calibration loop.** The plan-reviewer classifies
  each task into a complexity bucket (S/M/L) and reads the assigned model.
  After plan approval, a pure-JavaScript cost function generates an optimistic /
  expected / pessimistic quote and writes it to beads. At sprint end, actual
  spend is compared against the quote and the calibration file is updated with
  rolling-average actuals so future estimates improve automatically.
- **Durable per-sprint cost logs.** Each sprint writes a JSONL file at
  `sprint-logs/<branch>-<yyyymmdd_hhmmss>.jsonl`. Logs are never deleted and
  never collide across parallel sprints on the same branch.

## Near term

- **Deploy runbook template.** A starter `deploy.md` structure for teams that
  have not yet written one.
- **Bucket calibration from log data.** The calibration loop currently updates
  per-role token averages but not per-bucket (S/M/L) doer estimates. Matching
  log entries back to task assignments would close this gap.
- **Broader e2e coverage.** More scenarios across providers and the OS matrix.

## Open questions

- Whether `design.md` is required for every full sprint or only when complexity
  warrants it.
- The exact command-verb surface and how `recover` reconstructs in-flight state
  from beads + git after a cold start.
- A lightweight way to inspect a running sprint's beads state from outside the
  workflow.
