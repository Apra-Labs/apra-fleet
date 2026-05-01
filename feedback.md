# apra-fleet secret CLI — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Verdict:** CHANGES NEEDED

---

## 1. Done criteria (Checklist #1)

Tasks 2, 4, 5, and 6 have clear, verifiable done criteria. **FAIL** on Task 1: the done criteria cover `--help`, `--set` error path, and `--list`, but omit `--update`, `--delete`, and `--delete --all` acceptance. These are distinct user-facing flows with validation rules (e.g. "at least one flag required" for `--update`, confirmation prompt for `--delete --all`). Task 3 is acceptable — "auto-launched terminal closes when secret delivered via separate shell" is testable, though it is a manual/integration check.

**Fix:** Add explicit done-when bullets for `--update` (at least one metadata flag required, error otherwise), `--delete <name>` (removes from store), and `--delete --all` (confirmation prompt, refusal on non-`yes` input).

---

## 2. Cohesion and coupling (Checklist #2)

**FAIL** on Task 1. It implements six distinct CLI modes (`--set`, `--set --persist`, `--list`, `--update`, `--delete`, `--delete --all`) in a single task. Each mode has different flag parsing, different validation, and different service function calls. This is low cohesion within one task. If `--set` with OOB socket delivery is working but `--delete --all` confirmation is buggy, the task is ambiguously incomplete.

Task 3 mixes two concerns — changing the spawned command string (from `auth` to `secret --set`) and adding PID-tracking/kill logic — but these are tightly coupled enough that splitting would add overhead without benefit. **PASS** for Tasks 2–6.

**Fix:** Split Task 1 into two tasks: (A) `--set` and `--set --persist` (the OOB delivery path, which is the core new capability), and (B) `--list`, `--update`, `--delete`, `--delete --all` (vault management, which are thin wrappers over existing `credential-store.ts` functions). This also makes done criteria cleaner.

---

## 3. Shared abstractions early (Checklist #3)

**PASS.** Task 1 establishes the CLI entry point and arg-parsing scaffold that all later tasks build on. The existing `credential-store.ts` functions (`credentialSet`, `credentialList`, `credentialDelete`, `credentialUpdate`) and `secureInput()` are already in the codebase — the plan correctly reuses them rather than re-inventing.

---

## 4. Riskiest assumption validated early (Checklist #4)

**PASS.** The riskiest integration — OOB socket delivery from the new `secret --set` path — lands in Phase 1 and is verified at the Phase 1 checkpoint. Phase 2 (three-signal upgrade) extends an already-proven path. The cross-platform PID kill risk is called out in the risk register and deferred to Phase 2 where it belongs.

---

## 5. DRY / reuse of early abstractions (Checklist #5)

**PASS.** Task 1 reuses `secureInput()`, `getSocketPath()`, and all four credential-store service functions. Task 5 tests exercise the CLI built in Task 1. No duplicated logic is introduced.

---

## 6. Phase boundaries at cohesion boundaries (Checklist #6)

**PASS.** Phase 1 = CLI surface, Phase 2 = server-side OOB upgrade, Phase 3 = path hardening, Phase 4 = tests. Each phase is a coherent, independently testable increment with its own VERIFY checkpoint.

---

## 7. Tier monotonicity (Checklist #7)

**FAIL.** Phase 2 is `standard`, Phase 3 drops to `cheap`, Phase 4 bounces between `standard` and `cheap`. The guideline is monotonically non-decreasing within each phase to avoid context-switching between effort levels. Phase 3 (cheap) following Phase 2 (standard) is a downgrade.

**Fix:** Reorder Task 4 (cheap path refactor) to run before Task 3 (standard OOB upgrade) — this is also better architecturally because Task 3's new spawn command `apra-fleet secret --set <name>` should use the hardened `getCredentialsPath()` from the start. Alternatively, merge Task 4 into Phase 1 as it has no blockers and is a cheap, low-risk refactor.

---

## 8. Each task completable in one session (Checklist #8)

**FAIL** on Task 1 as currently scoped (six CLI modes with distinct flag parsing, validation, and service calls). After the split recommended in finding #2, each resulting task is comfortably single-session. All other tasks are appropriately sized. **PASS** for Tasks 2–6.

---

## 9. Dependencies satisfied in order (Checklist #9)

**PASS** for declared dependencies. However, see finding #11 for an undeclared dependency.

---

## 10. Ambiguous tasks (Checklist #10)

