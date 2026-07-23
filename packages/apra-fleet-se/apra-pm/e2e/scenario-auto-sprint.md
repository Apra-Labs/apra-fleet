# e2e -- auto-sprint on the toy

Use the /auto-sprint dynamic workflow to run one sprint.

- **Repo:** already cloned at `{{REPO}}` (base `main`, remote `origin` -> the toy).
- **Branch:** `{{BRANCH}}`.
- **Sprint goals:** gh-toy-mi2, gh-toy-7rp, gh-toy-4ef

Check out `{{BRANCH}}` in the repo.

First, invoke the `auto-sprint-args` skill (use the Skill tool) to confirm the exact
argument shape the /auto-sprint workflow expects. Then, following that contract, invoke
the /auto-sprint workflow with issues `["gh-toy-mi2", "gh-toy-7rp", "gh-toy-4ef"]`,
branch `{{BRANCH}}`, goal `P1`, base_branch `main`, and `skip_dolt_push` set to `true`
(passed as a JSON object, not a string). The `skip_dolt_push: true` flag is REQUIRED here
so the e2e never pushes beads state to a real Dolt remote on GitHub. Wait for the workflow
to complete.
