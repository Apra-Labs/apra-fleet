# Requirements -- README.md polish pass

## Background

A fresh critique of README.md (post-#271 overhaul) produced a list of polish
items. This sprint applies the actionable subset. Work continues on the SAME
branch `docs/llms-txt-index` (PR #272) as new commits on top of cb862e9.

IMPORTANT: README.md is embedded in `llms-full.txt`. After editing README.md
you MUST regenerate `llms-full.txt` (`node scripts/gen-llms-full.mjs`) and
commit it, or CI will flag drift.

ASCII only -- the repo pre-commit hook rejects non-ASCII. Use `--`, straight
quotes, no emoji, no em-dashes.

## In scope -- apply all of the following to README.md

### 1. Hero "One conversation" overclaim
The hero heading (line ~8) leads with "One conversation." The rest of the doc
shows the PM running many sub-conversations on the user's behalf. Tighten:
change the lead to "One goal." (or "One prompt.") so the heading reads e.g.
"### One goal. A team of AI agents that plan, build, review each other's
work, and run across every machine you own." Keep the rest of the sentence.

### 2. Replace the "See it in one example" block
Replace the entire current "## See it in one example" code block (the
`You:` / `Fleet:` pseudo-transcript) with a simple, copy-pastable sequence of
natural-language `/pm` commands. The `/pm` skill is an LLM skill and
understands freeform intent -- keep these lines plain and simple. Use exactly
this sequence (adjust surrounding prose lightly for flow):

```
/pm add 2 local members at c:\projects cloned from <git-url> -- a developer and a reviewer -- and pair them
/pm init project_icarus
/pm plan ./feature.md
/pm start the implementation sprint
/pm status
```

Add one short framing line after the block, e.g. "You describe the goal,
approve the plan once, and Fleet runs the doer-reviewer loop to a reviewed
PR." Keep the section short. The mantra is: appear very simple.

### 3. Quick Start verification step
In the Quick start section, after the "register your first members" step,
add a verification line so a first-time user can confirm it worked, e.g.:
   > "Show me fleet status."
plus one line describing what they should see (the registered members listed,
status online/idle). Cheap insurance against a silent-failure first run.

### 4. Mermaid diagram dashes
In the `mermaid` sequence diagram, the loop labels use ` -- ` as parenthetical
separators which render as literal dashes. Replace with a colon:
- "Plan -- revise until the reviewer signs off" -> "Plan: revise until the reviewer signs off"
- "Build -- revise until the review is clean" -> "Build: revise until the review is clean"
(Do NOT use em-dashes -- ASCII hook. Colon only.)

### 6. PM command table -- list ALL commands
The "## The PM skill" command table currently lists only 6 commands. Expand
it to list EVERY `/pm` command. Use `skills/pm/SKILL.md` in this repo (its
"Available Commands" section) as the authoritative source -- read it and
include every command with a concise one-line "Does" description. Do not
ship a curated subset; the table must be complete.

### 7. Explain "Beads"
The PM skill section mentions Beads with no context: "Task state persists
across sessions via **Beads** (`bd` CLI, installed alongside Fleet)". A
reader does not know what Beads is. Add a brief description so it is clear
Beads is the bundled open-source local issue tracker, e.g.:
"...persists across sessions via **Beads**, the bundled open-source issue
tracker (`bd` CLI, installed alongside Fleet)". Keep it short.

### 9. Trim the hero
The hero is three paragraphs plus the blockquote. Cut the SECOND sentence of
the FIRST paragraph (the "Describe a goal -- a Project Manager agent breaks
it down, dispatches the work, pairs a reviewer against every change, and
hands you code that has already passed a second set of eyes." sentence) --
it is shown concretely in the example block below. This tightens the hero
from three paragraphs to two without losing information.

### 12. Wording fix
In the "Watch a real run" paragraph, "fixes loop back" is ambiguous. Change
"fixes loop back" to "findings loop back".

### 13. Product-name casing pass
Sweep README.md for naming consistency: the product is "Apra Fleet" or
"Fleet" (title-cased) in prose; the lowercase `apra-fleet` should appear ONLY
as the CLI command/binary name in code style (backticks or code blocks).
Fix any prose occurrences of lowercase "apra-fleet" that refer to the
product. Do not change code blocks, commands, URLs, or file paths.

### 14. Drop the "Anatomy of a skill" section
The "## Anatomy of a skill" section does not belong in the README -- it is
skill-authoring detail, and `docs/writing-skills.md` already covers it.
Remove the entire "## Anatomy of a skill" section. In its place, append a
single one-line pointer at the BOTTOM of the preceding "## The PM skill"
section, e.g.:
"Want to build your own skill on top of Fleet? See
[how to write a skill](docs/writing-skills.md)."
(README line ~147 in "What you can build on top" also links writing-skills.md
-- that existing link stays; just make sure the new one-liner is not
redundant-looking. One pointer at the end of The PM skill section is enough.)

## Out of scope (do NOT touch)

- Item 5 (provider table / Gemini wording) -- intentionally dropped.
- Item 10 (adding a metric) -- pending a real number from the user.
- Item 11 (substrate vs coding-only framing) -- pending a user decision.
Leave the hero's framing and the provider table as they are otherwise.

## Task -- after edits

1. Run `node scripts/gen-llms-full.mjs` to regenerate `llms-full.txt` (README
   is embedded). Confirm only expected files changed.
2. Run `npm test` and `npm run build` -- both must pass.
3. Confirm no markdown links broke: every link in README still resolves.
4. Commit README.md + regenerated llms-full.txt with an ASCII-only message,
   then `git push origin docs/llms-txt-index`.

## Acceptance criteria

- All in-scope items (1, 2, 3, 4, 6, 7, 9, 12, 13) applied to README.md.
- `llms-full.txt` regenerated and matches generator output (zero diff).
- `npm test` and `npm run build` pass; no broken links; ASCII-only.
- Out-of-scope items untouched.