**NOTE.** Task 1 says "Read requirements.md for exact flag semantics" rather than spelling them out inline. This is a pointer, not a specification. Two developers could interpret the `--set` error-path logic differently (e.g., should `--set` with `--persist` and a waiting request deliver *and* persist, or persist only?). The requirements are clear on this — "same as (1), but `--persist` also writes to `credentials.json`" — but the plan should not rely on cross-referencing.

**Fix:** In Task 1 (or 1A after split), enumerate the three `--set` use cases from requirements inline: (1) waiter exists, no `--persist` → deliver only; (2) waiter exists, `--persist` → deliver and persist; (3) no waiter, `--persist` → persist only; (4) no waiter, no `--persist` → error. Also state the default `network_policy=deny` and `--members` default of `*`.

---

## 11. Hidden dependencies (Checklist #11)

**FAIL.** Task 3 changes `launchAuthTerminal` in `auth-socket.ts` to spawn `apra-fleet secret --set <name>` instead of `apra-fleet auth <name>`. This command only exists after Task 1 is complete. Task 3's blockers list only "PID kill cross-platform" — it does not declare a dependency on Task 1.

This is currently safe because Phase 2 follows Phase 1 sequentially, but if tasks were parallelized or reordered, Task 3 would produce a broken spawn command. Explicit is better than implicit.

**Fix:** Add `Blockers: Task 1` to Task 3.

---

## 12. Risk register (Checklist #12)

**FAIL — incomplete.** The register covers four risks but misses two material ones:

1. **`auth` alias backward compatibility.** The plan keeps `auth` as an undocumented alias, but `auth.ts` currently accepts `--api-key`, `--confirm`, and `--prompt` flags that `secret.ts` does not replicate. If external scripts or the server's `launchAuthTerminal` still call `apra-fleet auth --api-key <name>` during the transition window between Tasks 1–2 and Task 3, the OOB flow breaks. Mitigation: keep `auth.ts` unchanged and functional until Task 3 switches the spawned command to `secret --set`.
2. **Non-TTY `secureInput` fallback.** `secureInput()` falls back to plain `readline` when `stdin` is not a TTY. If a CI job or piped invocation hits `secret --set`, the no-echo guarantee is lost. Requirements say "CLI always prompts for the value with no-echo secure input" — the plan should acknowledge this edge case and decide whether to error or warn.

The "Gemini trust directory blocks execute_prompt" risk is tangential to this issue and clutters the register.

**Fix:** Add risks #1 and #2 above. Remove or move the Gemini trust risk to a project-level note.

---

## 13. Alignment with requirements (Checklist #13)

**PASS** on overall direction — the plan solves the right problem (user-facing secret management CLI replacing the internal-only `auth` command). Key requirements are covered: `--set`/`--persist`/`--list`/`--update`/`--delete` semantics, OOB three-signal upgrade, `auth` removal from `--help`, `APRA_FLEET_DATA_DIR` forward compatibility, and no data migration.

**NOTE:** Two requirements details are not explicitly called out in any task:
- Name validation regex `[a-zA-Z0-9_]{1,64}` — mentioned in Task 5 (tests) but not in Task 1 (implementation). Validation should be implemented before it is tested.
- The `--list` table format columns (`NAME / SCOPE / POLICY / MEMBERS / EXPIRES`) from requirements are not specified in Task 1's done criteria.

---

## Summary

**Passed (7/13):** Shared abstractions early (#3), riskiest assumption validated early (#4), DRY reuse (#5), phase boundaries (#6), dependencies in order (#9), requirements alignment (#13), ambiguity (#10 — minor note only).

**Must change before implementation:**
1. **Split Task 1** into set/persist vs. vault-management tasks (findings #2, #8)
2. **Declare Task 3 → Task 1 dependency** (finding #11)
3. **Add done criteria** for `--update`, `--delete`, `--delete --all`, name validation, and `--list` table format to Task 1 (finding #1)
4. **Fix tier ordering** — move Task 4 before Task 3 or into Phase 1 (finding #7)
5. **Complete the risk register** — add auth alias compat and non-TTY risks, remove tangential Gemini entry (finding #12)
6. **Inline `--set` use cases** in Task 1 instead of pointing to requirements.md (finding #10)

**Deferred (no action needed now):**
- `confirm` network policy (explicitly out of V1 scope per requirements)
- `--from-env` flag (explicitly out of scope)
- Full `#193` data-dir migration (deferred per requirements)
