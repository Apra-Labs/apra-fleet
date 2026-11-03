# D1b - Weekend kit: notifier, launch list, breaker, baseline

Usage: `--requirements-file docs/director/sprints/D1b-weekend-kit.md`
Branch: `feat/v05-d1b-weekend-kit` off `v0.5_dashboard`. Wave 5, lane A.
Specs: `03-events-and-playbooks.md` P13, `04-gates-and-digest.md` section 3
(transport split). Depends on D1a.

## Goal

The operator learns of every sprint end within 2 minutes, and the next
operator-chosen sprint starts without them unless failures repeat. No LLM.

## Requirements

R1. Notifier module `src/director/modules/notify.mjs`: subscribes to
`run.finished`, `run.crashed`, `run.launch_failed`, `breaker.tripped`; sends one
email per event through the fleet client's `sendEmail` (the `send_email` MCP
tool; no new SMTP code). Transport config in `supervisor.config.json`
`notify: {provider, from, to, smtp?: {host, port, user, secure}, quietHours?}`;
secrets only from the credential store (`sendgrid_api_key` / `smtp_password`).
Subject `[fleet] <project> <sprintId> <verdict|reason>`; body: verdict, reason
and class, PR link, branch, members, cost, duration, remedy line for failures.
No token, secret or cookie value ever appears. Quiet hours delay non-urgent
mail (urgent: crashed, launch_failed, breaker). Missing or invalid config: log
once per start, never throw. Expose `notify(message, {urgent})` for later
modules.

R2. Launch list module `src/director/modules/launch-list.mjs`:
`supervisor.config.json` key `launchList` (ordered launch bodies, exactly the
`POST /api/sprints` body shape) and routes `GET/PUT /api/launch-list` behind the
existing auth guard. On `run.finished` and on each watchdog tick: take the
FIRST entry whose members are all free (fleet-server `reservedBy` empty and not
in this ledger) and whose roots do not overlap a live sprint; launch it through
the sprint controller's `launch()`; on success remove it; on 4xx move it to
`launchListRejected` with the error and notify. At most one launch per tick.
Code never reorders entries.

R3. Breaker: consecutive non-PASS outcomes of list-launched sprints; threshold
from `policy.backpressure.breaker_consecutive_failures` when the D2a policy
loader is present, else `supervisor.config.json breaker.consecutiveFailures`
(default 3). Tripped: stop consuming, urgent notify, expose
`breaker: {tripped, since, runs[]}`; reset by a PASS or
`POST /api/launch-list/reset-breaker`. One breaker implementation, reused by
D2b.

R4. `scripts/fleet-baseline.mjs` (apra-fleet-se): read-only report from a data
dir's ledger/history: reserved minutes per member per day for 14 days; median
gap between a terminal event and the next launch per lane; dogfood
sprint-hours per build version when run against a dogfood instance's data dir.

## Acceptance

- Notifier: one email per event (stub client); subject format; scan of the body
  for the configured secret finds nothing; quiet-hours delay; urgent bypass;
  invalid config does not throw.
- Launch list: order kept; an entry blocked by a member reserved elsewhere is
  skipped and the next eligible entry launches; 4xx moves to rejected; one
  launch per tick.
- Breaker trips at threshold, stops launches, PASS resets, threshold read from
  policy when present.
- Baseline script: golden output for fixture ledger/history files.

Estimate 8 h. Tier: standard.
