# Requirements -- docs/provider-guide.md (user-facing provider callout)

## Background

`docs/provider-matrix.md` mixes two concerns. Its content -- CLI flag matrices,
per-OS install commands, credential file paths, NDJSON parsing internals,
session-id minting, mitigations baked into Fleet's provider abstraction -- is an
**engineering reference for developers extending Fleet's provider support**. It
is NOT useful to a person who just uses Fleet.

Yet user-facing surfaces (README, FAQ, llms.txt) link to it as if it were user
documentation. We are separating the two concerns.

Decision: do NOT rename or change `docs/provider-matrix.md`. Instead, add a
small new user-facing doc and repoint only the user-facing links to it.

## Task 1 -- Create `docs/provider-guide.md`

Create a NEW, short (roughly one screen) user-facing doc at
`docs/provider-guide.md`. Audience: someone setting up a fleet who needs to
choose a provider per role. Structure:

1. An HTML `<!-- llm-context: ... -->` comment header (and `keywords` /
   `see-also` lines) matching the style of other docs (see the top of
   `docs/provider-matrix.md` and `docs/cloud-compute.md` for the pattern).
2. `# Choosing an LLM Provider` H1 (or similar), then a 1-2 sentence intro:
   Fleet supports Claude, Gemini, Codex, and Copilot, and members can mix
   providers freely within one fleet.
3. A short "provider strengths" section -- one line per provider on what it is
   good at (e.g. Claude: balanced, fine-grained permissions; Gemini: 1M-token
   context + native web search; Codex: structured-output enforcement +
   subagents; Copilot: multi-model marketplace, auto-compaction).
4. A "recommended provider by role" table for PM / doer / reviewer. Reuse the
   table currently in README.md's "Mix providers in one fleet" section
   (PM, Doer, Reviewer rows) -- this doc becomes its natural home.
5. A "gotchas worth knowing" section listing ONLY user-visible limitations,
   plain-language, no Fleet-internal detail:
   - `max_turns` only works on Claude; on other providers use `timeout_s`.
   - Gemini can silently truncate very large outputs -- split big tasks.
   - Copilot needs a paid GitHub Copilot subscription and has the smallest
     context window -- best for smaller, focused tasks.
   - OAuth credential copy works Claude-to-Claude only; other providers need
     an API key or interactive login on the member.
6. A short closing pointer: "Extending Fleet's provider support, or need the
   full CLI / integration detail? See [docs/provider-matrix.md]."

Keep it concise -- this is a callout, not a reference. Pull facts from the
existing `docs/provider-matrix.md`; do not invent new claims. ASCII only.

## Task 2 -- Repoint user-facing links; leave dev links alone

Change ONLY the user-facing references to point at the new
`docs/provider-guide.md`. Do NOT touch `docs/provider-matrix.md` itself.

Repoint these (user-facing):
- `README.md` -- the "Mix providers in one fleet" section callout (currently
  "Full capability comparison and provider gotchas:
  [docs/provider-matrix.md]"). Reword the lead-in so it points at the guide,
  e.g. "Provider strengths, role recommendations, and gotchas:
  [docs/provider-guide.md]."
- `README.md` -- the Documentation table row currently
  "| Provider matrix | [docs/provider-matrix.md] |" -> relabel to
  "| Choosing a provider | [docs/provider-guide.md] |".
- `docs/FAQ.md` -- the `<!-- see-also ... -->` comment entry for
  `provider-matrix.md` -> `provider-guide.md (choosing a provider)`.
- `docs/FAQ.md` -- the "Related docs:" footer link `[Provider Matrix]
  (provider-matrix.md)` -> `[Provider Guide](provider-guide.md)`.
- `llms.txt` -- the line currently
  `- [Provider Matrix](docs/provider-matrix.md): ...` -> replace with
  `- [Provider Guide](docs/provider-guide.md): <one-line description>`.
  It keeps the SAME position in the list (index/order unchanged) so the
  16-doc ordering is preserved.

Leave UNCHANGED (dev-facing -- must keep pointing at provider-matrix.md):
- `docs/architecture.md` -- "See `docs/provider-matrix.md` for the full
  comparison table." stays as-is.
- `docs/provider-matrix.md` -- not modified at all.

Then:
- Update `tests/gen-llms-full.test.ts` -- the expected localDocs array has
  `'docs/provider-matrix.md'`; change that one entry to
  `'docs/provider-guide.md'` (same position).
- Regenerate `llms-full.txt`: run `node scripts/gen-llms-full.mjs`.

## Task 3 -- Verify

1. `node scripts/gen-llms-full.mjs` exits 0; `llms-full.txt` now contains
   `provider-guide.md` (not `provider-matrix.md`) in the same slot, still 16
   docs in order.
2. Grep the whole repo for `provider-matrix` -- confirm the only remaining
   references are `docs/architecture.md`, `docs/provider-guide.md` (its
   closing pointer), `docs/provider-matrix.md` itself, and the regenerated
   `llms-full.txt` (which embeds architecture.md's mention). No user-facing
   doc (README, FAQ, llms.txt) should reference `provider-matrix.md` anymore.
3. Confirm no Markdown links are broken: every relative link changed must
   resolve to an existing file.
4. `npm test` and `npm run build` pass.

## Acceptance criteria

- `docs/provider-guide.md` exists, is concise, user-facing, ASCII-only.
- `docs/provider-matrix.md` is byte-for-byte unchanged.
- README, FAQ, llms.txt point at `provider-guide.md`; architecture.md still
  points at `provider-matrix.md`.
- `llms.txt` / `llms-full.txt` regenerated; 16 docs, order preserved.
- `gen-llms-full.test.ts` updated; `npm test` and `npm run build` pass.
- No broken Markdown links anywhere.

## Branch

Continue on the existing branch `docs/llms-txt-index` (PR #272, open). Add
these as new commits on top of 754a9c8. ASCII-only commits.
