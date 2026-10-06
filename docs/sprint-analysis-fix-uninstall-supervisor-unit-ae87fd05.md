# Sprint Analysis: fix/uninstall-supervisor-unit

Scope issue id(s): apra-fleet-b4g.123.
Base branch: feat/kb-redesign.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [4].
High-water-mark closed count this sprint: 5.
Final closed count: 4.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of feat/kb-redesign...fix/uninstall-supervisor-unit at 41eca618: 4 commits, 5 files. All changes trace to apra-fleet-b4g.123 and its children .1, .2 and .3.

Acceptance criterion 1 (stop, disable and remove the supervisor unit on every OS) is met. The new file src/services/supervisor-service-cleanup.ts finds registrations by their known names on each OS:
- Linux: systemd user units fleet-supervisor.service and apra-fleet-supervisor.service.
- macOS: launchd label com.apra-fleet.supervisor.
- Windows: scheduled task ApraFleetSupervisor.
A registration is removed only when the command it runs points at the installed tree. That is either BIN_DIR/apra-fleet supervisor or WORKFLOWS_DIR/fleet-sprint/bin/serve.mjs. I checked the v0.5 unit shape (linux.ts ExecStart="<bin>" supervisor): the quotes are stripped before matching, so it is caught. Removal per OS:
- Linux: systemctl --user disable --now, delete the unit file, daemon-reload.
- macOS: launchctl bootout (a plist that is not loaded is tolerated), delete the plist.
- Windows: find the process with a PowerShell -EncodedCommand query, taskkill /T, schtasks /Delete, delete the wrapper.
All commands are passed as argument arrays, with no shell interpolation. runUninstall calls the cleanup before cleanupWorkflows and outside it, so a re-run after the tree is already gone still removes the unit. If a removal fails, uninstall names the failure and exits 1, so it fails loudly.

Acceptance criterion 2 (output lists what is kept) is met. printKeptSection prints data/, fleet.key (with a warning to back it up separately), user-authored workflows, any other leftovers under FLEET_BASE, and any supervisor registrations that are not ours. The dry-run fixture was updated to match.

Tests: the new suite in tests/uninstall.test.ts covers Linux (both the serve.mjs and v0.5 shapes), macOS (including a plist that is not loaded), Windows tree-kill order, the --skill workflows ordering, the failure path exiting 1, the Kept section on real and dry runs, and that a partial uninstall prints no Kept section.

Verification this review:
- npm run build: OK.
- vitest on tests/uninstall.test.ts plus the regression-command-surface tests: 2 files, 49/49 passed.
- Working tree clean.
- Full npm test not re-run here. The close note says exit 0 at 41eca618.

Hygiene: .fleet/kb-canonical.json gains 1 entry from the KB commit, which is expected.

Tool use: kb was used (kb_query). code_impact on runUninstall was tried, but the index is 4 commits behind and it resolved to the wrong symbol (claimBeadsBatched). I fell back to reading the diff and grep.

Follow-up tasks filed below: merging with v0.5 needs reconciling with its uninstall supervisor path; the Windows process search can miss an orphaned v0.5 child; the dry-run removal list is hardcoded.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran the playbook at branch HEAD. The `Install smoke` part passed. The leftover sandbox-deploy sweep for this sprint's id reported 'nothing to tear down' and exited 0. Setup acquired the sandbox lock, ran a fresh `install` into the throwaway HOME, and started the server on scratch port 18700. `status` and the server.json check both confirmed the port. Teardown then released the lock, stopped the server and deleted the sandbox; every step exited 0. `In-sprint smoke` is NOT RUN: moved to CI. The playbook defines it that way, so the overall `passed` is false by design and no bead was filed for it. This result is informational and does not gate the sprint. No failures were found, so no carry-over beads were filed.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-win1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.123.1, apra-fleet-b4g.123.2, apra-fleet-b4g.123.3]] -- kb_* calls: 4, code_* calls: 1.
- Dispatch 4: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 5: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 6: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: reviewer on member 'fleet-win1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 8: regression-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-win1': 5 dispatch(es), kb_* calls: 8, code_* calls: 4.
- member 'fleet-win3': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $7.4662.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0514 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 8 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
