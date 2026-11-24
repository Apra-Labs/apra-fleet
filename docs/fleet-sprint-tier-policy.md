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
  "tierOverrides": { "premiumCapPct": 15 } // optional; the only key is premiumCapPct (integer 0..100, or null for no cap)
}
```

An invalid preset or override key is rejected with a 400 naming the field.

## Presets

| Preset | Premium cap | Planner | Reviewer round | Escalation |
|---|---|---|---|---|
| `balanced` (default) | 20% of task beads | premium | premium only when the round holds a premium or escalated bead, else standard | on |
| `economy` | 10% of task beads | standard | same rule as balanced | on |
| `quality` | none | premium | always premium | off |

In every preset the plan-reviewer and the final review are premium; the
deployer, integ-test-runner, regression-test-runner and harvester are standard;
the streak-assignment call is cheap. `quality` reproduces the behaviour
sprints had before tier policies existed.

`tierOverrides.premiumCapPct` replaces the preset's cap. The cap allows
`ceil(premiumCapPct x counted task beads / 100)` premium task beads. Over the
cap the engine runs up to two scoped re-plans, then raises an operator
decision before Develop. Escalated beads are excluded from the counted total
as well as from the premium count, so an escalation alone can shrink the
allowance and push a previously compliant plan over the cap (a known quirk).

## Per-bead tiers and tierReason

The planner records each task's tier in its bead metadata (`model`). A bead the
planner marks premium also carries a `tierReason` naming which hard-bucket
criterion justified it. The criteria themselves are defined in the planner
contract; this page does not repeat them. Lanes are single-tier under
`balanced` and `economy`: a mixed-tier lane is split into one dispatch per
tier, and test beads ride the tier of the impl bead they cover.

## Escalation

Under `balanced` and `economy` a bead is escalated one tier, at most once per
sprint, when the reviewer reopens it or its verify step fails. The original
tier is kept in the bead metadata `tierEscalatedFrom` and the redo runs one tier
up. `quality` never escalates.

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

Known limitation: `resolved_tier` currently echoes the requested tier keyword
rather than being derived from the model actually chosen. When a member's
`model_tiers` has no entry for the requested tier, model resolution falls back
to the standard or cheap model, yet `resolved_tier` still reports the requested
tier, so the WARN above cannot fire for that fallback. Only `resolved_model`
shows the downgrade, and budget accounting prices the dispatch at the requested
tier. Check `resolved_model` in the log line when a member may lack a premium
model.

Budget accounting prices a dispatch at its resolved tier when one is reported. The sprint summary has a "Tier
decisions" section with dispatch counts per requested tier, the number of
escalations and the number of mismatches.

## One account, one 5-hour window

This section is documentation only. Every tier on one provider account draws
on the same 5-hour usage window, so a cheaper tier mix (`economy`, or
`balanced` instead of `quality`) makes that window last longer. It does not add
capacity.

## Upgrade notes

fleet-sprint default tier policy is now balanced; launch with tierPolicy:
quality to restore the previous behaviour.
