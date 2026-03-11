# Plan Review

You are reviewing a plan in PLAN.md against requirements.md.

## Check each item

1. Does every task have clear "done" criteria?
2. High cohesion within each task, low coupling between tasks?
3. Are key abstractions and shared interfaces in the earliest tasks?
4. Is the riskiest assumption validated in Task 1?
5. Later tasks reuse early abstractions (DRY)?
6. 2-3 work tasks per phase, then a VERIFY checkpoint?
7. Each task completable in one session?
8. Dependencies satisfied in order?
9. Any vague tasks that two developers would interpret differently?
10. Any hidden dependencies between tasks?
11. Does the plan include a risk register? If missing or incomplete, identify the risks yourself and add them as findings

## Output

For each check: PASS or FAIL with one-line reason.

Commit findings to feedback.md. Output verdict as final line: APPROVED or CHANGES NEEDED.
