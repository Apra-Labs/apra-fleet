<!-- llm-context: Deep-dive on how Fleet keeps multi-agent token spend down -- model-tier routing, shell-over-prompts, smart sessions, and how token usage is measured per member/role. Migrated out of README.md on 2026-07-24 to keep the README landing page short; content unchanged. -->
<!-- keywords: cost, tokens, model tier, cheap, standard, premium, execute_command, smart sessions, token usage, spend -->
<!-- see-also: ../README.md (quickstart), FAQ.md (cost FAQ discussion), install.md (customizing model tier mapping) -->

# Cost

Multi-agent tooling raises one question first: does coordinating several agents
burn more tokens? In practice Fleet works to keep usage down -- and the core
idea is the one Fleet was built on: **match the model to the task.**

A plan is a list of tasks of widely varying difficulty. Running every one of
them on a single premium model is the waste. Instead, Fleet assigns each task a
model tier commensurate with its complexity:

- **cheap** -- boilerplate, status checks, running tests, deploys
- **standard** -- routine feature work, code, configuration
- **premium** -- planning, review, hard architectural reasoning

Only the work that genuinely needs a frontier model gets one; everything else
runs on a lighter, cheaper tier. Two more mechanisms compound the savings:

- **Shell over prompts** -- routine steps run through `execute_command` as plain
  shell commands, which cost zero LLM tokens.
- **Smart sessions** -- Fleet decides whether to resume an existing session
  (reusing cached context) or start fresh, rather than re-sending history.

**Token spend is measured, not estimated.** Fleet records token usage per
member and per role -- PM, doer, reviewer -- so a team can see and analyze
where their spend actually goes. Fleet's end-to-end CI suite exercises this
in full: a complete reviewed sprint -- discover issues, plan, doer-reviewer
loop, PR raised with green CI -- emits a per-role token breakdown (in one
such run: PM ~6K, doer ~191K, reviewer ~19K, ~215K total). Those toy-repo
figures are not a benchmark -- they show the measurement method works end
to end. The point is the instrument: Fleet makes token cost something you
can attribute and reason about, not guess at.

Setup is a one-time cost; the recurring cost is the work itself. See the
[FAQ](FAQ.md) for the full breakdown.
