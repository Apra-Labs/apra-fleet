# Skill Improvement Review
**Reviewer:** fleet-rev
**Date:** 2026-04-27
**Verdict:** APPROVED

## Item-by-item
| Item | Status | Notes |
|------|--------|-------|
| 1a resume mechanics | PASS | Full section at `skills/fleet/SKILL.md:155-181` — covers boolean semantics, stale-session auto-recovery, provider support matrix (Claude/Gemini/Codex/Copilot), session ID storage. Matches recommended text. |
| 1b stop_prompt stopped-flag | PASS | Documented inline in tool table at `skills/fleet/SKILL.md:38` — describes one-shot error gate, self-clearing behaviour, use-when guidance, and in-memory-only note. Equivalent intent to recommended text with additional detail. |
| 1c unattended modes | PASS | Full section at `skills/fleet/SKILL.md:183-209` — covers `false`/`auto`/`dangerous` modes, per-provider flag table (Claude/Gemini/Codex/Copilot), file-based config mechanism, preference for `auto` over `dangerous`, and compose-before-dispatch rule. |
| 1d monitor_task description | PASS | Fixed at `skills/fleet/SKILL.md:24` — now reads "any member" with cloud-only features noted. Matches recommended replacement. |
| 1e concurrent dispatch guard | PASS | Documented at `skills/fleet/SKILL.md:102-108` — covers server-side enforcement, error message, and `stop_prompt` recovery. Matches recommended text. |
| 1f credential scoping/TTL/rescoping/wildcard | PASS | Documented at `skills/fleet/SKILL.md:67-76` — covers `members="*"` default, comma-separated scoping, resolve-time enforcement, TTL with clear error on expiry. Additionally, a `credential_store_update` tool now exists (line 37), addressing the known gap from the feedback — metadata updates no longer require OOB re-entry. |
| 1g network egress policy | PASS | Documented at `skills/fleet/SKILL.md:78-85` — covers `allow`/`deny`/`confirm` policies with behaviour table. Matches recommended text. |
| 2a inactivity vs total timeout | PASS | Two distinct rows at `skills/fleet/troubleshooting.md:6-7` — inactivity timeout correctly described as transport-level (not provider-specific), common causes listed, fix guidance provided. Total timeout row added with provider-agnostic semantics. Matches recommended replacement. |
| 3a resume decision table | PASS | Two new rows at `skills/pm/doer-reviewer.md:65-66` — "After `stop_prompt` cancellation → `false`" and "After session timed out mid-grant → `true`" with rationale. Matches recommended additions. |
| 3b stop_prompt orchestration guidance | PASS | New paragraph at `skills/pm/doer-reviewer.md:100-107` — covers when to cancel, one-shot gate behaviour, `resume=false` follow-up, and distinction between fleet `stop_prompt` and harness-level sub-task stopping. Equivalent intent to recommended text. |
| 3c compose_permissions + unattended guidance | PASS | Added to setup checklist at `skills/pm/doer-reviewer.md:9-11` — covers compose-before-dispatch rule, reference to fleet SKILL.md for provider details, and `auto` over `dangerous` preference. Equivalent intent to recommended text, placed in setup checklist rather than pre-flight (reasonable placement choice). |
| 3d permission denial + inactivity timeout | PASS | Amended at `skills/pm/doer-reviewer.md:94-98` — adds inactivity timer warning (transport-level, all providers), urgency to act on grants, and stale-session recovery caveat. Matches recommended amendment. |

## Summary
All 12 items (1a–3d) pass. Every recommended addition or fix from the skill improvement feedback is present in the current state of the three reviewed files with equivalent or better content than what was recommended. Notable enhancement beyond the feedback: a `credential_store_update` tool (1f) was implemented, resolving the high-friction gap identified in the feedback. No changes needed.
