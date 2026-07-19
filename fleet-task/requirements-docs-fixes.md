# Requirements -- docs accuracy fixes (PR #272 follow-up)

Continue on branch `docs/llms-txt-index` (PR #272), HEAD 14b13c9. New commits
on top. ASCII only (pre-commit hook). After editing any doc embedded in
`llms.txt` (README.md, docs/provider-guide.md), regenerate `llms-full.txt`
with `node scripts/gen-llms-full.mjs` and commit it.

## Fix 1 -- Remove two factually wrong claims about Gemini

Two claims are FALSE and must be removed from BOTH `docs/provider-guide.md`
and `docs/provider-matrix.md`:

(a) "Gemini silently truncates large outputs" -- this is not true. Remove it.
(b) "OAuth credential copy is Claude-to-Claude only" / "Gemini OAuth is not
    copyable" -- false; Gemini uses the same copyable OAuth flow as Claude.

### In `docs/provider-guide.md`
- Delete the gotcha bullet "**Gemini can silently truncate large outputs.**
  If a task produces very large responses, split it into smaller units."
- Delete the gotcha bullet "**OAuth credential copy is Claude-to-Claude
  only.** For other providers, supply an API key ...".
- In the "Provider strengths" list, the Claude bullet ends with "; OAuth
  credentials are copyable across members." -- drop that clause, since
  copyable OAuth is not Claude-exclusive. Keep the rest of the Claude bullet.

### In `docs/provider-matrix.md`
- In the "Strategic Comparison" table, the "OAuth / login" row: the Gemini
  cell reads "Google OAuth (browser-based, not copyable)". Remove the
  ", not copyable" -- it is wrong. (e.g. "Google OAuth (browser-based)").
- In the "Critical Gaps & Mitigations" table:
  - Delete the entire "Gemini output truncation" row (the ~8K truncation
    claim) -- it is false.
  - The "OAuth credential copy doesn't work" row lists "Gemini, Codex,
    Copilot". Remove Gemini from it -- Gemini's OAuth copy works like
    Claude's. Keep the row for Codex/Copilot if still accurate for them, and
    adjust the Impact / Mitigation wording so it no longer implies Gemini is
    affected. If after removing Gemini the row no longer says anything true,
    delete the whole row.

Do not invent new claims. Only remove/correct the false statements above.

## Fix 2 -- Reorder the README Documentation table

The "## Documentation" table in README.md is ordered poorly. Reorder the rows
so the most-reached-for docs are at the top. Use exactly this order (keep the
existing link targets and the Topic wording, just reorder the rows):

1. Install, uninstall, the `--llm` flag -- docs/install.md
2. Choosing a provider -- docs/provider-guide.md
3. FAQ -- docs/FAQ.md
4. Troubleshooting -- docs/troubleshooting.md
5. Keeping Fleet updated (`apra-fleet update`) -- docs/features/update.md
6. Secure credentials and passwords -- docs/features/oob-auth.md
7. Enabling SSH on a remote machine (if it does not have it yet) -- docs/ssh-setup.md
8. Git authentication -- docs/design-git-auth.md
9. Cloud compute -- docs/cloud-compute.md
10. Architecture -- docs/architecture.md

## Fix 3 -- Proper model name in the README fleet example

In README.md, the "Mix providers in one fleet" section has an example fleet
code block:

```
pm-1      Opus 4.7     orchestrator
doer-1    Sonnet 4.6   feature work
doer-2    Gemini       large-context tasks
reviewer  Opus 4.7     final review
```

The `doer-2` row just says "Gemini" -- a bare provider name where the other
rows use proper model names (Opus 4.7, Sonnet 4.6). Change "Gemini" to a
proper model name in the same friendly style -- use **"Gemini 3 Pro"** (the
flagship, appropriate for the large-context-tasks role). Keep column
alignment tidy.

## Fix 4 -- Add a Beads doc and link it from README

README.md mentions "Beads" twice (the description near `bd ready`, and the
`/pm backlog` command-table row) but there is no doc explaining how Fleet
uses Beads.

- Create a new doc `docs/beads.md` describing how Fleet uses Beads: what
  Beads is (a bundled open-source local issue tracker, `bd` CLI, installed
  by `apra-fleet install`), and how the PM skill uses it -- persistent task
  DB across sprints, epics/tasks/dependencies, lifecycle hooks, and the
  common commands (`bd ready`, `bd create`, `bd close`, etc.). Draw accurate
  content from this repo's `skills/pm/beads.md` and `skills/pm/SKILL.md` --
  do not invent behavior. Keep it a focused reference page. Add the standard
  `<!-- llm-context -->` / `keywords` / `see-also` header comment like other
  docs. ASCII only.
- In README.md, link the FIRST "Beads" mention (the description line) to
  `docs/beads.md`. The `/pm backlog` table row may also link it, but one
  primary link is enough -- avoid two links on the same word in close
  proximity.
- Because README now references `docs/beads.md`, add it to `llms.txt` (this
  is the single-source-of-truth index) in a sensible group -- it becomes the
  17th doc. Then update `tests/gen-llms-full.test.ts`: the expected localDocs
  array (and any count of 16) must become 17 with `docs/beads.md` in the
  position matching its place in `llms.txt`.

## Fix 5 -- Remove the docs/api folder

`docs/api/` contains two files (`execute-prompt.md`, `stop-prompt.md`) judged
not useful. Delete the entire `docs/api/` folder (`git rm`).
- `docs/research-thinking-and-personas.md` references `docs/api` -- update it
  so it no longer links to the removed files (remove the link or the
  sentence containing it, whichever keeps the surrounding text coherent).
- Confirm nothing else links into `docs/api/`.

## Fix 6 -- Remove stray review-e2e-first-run.md

`review-e2e-first-run.md` is a stray file at the repo ROOT (not under docs/).
Delete it (`git rm review-e2e-first-run.md`). First confirm nothing links to
it; if anything does, remove that link too. Do NOT remove any other
root-level file (badges.md, deploy.md, etc. stay).

## Task -- after edits

1. Regenerate `llms-full.txt` (`node scripts/gen-llms-full.mjs`).
2. Run `npm test` and `npm run build` -- both must pass.
3. Confirm no markdown links broke.
4. Commit the changed docs + regenerated `llms-full.txt` with an ASCII-only
   message, then `git push origin docs/llms-txt-index`.

## Acceptance criteria

- The two false Gemini claims are gone from provider-guide.md AND
  provider-matrix.md; no other content in those docs changed.
- README Documentation table is in the order above.
- README fleet example uses "Gemini 3 Pro" for doer-2.
- `llms-full.txt` regenerated (zero diff vs generator); npm test + build pass;
  no broken links; ASCII only.
