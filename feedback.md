# Doc Consolidation — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-04-18 12:00:00+00:00
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## 1. Clear "done" criteria — PASS

Every task has explicit done criteria. Task 1.1 requires a documented overlap map. Task 1.2 requires the generation script to run without error and `llms-full.txt` to be free of `docs/user-guide.md` references. Tasks 2.1–2.4 each specify measurable outcomes (comprehensive readme, under 30 lines, file deleted, zero grep hits).

## 2. High cohesion / low coupling — PASS

Each task touches a distinct concern: audit (1.1), CI safety (1.2), merge (2.1), delete+refs (2.2), CLAUDE.md (2.3), AGENTS.md (2.4). Tasks 2.3 and 2.4 are fully independent. Good separation.

## 3. Key abstractions in earliest tasks — PASS

The overlap map (Task 1.1) feeds into Task 2.1's merge. CI safety net (Task 1.2) is prerequisite to deletion. Correct ordering.

## 4. Riskiest assumption validated first — PASS

The plan explicitly places Task 1.2 (CI update) before Task 2.1/2.2 (merge and delete), with VERIFY 1 as a gate between phases. This matches the requirements' hard constraint that CI must be safe before the file is deleted. The risk register correctly identifies this as High/High.

## 5. Later tasks reuse early abstractions (DRY) — PASS

Task 2.1 consumes the overlap map from 1.1. Task 2.2's grep uses patterns established in 1.2. No redundant work.

## 6. Work-to-verify ratio — NOTE

Phase 1 has 2 tasks before VERIFY 1 — good. Phase 2 has 4 tasks before VERIFY 2. This is acceptable here because Tasks 2.3 and 2.4 are trivial rewrites (each ~15 minutes of work), and the four tasks form a natural atomic unit: merge content, delete old file, update wrappers. Splitting a verify between 2.2 and 2.3 would add ceremony without reducing risk.

## 7. Each task completable in one session — PASS

All tasks are scoped appropriately. Task 2.1 is the largest (merging 348 lines into readme.md) but is a mechanical content merge with specific sections enumerated. Completable in one session.

## 8. Dependencies satisfied in order — PASS

Task 1.1 (audit) feeds 2.1 (merge). Task 1.2 (CI update) must precede 2.2 (delete). VERIFY 1 gates Phase 2. Tasks 2.3 and 2.4 are independent of each other. All dependencies are respected.

## 9. Vague tasks — FAIL

**Task 2.1 done criteria is insufficiently specific.** The current "done" says: *"readme.md is a comprehensive reference covering everything docs/user-guide.md had."* This is subjective. The "What" section lists specific sections to merge (Install, Register, Using members, Multi-provider, Git auth, PM Skill, Troubleshooting) — but the "Done" line doesn't reference this list. It should say: *"readme.md contains dedicated sections for each of: Install (manual steps, --skill flags, uninstall), Register (local vs remote, SSH key migration), Using members (run-prompt, run-command, send-files, check-status examples), Multi-provider fleets (auth provisioning, CLI install), Git authentication (GitHub App, Bitbucket, Azure DevOps), PM Skill (init/plan/pair commands table), and Troubleshooting."*

## 10. Hidden dependencies — FAIL

**Task 2.2 grep pattern is incomplete.** The plan uses `grep -r "user-guide"` but the requirements also specify `grep -r "userguide"`. While the actual file is `docs/user-guide.md`, references in the codebase may use either form. In fact, `src/services/cloud/aws.ts:17` contains the string `userguide` (an AWS docs URL — `https://docs.aws.amazon.com/cli/latest/userguide/...`). The grep in Task 2.2 and VERIFY 2 should:
1. Search for both `user-guide` and `userguide` patterns.
2. Explicitly exclude false positives: external URLs (the AWS userguide link) and the requirements doc itself.

**`llms.txt` also references `docs/user-guide.md`** (line 9: `[User Guide](docs/user-guide.md)`). Task 1.2 says to update this, which is correct, but Task 2.2's grep should also catch it as a verification safety net.

## 11. Risk register — PASS

The risk register covers the four key risks: CI breakage, stale references, content loss, and thin agent files. Likelihoods and mitigations are reasonable. One minor addition: the register should note that `src/services/cloud/aws.ts` contains "userguide" as an AWS external URL and is a known false positive for the grep check — not a stale reference.

## 12. Alignment with requirements intent — FAIL

**The requirements reference `ci.yml` as the CI update target (Task 5), but the plan targets `scripts/gen-llms-full.mjs` and `llms.txt` instead.** The plan is actually *more correct* than the requirements here — `ci.yml` merely calls `node scripts/gen-llms-full.mjs`, so the real fix is in the script and in `llms.txt`. However, the plan should explicitly note this deviation: *"Requirements say 'update ci.yml' but the actual source references live in `scripts/gen-llms-full.mjs` (line 22) and `llms.txt` (line 9). `ci.yml` only invokes the script and needs no changes."* This prevents a future executor from wondering if they missed updating `ci.yml`.

---

## Summary

**3 items need changes before this plan can be executed:**

1. **Task 2.1 done criteria** — replace the subjective "comprehensive reference" with an explicit section checklist matching the "What" block. (Check 9)

2. **Task 2.2 / VERIFY 2 grep pattern** — search for both `user-guide` and `userguide`; document known false positives (AWS URL in `src/services/cloud/aws.ts`, requirements doc). (Check 10)

3. **Task 1.2 deviation note** — add a sentence explaining why the plan targets `scripts/gen-llms-full.mjs` + `llms.txt` instead of `ci.yml` as the requirements stated, so the executor knows this is intentional. (Check 12)

Everything else passes. The phasing is sound, risk register is thorough, dependency ordering is correct, and the VERIFY checkpoints are well-placed. These three fixes are minor — none require restructuring tasks or changing the execution order.
