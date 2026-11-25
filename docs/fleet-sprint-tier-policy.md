# fleet-sprint tier policy

A sprint chooses which model tier ('cheap', 'standard' or 'premium') each
dispatch requests. The choice is a launch-time **tier policy**: a preset plus
optional overrides. The default preset is `balanced`.

## Launch fields

`POST /api/sprints` accepts two optional fields (the CLI equivalents are
`--tier-policy` and `--tier-overrides`, see
`packages/apra-fleet-se/docs/cli-reference.md`):

```jsonc
{
  "tierPolicy": "balanced",              // balanced (default) | economy | quality
  "tierOverrides": { "premiumCapPct": 15, "planner": "standard" } // optional, see below
}
```

`tierOverrides` keys:

| Key | Values | Effect |
|---|---|---|
| `planner`, `re-planner`, `plan-reviewer`, `reviewer-round`, `final-review`, `deployer`, `integ-test-runner`, `regression-test-runner`, `harvester`, `streakAssignment` | `cheap` / `standard` / `premium` | Pins that role's tier. A pinned `reviewer-round` applies to every round, with or without premium beads. |
| `doerDefault` | `cheap` / `standard` / `premium` | Tier of a doer dispatch whose beads declare none. Unset in every preset, so the member's default (standard) applies. |
| `doerCeiling` | `cheap` / `standard` / `premium` | Escalation never raises a bead above it (default `premium`). It does not lower a tier the planner declared. |
| `premiumCapPct` | integer 0..100, or `null` | Replaces the preset's premium cap; `null` means no cap. |

An invalid preset, an unknown override key or an invalid value is rejected
with a 400 naming the field.

## Presets

| Preset | Premium cap | Planner | Reviewer round | Escalation |
|---|---|---|---|---|
| `balanced` (default) | 20% of task beads | premium | premium only when the round holds a premium or escalated bead, else standard | on |
| `economy` | 10% of task beads | standard | same rule as balanced | on |
| `quality` | none | premium | always premium | off |

In every preset the plan-reviewer and the final review are premium; the
deployer, integ-test-runner, regression-test-runner and harvester are standard;
the streak-assignment call is cheap; the re-planner runs at the planner's tier.
`quality` reproduces the engine tiers sprints had before tier policies existed.
The planner and plan-reviewer tier rules (`tierReason`, single-tier lanes)
apply under every preset, `quality` included, so `quality` does not restore the
earlier planner tier choices or plan-review behaviour.

The premium cap allows `ceil(premiumCapPct x counted task beads / 100)` premium
task beads. Counted are the in-scope task beads this run plans: open beads and
beads closed during this run. Beads already closed when the run started (for
example an epic relaunched after an upgrade) are not counted. An escalated bead
stays in the total but never counts as premium, so an escalation never triggers
a re-plan. Over the cap the engine runs up to two scoped re-plans, which may
only lower open premium beads, then raises an operator decision before Develop.

## Per-bead tiers and tierReason

The planner records each task's tier in its bead metadata (`model`). A bead the
planner marks premium also carries a `tierReason` naming which hard-bucket
criterion justified it. The criteria themselves are defined in the planner
contract; this page does not repeat them. Lanes are single-tier under
`balanced` and `economy`. A mixed-tier lane is split at its tier boundaries
into consecutive segments in lane order, logged as `[tier-lanes] tier.split`.
The segments run strictly in order, one per Develop round: a later segment
waits until the earlier one is done, so lane order is kept. Test beads ride
the tier of the impl bead before them.

## Escalation

Under `balanced` and `economy` a bead is escalated one tier, at most once per
sprint, when the reviewer reopens it or its verify step fails. The original
tier is kept in the bead metadata `tierEscalatedFrom` and the redo runs one tier
up, never above `doerCeiling`. A bead that cannot rise is logged with
`tier.escalation_at_ceiling`. `quality` never escalates.

## The tier log line and the mismatch WARN

Every dispatch, whatever its role (including doer resumes and streak
assignment), logs one line:

```
[tier] dispatch 7: role=doer member=dev1 beads=b-1,b-2 requested_tier=premium resolved_tier=premium resolved_model=<model> tierReason=b-1:<reason> escalation=b-2 standard->premium
```

`resolved_tier` and `resolved_model` are what `execute_prompt` reports it
actually ran. When the resolved tier differs from the requested tier, or the
result carries no `resolved_tier` although a tier was requested, a WARN line
follows naming the member, the requested and the resolved value:

```
[tier] WARN: dispatch 7 to member 'dev1' requested tier 'premium' but it resolved to 'standard' (requested=premium, resolved=standard).
```

When a member's `model_tiers` has no entry for the requested tier,
`execute_prompt` falls back to its standard, then cheap model, and
`resolved_tier` names the fallback tier that ran, so the WARN fires. An
escalated redo that ran below its escalated tier also logs
`[tier] WARN tier.escalation_unavailable`.

Budget accounting prices a dispatch at its resolved tier. The sprint summary
has a "Tier decisions" section with dispatch counts per requested tier, the
number of escalations, mismatches and unavailable escalations.

## One account, one 5-hour window

This section is documentation only. Every tier on one provider account draws
on the same 5-hour usage window, so a cheaper tier mix (`economy`, or
`balanced` instead of `quality`) makes that window last longer. It does not add
capacity.

## Upgrade notes

fleet-sprint default tier policy is now balanced; launch with tierPolicy:
quality to restore the previous engine tiers (the new planner and plan-reviewer
tier rules apply under every policy).
