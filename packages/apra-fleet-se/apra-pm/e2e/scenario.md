# pm e2e -- sprint on the toy

Use the **pm** skill to run one sprint. Inputs the skill needs:

- **Repo:** already cloned at `{{REPO}}` (base `main`, remote `origin` -> the toy).
- **Branch:** `{{BRANCH}}`.
- **Requirement:** implement these three P1 issues: `gh-toy-mi2` (CLI CRUD commands), `gh-toy-7rp` (help system and input validation), `gh-toy-4ef` (add --version flag to CLI).

Run the pm commands in order: **plan** (with those 3 issues as the requirement), **start**, **cleanup**.

**Do not stop until ALL of the following are true:**
- A commit whose message starts with `plan:` exists in the branch history (written by the pm skill during the plan phase).
- `requirements.md` and `feedback.md` do NOT appear in `git diff main...{{BRANCH}} --name-only`.
- `.beads/issues.jsonl` on the branch reflects gh-toy-mi2, gh-toy-7rp, and gh-toy-4ef as closed.
- A pull request exists for branch `{{BRANCH}}` targeting `main`.
- `docs/` or `CHANGELOG.md` appears in `git diff main...{{BRANCH}} --name-only` (harvester ran).
