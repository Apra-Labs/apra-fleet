# Cross-Repo Design Negotiation Protocol

- **Why this exists:** apra-fleet-reorg and fleet-dashboard are two
  independent AI-orchestrated development efforts (separate sessions,
  separate repos) that both happen to be checked out **on the same
  machine**. There is no live channel between the two *sessions*, but
  there doesn't need to be a *human* relay either: any orchestrating
  session can read and write both repos' filesystems directly and spawn a
  fresh agent scoped to the other repo's real context to get a genuine,
  independent review -- no paraphrasing, no manual copy-paste, no round
  trip through a person. `docs/api-contract-reconciliation.md` and
  fleet-dashboard's `docs/architecture.md` already did one real round of
  this informally (via a human relay, before this was formalized); this
  document turns that into a repeatable, human-optional convention.
- **Scope:** any design decision that changes the boundary between the two
  repos (API shapes, auth model, data ownership, sync behavior). Purely
  internal decisions to one repo do not need this process.

## The loop (autonomous, same-machine version)

1. **Proposer drafts.** One side writes a proposal doc in its own repo,
   under `docs/`, with the header block below. Status starts at
   `PROPOSED`.
2. **Spawn an independent reviewer, scoped to the other repo.** The
   orchestrating session launches a FRESH agent (not a fork -- a fork
   inherits the proposer's own framing and bias, which defeats the point
   of an independent review) with: (a) the proposal doc's contents, (b)
   explicit instructions to ground its review in the OTHER repo's actual
   code and docs (read its real architecture doc, real handlers, real
   schemas -- not just the proposal's claims about them), and (c)
   instructions to look for problems, not rubber-stamp -- a review with
   zero pushback on a multi-item proposal is a signal to look harder, not
   a compliment. The agent writes its response into the OTHER repo's
   `docs/`, as a new file or a clearly-marked section, using the verdict
   table shape below.
3. **Read the response back.** The orchestrating session reads what the
   reviewer agent wrote, folds it into its own copy of the proposal doc
   (`Status: REVISED` if anything changed), and explicitly addresses every
   disagreement -- do not silently drop one, restate and answer it, the
   way section 1.5 of the reconciliation doc did.
4. **Repeat 2-3** until a round produces a response with **zero open
   objections**. At that point the proposer sets `Status: AGREED` and
   copies the final text (or a pointer to it) into both repos' `docs/`.
5. **Only an `AGREED` doc unblocks dependent implementation work.** A
   `PROPOSED` or `REVISED` doc is not a green light to start building
   against it -- see apra-fleet-yeb's design task (48p) and its
   dependents for the concrete case this convention was written for.
6. **The human mediator is a circuit breaker, not a relay.** Bring a
   human in only when: a round produces the same unresolved `DISAGREE`
   twice in a row (see below), a decision requires real authority the
   orchestrating session doesn't have (e.g. actual deployment, spending
   money, changing who's approved for what), or either repo's "reviewer"
   pass turns out to need a real human on that side rather than an agent
   (see the note on this in the old version of this doc, now folded into
   this point) -- not as a routine step in every round.

## Proposal doc shape (required header)

```
# <Title>

- Status: PROPOSED | REVISED | AGREED
- Proposed by: <repo>
- Date: <date>
- Depends on / references: <other docs, beads issues>
- Open questions: <numbered list -- every question the proposer needs
  an explicit answer to, up front, in ONE round rather than trickled out
  over several. Minimizing round trips is still a design goal even though
  relaying is now automated -- each round still costs a fresh reviewer
  agent's full context-gathering pass over the other repo, not free.>
```

## Response shape (required, appended by the reviewer)

```
## <Reviewer repo>'s Response -- <date>

| # | Item | Verdict | Notes |
|---|---|---|---|
| 1 | <restate the open question or item> | AGREE / DISAGREE / NEEDS-DISCUSSION | <one or two sentences -- if DISAGREE, name the alternative and why> |
```

A `NEEDS-DISCUSSION` verdict on anything means the loop is not done --
it is a real, load-bearing status, not a placeholder for "we'll figure it
out later." Step 4 of the loop (repeat until zero open objections)
applies to `NEEDS-DISCUSSION` rows exactly as it does to `DISAGREE` rows.

## What this protocol deliberately does not solve

- **A reviewer agent representing a repo is not the same authority as
  that repo's real maintainer.** This protocol produces a well-reasoned,
  adversarially-tested proposal that both sides' agents agree is sound --
  it is not a substitute for an actual human sign-off if either side has
  one. Treat `AGREED` as "ready for a human rubber-stamp," not as
  "already approved by a human," unless the human mediator has said
  otherwise for a given negotiation.
- It does not adjudicate genuine disagreements -- if two full rounds
  produce the same unresolved `DISAGREE`, that is a decision for the
  human mediator to make (or escalate), not something either AI session
  should resolve by assumption or by whichever side answers last (see
  loop step 6).
