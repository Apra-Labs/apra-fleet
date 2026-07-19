# Requirements -- llms.txt as the single source of truth for llms-full.txt

## Background

The apra-fleet repo publishes two LLM-discovery files at the repo root
(llmstxt.org convention):

- `llms.txt` -- a short index of the project for LLMs/bots.
- `llms-full.txt` -- the concatenated full text of the indexed docs, generated
  by `scripts/gen-llms-full.mjs`.

Today `gen-llms-full.mjs` embeds a **hardcoded list of 5 docs**. `llms.txt`
itself only lists those same 5. Every time a doc is added or renamed, the
script must be hand-edited. We want `llms.txt` to be the single source of
truth: the script scrapes `llms.txt` for its links and builds `llms-full.txt`
from whatever it finds, in the order it finds them.

CI note: `.github/workflows/ci.yml` job `update-llms-full` runs
`node scripts/gen-llms-full.mjs` on every PR and auto-commits the result. The
script must therefore run cleanly on Linux/Node with no external dependencies.

## Task 1 -- Rewrite `llms.txt` as a complete textual index

Rewrite the repo-root `llms.txt` so it is a genuine, self-contained index of
the project that any LLM/bot can read, following the llmstxt.org structure:

1. `# Apra Fleet` H1, then a one-line `>` blockquote summary.
2. A short prose paragraph (2-4 sentences) describing what Apra Fleet is --
   distilled from README.md.
3. One or more `##` sections containing markdown link lists. Each link line:
   `- [Title](relative/path.md): one-line description.`
4. Include **every important local doc referenced by README.md** so the index
   reflects the README. The required set, in this exact order (this order is
   the order they will appear in `llms-full.txt` -- see Task 2):

   1. `README.md` -- project overview and day-to-day usage
   2. `docs/vocabulary.md` -- shared terminology
   3. `docs/architecture.md` -- how hub, MCP server, and members interact
   4. `docs/install.md` -- install, uninstall, the `--llm`/`--skill` flags
   5. `docs/features/update.md` -- keeping Fleet updated
   6. `docs/ssh-setup.md` -- enabling SSH on a remote machine
   7. `docs/features/oob-auth.md` -- secure credentials and passwords
   8. `docs/design-git-auth.md` -- git authentication
   9. `docs/provider-matrix.md` -- supported LLM providers and capabilities
   10. `docs/cloud-compute.md` -- AWS/cloud compute integration
   11. `docs/writing-skills.md` -- how to write your own skill
   12. `skills/pm/SKILL.md` -- the PM (Project Manager) skill reference
   13. `docs/FAQ.md` -- frequently asked questions
   14. `docs/troubleshooting.md` -- common symptoms and fixes
   15. `ROADMAP.md` -- what is planned next
   16. `CONTRIBUTING.md` -- how to contribute

   Group them under sensible `##` headings (e.g. Overview, Setup, Features,
   Usage, Help, Project) but keep the **overall top-to-bottom order above**.
5. Add a final `## Optional` (or `## Community`) section with the external
   links from README's Community section (GitHub Discussions, Releases,
   Issues). These are full `https://` URLs -- they are for bots reading
   `llms.txt`; the generator (Task 2) must skip them automatically because
   they are not local files.

Constraints:
- ASCII only -- the repo has a pre-commit hook rejecting non-ASCII. Use `--`
  instead of em-dashes, straight quotes, no emoji. (The current `llms.txt`
  uses em-dashes; the rewrite must not.)
- Every local-path link must point to a file that actually exists in the repo.

## Task 2 -- Make `gen-llms-full.mjs` scrape `llms.txt`

Replace the hardcoded `docs` array in `scripts/gen-llms-full.mjs` with logic
that derives the doc list from `llms.txt`:

1. Read `llms.txt` from the repo root.
2. Parse every markdown link in list items: `[Title](url)` plus the trailing
   `: description` text if present.
3. For each link, strip any `#anchor` fragment, resolve the path relative to
   the repo root.
4. **Keep a link only if** it has no URL scheme (reject `http://`, `https://`,
   `mailto:` etc.) AND the resolved file exists on disk. Skip everything else
   silently (this is how external/Optional links are excluded).
5. De-duplicate by resolved path -- keep the first occurrence.
6. Build `llms-full.txt` from the surviving docs **in order of appearance in
   `llms.txt`**. Order matters: the generated file must read top-to-bottom in
   the same order the links appear in `llms.txt`.
7. Keep the existing `<project>` / `<docs>` / `<doc title= desc=>` XML
   wrapping and `escapeXml` behavior. Use the parsed Title and description as
   the `title` and `desc` attributes. If a link has no description, fall back
   to an empty string or the Title.
8. Nice-to-have: derive the `<project>` `title` and `summary` attributes from
   the `# H1` and `>` blockquote at the top of `llms.txt` instead of
   hardcoding them. If this is awkward, leaving them hardcoded is acceptable.
9. Keep the script dependency-free (Node built-ins only) and update its
   header comment to describe the new behavior.
10. The script must fail loudly (non-zero exit) only if `llms.txt` itself is
    missing or contains zero usable local links -- not for skipped external
    links.

## Task 3 -- Test and verify

1. Run `node scripts/gen-llms-full.mjs` and confirm it exits 0.
2. Confirm `llms-full.txt` contains all 16 docs from Task 1, wrapped in
   `<doc>` elements, in the exact order listed.
3. Confirm external/Optional links did NOT get embedded.
4. Run the generator twice and confirm the output is identical (idempotent).
5. Run `npm test` and `npm run build` to confirm nothing else broke.
6. If reasonably low-effort, add a small `vitest` test under `tests/` that
   runs the generator (or its parsing function) and asserts the embedded doc
   list matches the local links in `llms.txt`. If it requires refactoring the
   script for testability beyond a light touch, skip it and note why.

## Acceptance criteria

- `llms.txt` is a complete, ASCII-only, llmstxt.org-style index covering all
  16 local docs plus external community links.
- `gen-llms-full.mjs` no longer contains a hardcoded doc list; it scrapes
  `llms.txt`.
- `llms-full.txt` is regenerated, contains the 16 docs in the specified
  order, and excludes external links.
- `npm test` and `npm run build` pass.
- All commits are ASCII-only and the pre-commit hook passes.
