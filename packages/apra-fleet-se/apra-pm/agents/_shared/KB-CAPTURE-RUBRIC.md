# Knowledge-bank capture rubric

Shared by every role that returns `kb_captures` (or judges them). The question for every
candidate entry: **would the next developer be worse off without it, and could they not
get it in under a minute from the cited files?** If not, do not capture it.

## GOOD -- capture these

- A failed attempt and why it failed (tried X, failed because Y, fixed with Z).
- A hidden invariant or ordering constraint.
- An OS, shell, tool or environment quirk.
- Why something is built this way, including the alternatives that were rejected.
- Coupling across files that no single file shows.
- A trap that a test or a reviewer caught.

## NOT KB -- never capture these

- What the change or a function does.
- Names or values that are readable in the cited lines.
- Task, ticket or sprint status.
- Changelog notes.
- Anything the next developer gets in under a minute from the cited files.

## Shape of an entry

- **Summary stands alone**: the lesson in at most 2 sentences, present tense, stated as
  current truth.
- **content is optional.** Write it only when it adds what the summary cannot hold.
  Content that repeats the summary is refused.
- **One claim per entry.**
- When you write content, use only the labelled sections you need:
  - Context
  - Symptom (the exact error)
  - Cause
  - Rule/Fix
  - Tried (failed) -- explicitly marked as wrong
  - Evidence (symbol + file, test or repro)
- Name symbols and files; never line numbers (they rot).
- No narrative ("I", "then", "we tried"), no sprint or ticket references, no hedging.
- State conditions explicitly ("only on Windows", "only when the cache is cold").

## trigger

Every capture carries exactly one `trigger`:

- `failed-attempt` -- an approach was tried and did not work. Must have Cause and Rule/Fix
  in content (and the failed approach under Tried (failed)).
- `review-finding` -- a reviewer caught a trap or missed invariant.
- `test-failure` -- a test went red for a non-obvious reason.
- `env-quirk` -- an OS, shell, tool or environment behaviour that surprised you.
- `hidden-invariant` -- an ordering constraint or coupling no single file shows.
- `design-rationale` -- why something is built this way, incl. rejected alternatives.

There is no value for "describes the change": such entries are not KB.

## recall_cues and error_signatures

- `recall_cues`: phrases a future reader would search for when they hit this problem
  (their words for the symptom, not yours for the fix).
- `error_signatures`: exact error strings, copied verbatim, that this lesson explains.
