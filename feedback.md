# apra-fleet secret CLI — Plan Re-Review

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Verdict:** APPROVED

---

## Prior feedback.md history

```
52d768e review: plan/issue-216 — fleet-rev          (initial review, CHANGES NEEDED — 6 findings)
2776724 plan: updated PLAN.md addressing review      (planner's revision)
```

This re-review verifies the 6 findings from the initial review and re-runs the full 13-point checklist.

---

## Finding Verification

### Finding 1 — Task 1 split into OOB delivery vs vault management: RESOLVED

Old Task 1 was a single monolithic task covering six CLI modes. Now split into Task 2a (OOB delivery: `--set` and `--set --persist`) and Task 2b (vault management: `--list`, `--update`, `--delete`, `--delete --all`). Each has focused done-when criteria matching its scope. Cohesion is improved.

### Finding 2 — Task 3 declares Task 1a as blocker: RESOLVED

Task 4 (three-signal OOB) now explicitly states `Blockers: Task 2a must be merged.` The dependency that was previously implicit in phase ordering is now declared.

### Finding 3 — `--set` use-case matrix inlined: RESOLVED

Task 2a now enumerates all three use cases inline:
1. OOB delivery (waiter exists, no `--persist`)
2. OOB delivery + persist (waiter exists, `--persist`)
3. Persist only (no waiter, `--persist` required)

No "see requirements.md" cross-reference remains.

### Finding 4 — CREDENTIALS_PATH refactor moved before standard-tier OOB work: RESOLVED

The cheap `getCredentialsPath()` refactor is now Task 1 in Phase 1, before all standard-tier work. Cross-phase tier ordering is now: cheap (Phase 1) → standard (Phase 2) → standard (Phase 3) → standard/cheap (Phase 4). The problematic Phase 2 standard → Phase 3 cheap downgrade from the original plan is eliminated.

### Finding 5 — Two new risks added: RESOLVED

Risk register now includes:
- **`auth` alias backward compat** — mitigation: keep `auth` branch in `index.ts`; add integration test
- **Non-TTY `secureInput` fallback** — mitigation: detect `process.stdin.isTTY`; if false, print error and exit 1

Both risks have actionable mitigations.

### Finding 6 — All "see requirements.md" deferences removed: RESOLVED

The old plan's `"Read requirements.md for exact flag semantics"` is gone. Task 2a inlines use cases, Task 2b inlines `--list` column spec, `--update` flags, and `--delete --all` confirmation prompt. The plan is self-contained.

---

## Full 13-Point Checklist

### 1. Done criteria — PASS

All tasks have verifiable done-when clauses. Task 2a specifies the three `--set` outcomes. Task 2b specifies table display, metadata-only update, `--all` confirmation, and invalid name rejection.

**Minor note:** Task 2b done-when doesn't explicitly state "`--delete <name>` removes from store" as a separate bullet — it's covered by the Change description but could be more explicit. Non-blocking.

### 2. Cohesion and coupling — PASS

Task 2a (OOB delivery) and Task 2b (vault management) are well-bounded. Task 4 (three-signal OOB) appropriately bundles the command-string change with PID tracking since they're tightly coupled. No task mixes unrelated concerns.

### 3. Shared abstractions early — PASS

Phase 1 establishes `getCredentialsPath()`. Phase 2 builds on existing `credential-store.ts` functions, `secureInput()`, and `getSocketPath()`. No new shared abstractions are needed before they're used.

### 4. Riskiest assumption validated early — PASS

OOB socket delivery (Task 2a) is the core new capability and lands in Phase 2 with a VERIFY checkpoint. The cross-platform PID kill risk is deferred to Phase 3 (Task 4) where it belongs.

### 5. DRY / reuse of early abstractions — PASS

All tasks reuse existing service functions. No duplication introduced.

### 6. Phase boundaries at cohesion boundaries — PASS

Phase 1 = internal refactor. Phase 2 = user-facing CLI surface. Phase 3 = server-side OOB upgrade. Phase 4 = tests. Each phase is independently testable with its own VERIFY checkpoint.

### 7. Tier monotonicity — PASS

Cross-phase ordering is cheap → standard → standard → standard/cheap. The blocking violation (standard → cheap between Phases 2 and 3) from the original plan is fixed.

**Minor note:** Within Phase 2, Task 3 (cheap) follows Tasks 2a/2b (standard). This is a minor intra-phase drop but Task 3 is a thin wiring task that logically completes the CLI entry point — splitting it into a separate phase would be over-engineering.

### 8. Each task completable in one session — PASS

After the split, the largest task is Task 2a (three `--set` use cases with socket comms). This is well-scoped for a single session. All other tasks are smaller.

### 9. Dependencies satisfied in order — PASS

Task 4 declares `Task 2a must be merged`. Phase ordering ensures all other implicit dependencies are met.

### 10. Ambiguous tasks — PASS

No cross-references to external documents for spec details. All flag semantics, error messages, and validation rules are stated inline.

### 11. Hidden dependencies — PASS

The previously undeclared Task 4 → Task 2a dependency is now explicit. No other hidden dependencies detected.

### 12. Risk register — PASS

Five risks with mitigations. The two risks flagged in the initial review (auth alias compat, non-TTY secureInput) are now present with actionable mitigations.

**Minor note:** The Gemini trust directory risk is still present. The initial review suggested removing it as tangential. It's not harmful but adds noise. Non-blocking.

### 13. Alignment with requirements — PASS

All requirements are covered: `--set`/`--persist`/`--list`/`--update`/`--delete` semantics, OOB three-signal upgrade, `auth` removal from `--help`, `APRA_FLEET_DATA_DIR` forward compat, no data migration, name validation regex, `--list` table columns.

---

## Summary

**Passed: 13/13** (3 minor non-blocking notes)

All 6 findings from the initial review are resolved. The plan is self-contained, well-ordered, and aligned with requirements. Ready for implementation.

### Non-blocking notes (address during implementation):
1. Task 2b done-when: consider adding explicit `--delete <name>` acceptance criterion
2. Phase 2 intra-phase tier: Task 3 (cheap) after Tasks 2a/2b (standard) — acceptable given logical cohesion
3. Gemini trust directory risk entry is tangential — consider removing during implementation
