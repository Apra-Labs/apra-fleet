# Knowledge Bank Agent

The Knowledge Bank (KB) workflow gives fleet members persistent, cross-session
codebase context. It runs in three phases per session.

---

## Phase 1 (Prime)

Run at the start of every session before touching any code.

```
kb_session_prime
```

- Reads the KB index for the current repo and returns stale or missing entries.
- Returns a list of recommended code intelligence calls to refresh stale context.
- After priming, dispatch all recommended calls using the fleet code intelligence
  tools (code_graph, code_impact, code_query, code_context).

**If kb_session_prime is unavailable**, skip and proceed -- the KB is optional.

---

## Phase 2 (Capture)

Run after significant decisions or architectural choices during the session.

```
kb_capture
```

- Writes a new KB entry summarizing the current decision or finding.
- Run after: choosing an approach, discovering a non-obvious constraint, making
  a design trade-off, or resolving a subtle bug.
- Do NOT run after routine code edits -- only when the WHY is non-obvious.

---

## Phase 3 (Harvest)

Run at the end of every session before stopping.

```
kb_harvest
```

- Summarizes session learnings into durable KB entries.
- Ensures future sessions (and other members) benefit from work done this session.

---

## Code Intelligence Tools

Use these fleet tools for cross-file tracing and symbol lookup. Never
plain-read files for structural questions -- use the tools instead.

| Tool | Purpose |
|------|---------|
| `code_graph` | Call graph for a symbol (callers + callees) |
| `code_impact` | Blast radius for a symbol (upstream affected) |
| `code_query` | Semantic search across codebase |
| `code_context` | Full symbol context (callers, callees, flows) |
