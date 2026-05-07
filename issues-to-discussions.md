# Issues → Discussions Candidates

Review each item and mark your decision in the **Action** column:
- `discussion` — create a GitHub Discussion and close the issue
- `keep` — leave as a backlog issue
- `close` — not worth tracking (neither issue nor discussion)
- `merge` — merge into another item (note which)

---

## Architecture & Vision

| # | Title | Action | Notes |
|---|---|---|---|
| #189 | Session history, integer resume, and session listing for `execute_prompt` | | Broad vision for a new session subsystem — no implementation spec yet |
| #152 | inter-fleet messaging via per-member named pipes / UDS | | Explicitly tagged "Idea" in body; architectural exploration, no design |
| #179 | Local extension layer — org-private skills, template overrides, safe updates | | Architectural vision for customisation without forking fleet skills |
| #125 | Support multiple LLM providers per member | | Big architectural question; no design agreed |
| #149 | Topic-based status line API — LLM-callable pub/sub with multi-channel routing | | Evolving statusline into an active pub/sub system; vision-stage |

---

## Research

| # | Title | Action | Notes |
|---|---|---|---|
| #56 | Research: leverage CLI agent personas (Explore, Plan, etc.) in `execute_prompt` | | Explicitly "Research"; no actionable output defined |
| #55 | Research: expose 'auto' thinking/model mode for Claude and Gemini | | Explicitly "Research"; depends on provider CLI maturity |
| #75 | inter-session attention mechanism — PM↔member communication across sessions | | Body itself says "works today, no infrastructure needed" — more a pattern doc than a task |
| #90 | Use claude `--auto` permissions mode for Team/Enterprise members | | Research needed; depends on Claude Team/Enterprise CLI behaviour |
| #190 | CODEX session resume and session listing must be researched | | Scoped research — borderline (could stay as issue) |

---

## Self-Improvement & Community

| # | Title | Action | Notes |
|---|---|---|---|
| #107 | Mine `feedback.md` git history to harvest doer mistakes and improve member skills | | Explicitly tagged "Idea"; self-improvement concept with no concrete spec |
| #34 | Groom a prompt library for users to reference | | Content/community initiative — not an engineering backlog item |

---

## PM Lifecycle Vision

These five orbit the same theme: "PM with full product lifecycle awareness beyond verify+approve". Could become one consolidated Discussion or stay as separate issues if broken down concretely.

| # | Title | Action | Notes |
|---|---|---|---|
| #185 | PM: Definition of Done gated by automated deploy + integration phase | | PM philosophy/lifecycle design; no concrete skill changes specified |
| #182 | PM: tier-aware dispatch — read `planned.json`, club same-tier tasks, derive resume | | Concrete enough to be an issue but design not finalised |
| #25 | PM: Deploy to staging and learn from user usage patterns | | Broad PM vision; vague scope |
| #24 | PM: Grade product performance from test results and integration tests | | Vague — no concrete grading mechanism defined |
| #21 | PM: Monitor product logs to detect issues proactively | | Vague concept; no trigger or output spec |

---

## Security Design

| # | Title | Action | Notes |
|---|---|---|---|
| #17 | Security: review prompt injection surface in template-based prompts | | Ongoing design concern rather than a discrete task; no completion criteria |

---

## Other (lower confidence — may be fine as issues)

| # | Title | Action | Notes |
|---|---|---|---|
| #36 | Battery saver mode: graceful degradation when remaining tokens are limited | | Broad concept; no token-sensing mechanism in fleet today |
| #22 | PM: Backlog maintenance — grooming, prioritization, and delivery tracking | | Could be a skill doc improvement rather than an issue |
| #23 | PM /deploy: expand capabilities beyond basic deployment | | Has concrete sub-items; borderline |
