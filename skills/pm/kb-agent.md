# KB Agent Dispatch

The KB Agent runs automatically after every reviewer verdict. It is not a user-invocable
command -- PM dispatches it as part of the VERIFY phase, after the reviewer finishes.

---

## When to Dispatch

After the reviewer returns feedback.md (APPROVED or CHANGES NEEDED), and BEFORE closing
the VERIFY task in Beads:

```
Reviewer finishes -> PM reads verdict -> dispatch KB Agent -> read KB Agent report -> close VERIFY task
```

Do not skip the KB Agent even on CHANGES NEEDED. Learnings from a session where code
needed fixing are still valid -- the KB Agent will assign lower confidence (INFERRED
instead of CONFIRMED) to reflect that the code was not yet approved.

---

## Which Member Runs It

**Fleet mode:** Use the doer member. It already has the project repo checked out at the
correct branch. Send the KB agent context file (tpl-kb-agent.md, filled) as CLAUDE.md
before dispatching. Do not use resume=true -- always a fresh session.

**Local mode:** Dispatch as an inline subagent. Include the full tpl-kb-agent.md content
in the prompt, plus the inputs listed below.

Model tier: cheap or standard. KB evaluation does not require premium reasoning.

---

## What to Send

Fill `tpl-kb-agent.md` with:
- `{{PROJECT_NAME}}`: project name
- `{{sprint_name}}`: current sprint identifier
- `{{base_branch}}`: e.g. main
- `{{branch}}`: feature branch name

Include in the dispatch prompt:

```
1. Reviewer verdict: APPROVED | CHANGES NEEDED
2. Reviewer feedback.md content (full text)
3. Doer session output summary (or the last N lines of session output if full text is available)
4. Git diff summary: files and symbols changed (git diff {{base_branch}}..{{branch}} --stat)
5. Sprint context: PLAN.md task list (titles only, not full details)
```

If the doer session transcript is not available (execute_prompt output was not captured),
the KB Agent can still operate: it will use the diff, the reviewer verdict, and the
existing KB state. Its output will be lower quality but still valid.

---

## APPROVED vs CHANGES NEEDED

| Verdict | Effect on KB Agent |
|---|---|
| APPROVED | KB Agent may set confidence=CONFIRMED for entries describing approved code. Promotes existing INFERRED entries touching approved symbols. |
| CHANGES NEEDED | KB Agent uses INFERRED at most. Captures learnings that are independent of the broken code (architectural insights, file summaries, non-obvious constraints). Does NOT promote to CONFIRMED. |

Tell the KB Agent the verdict explicitly in the prompt. It uses this to make confidence decisions.

---

## Reading the KB Agent Report

The KB Agent reports inline (does not commit files). After it finishes, read the report
and record the key numbers in status.md:

```
KB Agent ({{sprint_name}}): N captured, M promoted, K updated, J contradictions resolved
```

If the report lists gaps ("Symbols worth indexing in a future sprint"), add them to the
project backlog as low-priority Beads tasks for a future KB sprint.

---

## Beads lifecycle

KB Agent dispatch is part of the VERIFY task:
- VERIFY task moves to in_progress when reviewer is dispatched
- VERIFY task closes only AFTER KB Agent completes and report is read
- If KB Agent fails (tool errors, timeout), close VERIFY anyway but note failure in status.md

---

## Example PM dispatch sequence (fleet mode)

```
# 1. Reviewer finishes -- read verdict
receive_files <- reviewer: feedback.md
verdict = read feedback.md -> APPROVED | CHANGES NEEDED

# 2. Fill KB agent context file
<fill tpl-kb-agent.md with sprint values>

# 3. Send context file to doer member
send_files -> doer: CLAUDE.md (filled tpl-kb-agent.md)

# 4. Dispatch KB Agent (in background Agent)
execute_prompt(
  member=doer,
  model=cheap,
  resume=false,
  prompt="""
  Verdict: {{verdict}}
  Reviewer feedback: {{feedback_md_content}}
  Session summary: {{doer_session_summary}}
  Diff stat: {{git_diff_stat}}
  Sprint tasks: {{plan_task_titles}}
  Run the KB Agent process as defined in your CLAUDE.md.
  """
)

# 5. Read report, record in status.md
# 6. Close VERIFY task in Beads
```

---

## Frequency

Every VERIFY checkpoint gets a KB Agent run. If a sprint has 2 VERIFY checkpoints,
the KB Agent runs twice -- once after each. The second run benefits from the first run's
captures and can build on them (promoting entries that were UNVERIFIED after phase 1
to INFERRED after phase 2, and CONFIRMED after final APPROVED verdict).
