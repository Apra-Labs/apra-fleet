# v0.5_dashboard sprint plan (wave-based, three doers, 24x7)

Source: `C:\Users\akhil\.claude\jobs\bb3eed62\tmp\v05-sprint-plan.md` (2026-09-21)
Inputs: `v05-brief.md`; `local-dashboard-schema.md` v4/v5 (object model s2, screens s3, code map s4.2,
gap list s5, increments s6, DQs s7); origin/main @ def08eba (all file:line cites below are
against that commit, read with `git show origin/main:<path>`); live fleet (`list_members`):
doers fleet-mac1 (macos), fleet-lin1 (linux), fleet-win1 (windows); orchestrator member
`supervisor` (local, provider=none, unreservable, tags orchestrator/beads-only).
Convention: increment = s6 row 1-6; gap ids F*/C*/S* = s5; screens S1-S10 and wireframes
W1-W6 = s3; DQ-n = s7. Bead keys `V05-S<n>-E1/-F<n>/-T<n>` are plan keys, converted to beads
mechanically later (no bead is created by this document).

---

## 1. Plan summary

1. 10 waves (wave 0 on `main` for one Windows blocker, waves 1-9 on `v0.5_dashboard`),
   28 sprints (S0-S27), 3 concurrent at all times from wave 1 on, one sprint = one doer =
   one branch `feat/v05-s<n>-<slug>` off `v0.5_dashboard` = one PR into `v0.5_dashboard`.
2. Total estimate: ~302 engine-hours (per-sprint 8-12 h, table in s2).
3. Milestones: waves 1-2 = increment 1 (shell, registry, auth); waves 2-4 = increment 2
   (server member fields, registration, projects, binding, git panel, OS service); waves 4-6 =
   increment 3 (backlog, sprint definition, roleMap); waves 5-6 = increment 4 (KB/Code);
   waves 6-8 = increment 5 (engine launch data, sqlite ledger, scheduler, N runs, viewer auth,
   dashboard.mjs retired); waves 8-9 = increment 6 (groomer, doctor) + hardening.
4. Critical path (fleet-lin1 chain, all engine/supervisor core): S1 -> S5 -> S7 -> S11 -> S13
   -> S18 -> S19 -> S22 -> S25 = 102 h of sprint time; every other chain is shorter.
5. Wall clock: a wave gates on its slowest sprint (12 h / 0.6 utilisation = ~20 h); 9 waves +
   the wave-0 stagger on fleet-win1 (~13 h) = ~195 h of engine wall clock = 8-9 days if the
   owner squash-merges each finished PR within ~2 h; 10-12 calendar days with a twice-daily
   merge cadence (merges into `v0.5_dashboard` are the owner's action, see s5).
6. Wave 1 satisfies the brief: W0-a = S1 (groundwork, playbooks, CI, PR 493 landing, hzb2,
   tbup), W0-b = S2 (`/ui` page listing real members from the SEA-served shell), W0-c = S3
   (client C1/C3/F3 + `supervisor.sqlite` skeleton + `/api/projects` route module).
7. Follow-ups: 4v8r IN (S20, wave 7, gate for UI sprint controls, DQ-11); tbup IN (S1 T3,
   10-line spawner/api change needed for every multi-member roleMap from wave 2 on); hzb2 IN
   (S1 T2, PR 493 landing breaks the playbook curls the same day); am7w + 0cil OUT of the
   branch but IN the schedule as wave 0 on `main` (Windows dispatch-pipe stall blocks every
   fleet-win1 Deploy phase; fix belongs on `main`, production server redeployed, then `main`
   merged into `v0.5_dashboard`).
8. Out of scope for v0.5_dashboard (stay on main's backlog): S5 `--manifest` single-run mode
   (74vu Stage 1, doc says "later"), beads-as-a-service v2 (`bd serve`, gated on DQ-25), F8
   `kb_get`, F9 cloud-section drop, F10 cross-origin code query.
9. Disjointness rule applied per wave: file sets listed in s2/s3 do not overlap inside a wave;
   shared hot files (`bin/serve.mjs`, `src/console/server.ts`, client `api.mjs`,
   `src/types.ts`) are owned by exactly one sprint per wave; wave 1 pre-creates the seams
   (route-module registration, client subpath exports) that let later sprints add files
   instead of editing shared ones.
10. Precondition before wave 1: owner pushes `v0.5_dashboard` from origin/main (`git push
    origin def08eba:refs/heads/v0.5_dashboard`; the branch does not exist on origin today) and
    seeds the UI paste (S2 T1, see s5 D1).

---

## 2. Wave table

| wave | sprint key | doer | goal | files touched (dirs/files, all new unless noted) | prereqs | est h | inc |
|---|---|---|---|---|---|---|---|
| 0 (main) | V05-S0 | fleet-win1 | Fix am7w (Windows Deploy dispatch never completes: sandbox grandchildren inherit the dispatch stdout pipe) and 0cil (stall detector never fires on a frozen transcript, `stall-detector.ts` ~475/495); land on `main`, redeploy production server | `src/tools/execute-command.ts` (long_running wrapper 259-353 only), `src/os/windows-wrapper.ts`, `src/services/cloud/task-wrapper.ts`, `src/services/stall/stall-detector.ts`, `src/services/stall/read-log-tail.ts`, tests `tests/execute-command-long-running-windows.test.ts`, `tests/stall-detector.test.ts`, `tests/stall-no-signal-false-kill.test.ts` | none | 8 | pre |
| 1 | V05-S1 (W0-a) | fleet-lin1 | Groundwork every later sprint depends on: land PR 493 with token source `~/.apra-fleet/fleet.key` (DQ-20), hzb2 playbook curls with bearer, tbup `sync` via API, deploy.md/integ/regression playbook + `sandbox-deploy.mjs` + `ci.yml` edits for the UI shell (edits named by the other analyst) | `packages/apra-fleet-se/src/supervisor/{auth.mjs,server.mjs,api.mjs,dashboard.mjs,spawner.mjs,coordination.mjs}` (PR 493 set), `scripts/check-foreign-sprints.mjs`, `scripts/sandbox-deploy.mjs`, `tests/sandbox-deploy.test.ts`, `deploy.md`, `integ-test-playbook.md`, `regression-test-playbook.md`, `.github/workflows/ci.yml`, `packages/apra-fleet-se/test/supervisor-api*.test.mjs`, `packages/apra-fleet-se/test/auth*.test.mjs` | branch exists | 10 | 1 |
| 1 | V05-S2 (W0-b) | fleet-win1 | Smallest shell: `GET /ui` serves the React/Vite shell (from disk in dev, from the SEA asset store in the binary) with one page listing real members via `GET /api/fleet/members`; establishes `src/console/` seams | `src/services/http-transport.ts` (one branch before the `/mcp` guard, 137), `src/console/server.ts`, `src/console/local-api.ts`, `src/console/routes/fleet.ts`, `src/console/static.ts`, `scripts/gen-sea-config.mjs`, `tests/gen-sea-config.test.ts`, `tests/console-server.test.ts`, root `package.json` (workspaces + `build:ui`), `packages/apra-fleet-ui-kit/**`, `packages/apra-fleet-shell-ui/**` | S0 merged to main + production redeployed (Windows Deploy phase); UI paste seeded (s5 D1) | 10 | 1 |
| 1 | V05-S3 (W0-c) | fleet-mac1 | Client C1 wrappers + subpath exports + `beads/normalize.mjs` (C3 part) + F3 OOB URL; `supervisor.sqlite` skeleton (`projects`, `member_git`, `schema_version`, migrations) + unmounted `/api/projects` route module | `packages/apra-fleet-client/{package.json,src/client/api.mjs,src/beads/normalize.mjs,docs/api-reference.md,test/*}`, `src/tools/credential-store-set.ts`, `src/services/auth-socket.ts`, `tests/credential-store-set.test.ts`, `packages/apra-fleet-se/src/projects/store/{db.mjs,migrations/001-projects.mjs,projects.mjs,member-git.mjs}`, `packages/apra-fleet-se/src/projects/routes/projects.mjs`, `packages/apra-fleet-se/test/projects-*.test.mjs` | branch exists | 12 | 1/2 |
| 2 | V05-S4 | fleet-mac1 | Shell pages Fleet/Members (S1, W1), Secrets (S2), Health (S3) with drawer actions and the add-member wizard; `/api/fleet/*` 1:1 routes | `src/console/routes/fleet.ts` (extend), `src/console/local-api.ts` (extend), `tests/console-routes-fleet.test.ts`, `packages/apra-fleet-shell-ui/src/{pages/members,pages/secrets,pages/health,app/routes.tsx,api/fleet.ts}/**`, `packages/apra-fleet-ui-kit/src/{table,drawer,wizard,form}/**` | S2, S3 | 12 | 1 |
| 2 | V05-S5 | fleet-lin1 | Shell auth + workflow-package registry + `/ext/<id>/*` proxy (F13, C3 `auth/local-token.mjs`), compose_permissions denylist, config key | `packages/apra-fleet-client/src/auth/local-token.mjs`, `packages/apra-fleet-client/test/local-token.test.mjs`, `src/console/server.ts` (guard, cookie), `src/console/routes/workflow-packages.ts`, `src/console/proxy.ts`, `src/services/workflow-packages.ts`, `src/services/user-config.ts`, `src/tools/compose-permissions.ts`, `packages/apra-fleet-se/src/supervisor/auth.mjs` (import the shared helper), tests `tests/console-auth.test.ts`, `tests/console-workflow-packages.test.ts`, `tests/console-proxy.test.ts`, `tests/compose-permissions-denylist.test.ts`, `tests/user-config.test.ts` | S1, S2, S3 | 12 | 1 |
| 2 | V05-S6 | fleet-win1 | Server member fields F1a, `member_owner` F1 (format + reservedBy-held check; package `holds` consult comes in S7), `member_git_status` F2 (OS/shell-selected probes, `{checkout:null}`), client wrappers + parity | `src/types.ts`, `src/tools/{register-member,update-member,list-members,member-detail}.ts`, `src/tools/member-owner.ts`, `src/tools/member-git-status.ts`, `src/services/tool-registry.ts`, `src/services/git-config.ts`, tests `tests/member-owner.test.ts`, `tests/member-git-status.test.ts`, `tests/list-members.test.ts`, `tests/member-detail-repo-remote-url.test.ts`, `tests/register-member.test.ts`, `tests/update-member.test.ts`, `packages/apra-fleet-client/src/client/api.mjs`, `packages/apra-fleet-client/docs/api-reference.md`, `packages/apra-fleet-client/test/{client-server-typedef-parity,fleet-client-api}.test.mjs` | S3 | 12 | 2 |
| 3 | V05-S7 | fleet-lin1 | fleet-supervisor registration S8 (manifest, register/unregister, `holds`, `ownerRefs`), mount project routes + `/ui` placeholder in `serve.mjs`, shell nav from registry + iframe page (DQ-18), F1/`remove_member` consult `holds` (DQ-22) | `packages/apra-fleet-se/src/registration/{manifest.mjs,register.mjs,holds.mjs,owner-refs.mjs}`, `packages/apra-fleet-se/bin/serve.mjs`, `packages/apra-fleet-se/test/registration*.test.mjs`, `packages/apra-fleet-shell-ui/src/{shell/nav.tsx,shell/packages.ts,pages/ext.tsx,app/routes.tsx}`, `src/tools/member-owner.ts`, `src/tools/remove-member.ts`, `src/console/routes/workflow-packages.ts` (ownerRefs validation), tests `tests/member-owner-holds.test.ts`, `tests/remove-member-decomm.test.ts` | S5, S6 | 10 | 2 |
| 3 | V05-S8 | fleet-mac1 | Project domain: bind/unbind (owner tag + `env.BEADS_DIR` + git probe cache), add-checkout flow, health panel checks, git drawer JSON, `apra-fleet supervisor export/import` (S9 projects, S7 projects/member_git) | `packages/apra-fleet-se/src/projects/{projects.mjs,health.mjs,checkout.mjs,routes/projects.mjs,routes/git.mjs,store/migrations/002-member-git.mjs,store/member-git.mjs}`, `packages/apra-fleet-se/bin/se.mjs`, `packages/apra-fleet-se/test/projects-*.test.mjs`, `packages/apra-fleet-se/test/se-export-import.test.mjs` | S3, S6 | 12 | 2 |
| 3 | V05-S9 | fleet-win1 | F14 `member.env` injection at the three dispatch sites (shell-selected builder), `update_member {env}`, F7 `reservedBy {runId,pid,at}` + dead-pid reaping, F12 `owner_ref` refusal, client typedefs | `src/utils/env-prefix.ts`, `src/utils/auth-env.ts`, `src/tools/execute-command.ts`, `src/tools/execute-prompt.ts`, `src/tools/update-member.ts`, `src/tools/member-reservation.ts`, `src/tools/list-members.ts`, `src/types.ts`, tests `tests/env-prefix.test.ts`, `tests/execute-command.test.ts`, `tests/execute-command-long-running-windows.test.ts`, `tests/execute-prompt-shell-matrix.test.ts`, `tests/member-reservation.test.ts`, `tests/update-member.test.ts`, `packages/apra-fleet-client/src/client/api.mjs`, `packages/apra-fleet-client/test/*` | S6 | 12 | 3/5 |
| 4 | V05-S10 | fleet-win1 | fleet-supervisor UI bundle v1 (`packages/apra-fleet-se/ui/`): Projects list (S4), Project Overview (S5/W2), Git drawer panel (S10/W3); served at `/ui/*` from the installed tree | `packages/apra-fleet-se/ui/**`, `packages/apra-fleet-se/package.json` (build:ui, devDeps), `packages/apra-fleet-se/src/supervisor/static.mjs` (new, mounted via the S7 placeholder hook), `packages/apra-fleet-se/test/ui-static.test.mjs` | S7, S8, S4 (ui-kit) | 12 | 2 |
| 4 | V05-S11 | fleet-lin1 | Backlog: `beads/client.mjs` (the ONE `bd` abstraction, `clone` impl over `execute_command` on the backlog member, allowlisted verbs, D-push under the mutex), backlog routes (tree, ready/blocked, `repo:` filter, create with group picker, retag, close/defer/reprioritise/reparent, pull/push); supervisor `backlog.mjs` reads via the client's normalize | `packages/apra-fleet-se/src/projects/beads/{client.mjs,clone.mjs,verbs.mjs}`, `packages/apra-fleet-se/src/projects/routes/backlog.mjs`, `packages/apra-fleet-se/src/supervisor/backlog.mjs` (import swap), `packages/apra-fleet-se/test/beads-client*.test.mjs`, `packages/apra-fleet-se/test/backlog-routes.test.mjs` | S3, S8, S9 | 12 | 3 |
| 4 | V05-S12 | fleet-mac1 | Land PR 485: supervisor as OS service (launchd/systemd/schtasks) via generalised ServiceManager, `install --workflows all` stages the se tree incl. `ui/dist`, uninstall unregisters; deploy.md `## Deploy` covers both processes | `src/services/service-manager/{index,linux,macos,windows,types}.ts`, `src/cli/{install,uninstall,status,workflow-assets}.ts`, `tests/service-manager.test.ts`, `tests/install-service.test.ts`, `tests/install-workflows.test.ts`, `tests/uninstall.test.ts`, `deploy.md` (Deploy + Smoke test sections) | S7 | 10 | 2 |
| 5 | V05-S13 | fleet-lin1 | Sprint definition + roleMap + ready (F11; S7 sprints/role_assignments/transitions): define, manifest labels, group derivation, roles validation (owner tag, checkout rule DQ-27a, orchestrator fixed), availability, ready (400 `no-members-assigned`, DQ-15 untagged), hold/order, launchDefaults | `packages/apra-fleet-se/src/projects/{sprints.mjs,routes/sprints.mjs,store/migrations/003-sprints.mjs,store/sprints.mjs,store/role-assignments.mjs}`, `packages/apra-fleet-se/test/sprints-*.test.mjs` | S11 | 12 | 3 |
| 5 | V05-S14 | fleet-win1 | KB/Code server side: F4 `kb_demote`, F5 `code_index_status`, C2 client wrappers (16 kb + 7 code + 2 new), fleet-supervisor `routes/kb.mjs`, `routes/code.mjs` pass-through keyed by the live origin | `src/tools/kb-demote.ts`, `src/tools/code-index-status.ts`, `src/services/tool-registry.ts`, `src/services/knowledge/{kb-service,sqlite-provider,types}.ts`, tests `tests/knowledge/kb-demote.test.ts`, `tests/code-index-status.test.ts`, `packages/apra-fleet-client/src/client/api.mjs`, `packages/apra-fleet-client/docs/api-reference.md`, `packages/apra-fleet-client/test/*`, `packages/apra-fleet-se/src/projects/routes/{kb,code}.mjs`, `packages/apra-fleet-se/test/kb-code-routes.test.mjs` | S8, S9 | 12 | 4 |
| 5 | V05-S15 | fleet-mac1 | Backlog UI (S6, W4): tree, filters incl. checkout group, row actions, proposal cards with drag in/out, define/edit/delete proposal (Mark ready lands in S16) | `packages/apra-fleet-se/ui/src/{pages/backlog/**,api/backlog.ts}`, `packages/apra-fleet-ui-kit/src/{tree,dnd}/**` | S10, S11 | 10 | 3 |
| 6 | V05-S16 | fleet-mac1 | Sprints UI (S7, W5 stack + W6 roleMap editor): availability chips, per-group base/branch, Mark ready with server refusals surfaced, hold/order | `packages/apra-fleet-se/ui/src/{pages/sprints/**,api/sprints.ts}` | S13, S15 | 12 | 3 |
| 6 | V05-S17 | fleet-win1 | KB + Code UI (S8, S9): one KB tab per checkout group + all, store actions, bible export/import labelled with member/branch/commit/dirty, bible-in-sync panel, Code page (status/reindex any member; query/impact/map local members), member drawer Code panel | `packages/apra-fleet-se/ui/src/{pages/kb/**,pages/code/**,panels/code.tsx,api/kb.ts,api/code.ts}` | S14, S10 | 12 | 4 |
| 6 | V05-S18 | fleet-lin1 | Engine takes launch data (S4, S6): `--repo-label` scope gate, `--beads-dir` + `--beads-remote` arguments with env-mismatch refusal, spawner `env` per launch, `roleMap.orchestrator` injected by the supervisor and hard-fail in the runner when absent, planner given the label vocabulary as data; boundary check stays green | `packages/apra-fleet-se/fleet-sprint/{beads-scope.mjs,sprint-args.mjs,runner.js,dolt-sync.mjs,git-topology.mjs,prompts.mjs,phases/plan.mjs}`, `packages/apra-fleet-se/bin/cli.mjs`, `packages/apra-fleet-se/src/supervisor/{spawner.mjs,api.mjs}`, `packages/apra-fleet-se/bin/serve.mjs`, `packages/apra-fleet-se/apra-pm/agents/planner.md`, `packages/apra-fleet-se/test/{spawner,supervisor-api,beads-scope-extraction,dolt-sync-*,repo-label*}.test.mjs` | S9, S13 | 12 | 5 |
| 7 | V05-S19 | fleet-lin1 | Ledger/history/allocator/mutex -> `supervisor.sqlite` behind the existing interfaces (S7 runs/history/events/stats/mutex_holder/child_id_marks/pending_launch), first-start migration of the JSON files, one supervisor instance per project at `/p/<id>/api/*` (S2), readopt unchanged | `packages/apra-fleet-se/src/supervisor/{ledger.mjs,history.mjs,id-allocator.mjs,dolt-mutex.mjs,server.mjs,api.mjs}`, `packages/apra-fleet-se/src/projects/store/{migrations/004-runs.mjs,runs.mjs,history.mjs,migrate-json.mjs}`, `packages/apra-fleet-se/bin/serve.mjs`, `packages/apra-fleet-se/test/{ledger,history,supervisor-readopt,id-allocator,dolt-mutex,store-migrate-json}*.test.mjs` | S18 | 12 | 5 |
| 7 | V05-S20 | fleet-win1 | 4v8r: per-sprint viewer binds loopback and requires the token on POST; supervisor live proxy forwards it; runner gets the token from the spawner env; playbook + SEA-on-Windows regression of `/ui` | `packages/apra-fleet-workflow/src/viewer/index.mjs`, `packages/apra-fleet-se/src/supervisor/proxy.mjs`, `packages/apra-fleet-se/fleet-sprint/viewer-extensions.mjs`, `packages/apra-fleet-se/test/{viewer-auth,proxy-token}*.test.mjs`, `regression-test-playbook.md` | S18 | 8 | 5 |
| 7 | V05-S21 | fleet-mac1 | Sprints UI runs: run rows per group, live viewer iframe, pause/stop/abort/hold/release/order, joint verdict, history and stats pages, honest "fleet-supervisor offline" state | `packages/apra-fleet-se/ui/src/{pages/sprints/runs/**,pages/history/**,pages/stats/**,api/runs.ts}` | S16 | 10 | 5 |
| 8 | V05-S22 | fleet-lin1 | Scheduler: tick, partition by originSlug, one run per group, launch guard (owner 409, F11, re-probe), pendingLaunch TTL, `waiting` with per-member reasons, reservation via runner with `owner_ref`, release on pause/finish, transitions, joint verdict, cross-group `blocks` flag, S3 sprint discovery | `packages/apra-fleet-se/src/supervisor/{scheduler.mjs,api.mjs,watchdog.mjs}`, `packages/apra-fleet-se/src/projects/{sprints.mjs,partition.mjs}`, `packages/apra-fleet-se/bin/serve.mjs`, `packages/apra-fleet-se/test/{scheduler,partition,launch-guard,waiting-reasons}*.test.mjs` | S19, S20 | 12 | 5 |
| 8 | V05-S23 | fleet-win1 | Retire `dashboard.mjs` HTML (redirect to the bundle, keep `/state` `/events` JSON), sandbox-deploy starts both processes with registration, regression playbook full-console scenario, README/docs | `packages/apra-fleet-se/src/supervisor/{dashboard.mjs,launch-form.mjs,history-view.mjs,log-view.mjs}`, `packages/apra-fleet-se/test/supervisor-dashboard.test.mjs`, `scripts/sandbox-deploy.mjs`, `tests/sandbox-deploy.test.ts`, `regression-test-playbook.md`, `integ-test-playbook.md`, `README.md`, `docs/console.md` | S19, S21 | 10 | 5 |
| 8 | V05-S24 | fleet-mac1 | Groomer review page (inc. 6, MVP M3 content): run backlog-groomer through `execute_prompt` on a code-role member, persist suggestions, accept/reject on proposal cards | `packages/apra-fleet-se/src/projects/{groomer.mjs,routes/groomer.mjs,store/migrations/005-groomer.mjs}`, `packages/apra-fleet-se/ui/src/pages/backlog/groomer/**`, `packages/apra-fleet-se/test/groomer*.test.mjs` | S15, S16 | 10 | 6 |
| 9 | V05-S25 | fleet-lin1 | Doctor + notify + backup: stalled -> pause_for_human/page, usage-limit pause/resume re-reserve, email, nightly `VACUUM INTO` + `bd backup`, stats roll-ups | `packages/apra-fleet-se/src/supervisor/{doctor.mjs,watchdog.mjs}`, `packages/apra-fleet-se/src/projects/{backup.mjs,stats.mjs}`, `packages/apra-fleet-se/test/{doctor,backup,stats}*.test.mjs` | S22 | 10 | 6 |
| 9 | V05-S26 | fleet-mac1 | macOS end-to-end: full regression run against the branch, fixes limited to `ui/` and docs, user guide | `docs/console.md`, `docs/architecture.md`, `README.md`, `packages/apra-fleet-se/ui/**` | S23, S24 | 8 | hard |
| 9 | V05-S27 | fleet-win1 | Windows end-to-end: SEA binary `install --workflows all`, both services, `/ui` from SEA, export/import round-trip, Windows regression run; fixes limited to `src/cli`, `src/os`, `scripts/` | `src/cli/**`, `src/os/**`, `scripts/{gen-sea-config,package-sea,sandbox-deploy}.mjs`, `tests/{install*,sea-http-verify,gen-sea-config}.test.ts` | S23 | 8 | hard |

Wave dependency check: every prereq is in an earlier wave; inside a wave no two sprints list the
same file. `bin/serve.mjs` owners by wave: S7 (3), S18 (6), S19 (7), S22 (8). `src/console/server.ts`:
S2 (1), S5 (2). Client `api.mjs`: S3 (1), S6 (2), S9 (3), S14 (5). `src/types.ts`: S6 (2), S9 (3).
`deploy.md`: S1 (1), S12 (4). `regression-test-playbook.md`: S1 (1), S20 (7), S23 (8).

Per-sprint OS rationale is in the sprint headers of s3.

---

## 3. Per-sprint DAGs

Column legend: type epic/feature/task; tier cheap/standard/premium; est in hours. Every sprint
has one epic `V05-S<n>-E1` (the launch `issue`), features group tasks, tasks are the work
units. "test" names the file to extend (existing) or create (new). Design refs use the doc ids.

### V05-S0 -- wave 0, fleet-win1, branch `fix/v05-s0-win-dispatch-pipe-stall` off `main`

Why fleet-win1: both bugs reproduce only on a Windows member (am7w tags windows/stall; 0cil tags
windows/stall-detector); the fix must be verified where it fails. Why `main`: the fix protects
every later fleet-win1 sprint's Deploy phase and is unrelated to the console; after merge the
owner redeploys the production apra-fleet server (deploy.md `## Deploy`) and merges `main` into
`v0.5_dashboard`. Risk: this sprint's own Deploy phase may hit am7w once; maxCycles 3 bounds it.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S0-E1 | epic | - | Windows dispatch pipe and stall detector (am7w, 0cil) | Deploy dispatches on Windows members never complete because sandbox grandchildren inherit the dispatch stdout pipe; the stall detector then fails to fire on the frozen transcript. Fix both on main so every Windows doer can finish a sprint unattended. | Deploy dispatch on a Windows member returns when claude.exe exits even if a detached grandchild survives; stall detector fires within threshold+poll on a frozen transcript with null-timestamp tail | see tasks | - | - | 8 |
| V05-S0-F1 | feature | V05-S0-E1 | Detach grandchildren from the dispatch channel (am7w) | The long_running wrapper and the sync path on Windows must launch children with stdio not inherited from the `claude | tee` channel (`execute-command.ts` 259-353, `windows-wrapper.ts`). | wrapper script redirects child stdio to files/NUL; a spawned `sleep`-like grandchild does not pin the dispatch; regression test reproduces the pin and passes | `tests/execute-command-long-running-windows.test.ts` (extend) | - | - | 5 |
| V05-S0-T1 | task | V05-S0-F1 | Reproduce the pinned channel in a unit test | Add a test that spawns a wrapper with a surviving grandchild and asserts the dispatch promise resolves at parent exit (decode with `decodePowerShellEncodedCommand`, `tests/test-helpers.ts:17`). | test fails on origin/main, passes after fix | `tests/execute-command-long-running-windows.test.ts` | - | standard | 2 |
| V05-S0-T2 | task | V05-S0-F1 | Redirect grandchild stdio in the Windows wrapper | Change `generateTaskWrapperWindows` / `wrapPowerShellEncoded` usage (`execute-command.ts:286-316`) so children start with `-RedirectStandardOutput`/`NUL` handles and `Win32_Process.Create` no inherited handles; keep POSIX path (`nohup`, 318-334) unchanged. | T1 passes; `tests/tools-windows-command-safety.test.ts` still green | `tests/execute-command-long-running-windows.test.ts` | V05-S0-T1 | premium | 3 |
| V05-S0-F2 | feature | V05-S0-E1 | Stall detector fires on frozen transcript (0cil) | `stall-detector.ts` ~475/495: a tail truncated at a null-timestamp entry returns "no signal" instead of "stale"; fix the classification and its poller path. | frozen transcript 57 min past 1800 s threshold is classified stalled within one poll; no false kill on a live transcript (`stall-no-signal-false-kill` stays green) | `tests/stall-detector.test.ts`, `tests/stall-no-signal-false-kill.test.ts` (extend) | - | - | 3 |
| V05-S0-T3 | task | V05-S0-F2 | Fix null-timestamp tail truncation classification | Unit-test the tail read with a null-timestamp last entry, fix `read-log-tail.ts` / `stall-detector.ts` so the last dated entry decides staleness. | new test fails before, passes after; existing stall suites green | `tests/stall-detector.test.ts` | - | standard | 3 |

### V05-S1 (W0-a) -- wave 1, fleet-lin1, branch `feat/v05-s1-groundwork` off `v0.5_dashboard`

Why fleet-lin1: playbooks, CI yaml and the PR 493 merge are OS-neutral; the sandbox lifecycle
tests (`tests/sandbox-deploy.test.ts`) are the ones CI runs on ubuntu first. Note: for T4-T7 the
companion analyst names the exact edits; this plan fixes the sprint boundary and acceptance.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S1-E1 | epic | - | Groundwork for the v0.5 console branch | Land the bearer/loopback supervisor (PR 493) with the shared `fleet.key` token, fix the playbook curls (hzb2), forward `sync` through the launch API (tbup), and prepare deploy.md, both test playbooks, sandbox-deploy.mjs and ci.yml for a repo that now contains React/Vite workspace packages. Every later sprint builds and deploys through these files. | `npm test` green on the branch; regression playbook runs to completion with the guard on; ci.yml builds UI workspaces when present and passes with none present | see tasks | - | - | 10 |
| V05-S1-F1 | feature | V05-S1-E1 | PR 493 on the branch with fleet.key as token (DQ-20, S1 gap) | Merge `origin/fix/m0-s1-loopback-bearer` into the sprint branch; switch the token source in `auth.mjs` to `~/.apra-fleet/fleet.key` (`src/services/jwt.ts:6`); keep 50j6.6 (`GET /` hands out the token) closed by not serving the token on `/`. | supervisor binds 127.0.0.1 (`server.mjs:358` gets a host); `/api/*` and `POST /sprints/:id/live/*` 401 without bearer/cookie; token read from fleet.key; PR 493 tests green | `packages/apra-fleet-se/test/auth*.test.mjs`, `supervisor-api.test.mjs` | - | - | 4 |
| V05-S1-T1 | task | V05-S1-F1 | Merge PR 493 and resolve conflicts against def08eba | `git merge origin/fix/m0-s1-loopback-bearer`; resolve; keep `check-foreign-sprints.mjs` and `sandbox-deploy.mjs` auth-aware paths. | merge commit on branch; all PR 493 tests pass | existing PR 493 tests | - | standard | 2 |
| V05-S1-T2 | task | V05-S1-F1 | Token source = fleet.key; `/` never returns the token | One-line source switch plus a test that `GET /` body does not contain the token (50j6.6). | test asserts no token on `/`; 401 on `/api/health` without auth | `packages/apra-fleet-se/test/auth-token-source.test.mjs` (new) | V05-S1-T1 | standard | 2 |
| V05-S1-F2 | feature | V05-S1-E1 | Playbook curls carry the bearer (hzb2, 50j6.5) | Every `curl` in deploy.md, integ-test-playbook.md, regression-test-playbook.md against 8787 reads the token from `~/.apra-fleet/fleet.key` (path resolved per OS, no `$VAR` in member-bound strings: use `cat`/`Get-Content` inline examples per shell). | regression playbook Setup/Teardown succeed against a guarded supervisor; `tests/regression-playbook-*` guards green | `tests/regression-playbook-sandbox-lifecycle.test.ts` (extend) | V05-S1-F1 | - | 1.5 |
| V05-S1-T3 | task | V05-S1-F2 | Rewrite playbook curls with bearer per shell | Edit the three playbooks; keep sections in the documented contract (`check-generic-boundary.mjs` TARGET_FILE_CONTRACT 62-66). | grep finds no unauthenticated `curl .*8787` in playbooks | `tests/regression-playbook-sandbox-lifecycle.test.ts` | V05-S1-T2 | cheap | 1.5 |
| V05-S1-F3 | feature | V05-S1-E1 | `sync` via the launch API (tbup) | `api.mjs launch()` (488-599) forwards `body.sync` (bool) to `spawner.launch` as `extraArgs: ['--sync']` (`spawner.mjs:244,252`); documented in the fleet-supervisor skill table. | POST with `"sync": true` produces `--sync` in the recorded argv; absent -> absent | `packages/apra-fleet-se/test/supervisor-api.test.mjs` (extend, recordingSpawner 48-71) | V05-S1-T1 | - | 1 |
| V05-S1-T4 | task | V05-S1-F3 | Forward sync to extraArgs + test | as F3 | as F3 | `supervisor-api.test.mjs` | V05-S1-T1 | cheap | 1 |
| V05-S1-F4 | feature | V05-S1-E1 | Playbooks and sandbox for the UI shell (edits per companion analyst) | deploy.md `## Deploy`/`## Smoke test` for the integration branch (build incl. UI workspaces, smoke `GET /ui` and `GET /api/fleet/members` with bearer, tolerate a missing UI dist before S2 merges); integ/regression playbooks gain the console checks; `sandbox-deploy.mjs verify/smoke` probe `/ui` when present. | sandbox `up` + `smoke` pass on a branch without the UI package and on one with it; `tests/sandbox-deploy.test.ts` extended | `tests/sandbox-deploy.test.ts` | V05-S1-F2 | - | 2.5 |
| V05-S1-T5 | task | V05-S1-F4 | deploy.md + playbook sections | as named by the companion analyst | sections present; boundary heading check green | `packages/apra-fleet-se/test/generic-boundary-guard.test.mjs` (fixture only) | V05-S1-T3 | standard | 1 |
| V05-S1-T6 | task | V05-S1-F4 | sandbox-deploy.mjs `/ui` smoke, optional | `smoke()` (487) adds a `/ui` probe gated on the dist dir existing; `verify()` unchanged. | unit test for both branches | `tests/sandbox-deploy.test.ts` | V05-S1-T5 | standard | 1.5 |
| V05-S1-F5 | feature | V05-S1-E1 | CI builds UI workspaces when present | ci.yml adds `npm run build:ui --workspaces --if-present` after `npm run build` and before `npm test`; pack-size check unaffected (UI dist is not in `files`); apra-fleet-se boundary test stays wired via `npm test`. | ci.yml passes on the branch before and after S2/S10 merge; no new matrix job | `.github/workflows/ci.yml` (validated by a workflow_dispatch run) | V05-S1-T6 | - | 1 |
| V05-S1-T7 | task | V05-S1-F5 | ci.yml step + pack-size guard note | as F5 | as F5 | CI run | V05-S1-T6 | cheap | 1 |

### V05-S2 (W0-b) -- wave 1, fleet-win1, branch `feat/v05-s2-ui-shell-members` off `v0.5_dashboard`

Why fleet-win1: the shell must be served from the SEA asset store (`gen-sea-config.mjs`
`collectPackageTree` 69-77, `sea.getAsset` reads as in `src/cli/install.ts:108-116`) and the owner
runs the binary on Windows; Windows path/`\` handling in asset keys is the risk. Depends on S0
being merged and the production server redeployed so this member's Deploy phase completes.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S2-E1 | epic | - | `/ui` serves a shell listing real members | The apra-fleet server serves a React/Vite shell at `/ui` (S1 screen, minimal W1 table) reading `GET /api/fleet/members` (in-process `list_members`, json). Establishes `src/console/` with per-file route modules so later sprints add files, not edits. | `apra-fleet run` from `dist/` and from the SEA binary both answer `GET /ui` 200 with the shell and `/api/fleet/members` with the registry; `npm test` green | see tasks | - | - | 10 |
| V05-S2-F1 | feature | V05-S2-E1 | UI packages seeded (DQ-2, DQ-6) | Create `packages/apra-fleet-ui-kit` (tokens, primitives) and `packages/apra-fleet-shell-ui` (Vite React TS SPA, `base: '/ui/'`) as workspaces; content = the owner-seeded paste of the dashboard's generic layer (s5 D1) or, if not seeded, a fresh minimal kit written to the wireframes. | `npm run build:ui --workspaces --if-present` emits `packages/apra-fleet-shell-ui/dist/index.html`; ASCII-only; no cloud/tenant/auth-provider code | `packages/apra-fleet-shell-ui/test/app.test.tsx` (vitest, new) | - | - | 3 |
| V05-S2-T1 | task | V05-S2-F1 | Workspace packages + build scripts | root `package.json` workspaces + `build:ui`; per-package `package.json`, vite config, vitest config; ui-kit exports a Table and a Page shell. | build succeeds on Windows and Linux CI | `packages/apra-fleet-shell-ui/test/app.test.tsx` | - | standard | 3 |
| V05-S2-F2 | feature | V05-S2-E1 | Console seam in the apra-fleet server | `src/console/server.ts` exports `handleConsoleRequest(req,res): Promise<boolean>`; `http-transport.ts` calls it before the `/mcp` guard (137-140); `server.ts` registers route modules from `src/console/routes/*.ts` via a list; `local-api.ts` calls tool handlers in-process (the `wrapTool` shape, `tool-registry.ts:95-117`); `static.ts` serves the dist from disk when present else from SEA assets under the `ui/` namespace. | `GET /ui` and `/ui/<asset>` 200; unknown `/ui/x` falls back to index.html; `/api/fleet/members` returns `list_members` json; `/mcp` behaviour unchanged (`tests/http-transport.test.ts` green) | `tests/console-server.test.ts` (new) | V05-S2-F1 | - | 5 |
| V05-S2-T2 | task | V05-S2-F2 | `server.ts` + route-module registration + `local-api.ts` | as F2; the members route lives in `routes/fleet.ts` (S4 extends this file, S5 owns `server.ts`). | route added by appending to `routes/fleet.ts` only | `tests/console-server.test.ts` | V05-S2-T1 | premium | 3 |
| V05-S2-T3 | task | V05-S2-F2 | Static serving from disk and from SEA | `static.ts` with MIME map, path traversal guard, index fallback; asset key normalisation to `/` on Windows. | traversal test; SEA-mode test using a fake `getAsset` | `tests/console-server.test.ts` | V05-S2-T2 | standard | 2 |
| V05-S2-F3 | feature | V05-S2-E1 | Shell dist in the SEA manifest | `gen-sea-config.mjs`: new `ui` section via `collectPackageTree('packages/apra-fleet-shell-ui/dist','ui')`, added to the manifest (205-218) and the assets loop (232-284); skipped with a warning when dist is absent. | `tests/gen-sea-config.test.ts` covers present/absent dist; `npm run build:binary` on Windows produces a binary whose `apra-fleet run` serves `/ui` | `tests/gen-sea-config.test.ts` (extend), `tests/sea-http-verify.test.ts` (extend) | V05-S2-F2 | - | 2 |
| V05-S2-T4 | task | V05-S2-F3 | Manifest section + tests | as F3 | as F3 | `tests/gen-sea-config.test.ts` | V05-S2-T3 | standard | 2 |

### V05-S3 (W0-c) -- wave 1, fleet-mac1, branch `feat/v05-s3-client-and-store` off `v0.5_dashboard`

Why fleet-mac1: pure ESM/TS, no OS-specific code; it proves `node:sqlite` on the macOS system
Node the supervisor service will use (PR 485 assumption, doc s4.3), which no other sprint checks.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S3-E1 | epic | - | Client catch-up and supervisor.sqlite skeleton | Client gains C1 wrappers, subpath exports, `beads/normalize.mjs`, `memberReservation` docs and F3's OOB URL result; the fleet-supervisor gains the `node:sqlite` store (`projects`, `member_git`, `schema_version`, migrations) and an unmounted `/api/projects` route module (S7 mounts it). | client test suite green incl. parity; store tests green on macOS/Linux/Windows CI; `POST/GET/PUT/DELETE /api/projects` pass via `handleRequest` mocks | see tasks | - | - | 12 |
| V05-S3-F1 | feature | V05-S3-E1 | C1 wrappers + exports + docs | `api.mjs` adds `revokeVcsAuth`, `setupGitApp`, `updateLlmCli`, `monitorTask`, `stopPrompt`, `version`, `kbSetup` (tool names per `tool-registry.ts:140-241`); `package.json` exports gain `./auth/*`, `./beads/*`, `./registration/*` -> `./src/<dir>/*.mjs`; `docs/api-reference.md` documents them and `memberReservation`. | every new method has a `fleet-client-api.test.mjs` case; api-reference lists all 32 methods | `packages/apra-fleet-client/test/fleet-client-api.test.mjs` (extend) | - | - | 3 |
| V05-S3-T1 | task | V05-S3-F1 | Wrappers + tests + docs | as F1 | as F1 | `fleet-client-api.test.mjs` | - | cheap | 2 |
| V05-S3-T2 | task | V05-S3-F1 | Subpath exports + `beads/normalize.mjs` | Copy the pure helpers `parentIdOf`, `normalizeBead`, `buildChildIndex`, `expandScopeInMemory`, `buildBacklogTree` (`backlog.mjs:55-222`) into the client with tests; `backlog.mjs` untouched until S11 swaps the import. | helper tests pass; `import '@apralabs/apra-fleet-client/beads/normalize'` resolves | `packages/apra-fleet-client/test/beads-normalize.test.mjs` (new) | V05-S3-T1 | cheap | 1 |
| V05-S3-F2 | feature | V05-S3-E1 | F3: OOB URL returned when not a TTY | `credential-store-set.ts` (24-37) / `collectOobApiKey` in `auth-socket.ts` return `{url, expiresAt}` in `structuredContent` instead of blocking when stdin is not a TTY or `return_url: true` is passed; the browser flow (`auth-web.ts:118-224`) unchanged. | tool returns the URL without waiting; secret stored once the form is submitted; client typedef `CredentialStoreSetResult` added | `tests/credential-store-set.test.ts` (extend) | - | - | 3 |
| V05-S3-T3 | task | V05-S3-F2 | Tool + service change + client typedef | as F2 | as F2 | `tests/credential-store-set.test.ts` | V05-S3-T1 | standard | 3 |
| V05-S3-F3 | feature | V05-S3-E1 | supervisor.sqlite store skeleton (S7 inc. 2 part) | `src/projects/store/db.mjs`: open `~/.apra-fleet-se/supervisor.sqlite` (honour `FLEET_SE_DATA_DIR` like `ledger.mjs:173-180`), WAL, `PRAGMA foreign_keys=ON`, `schema_version`, ordered migrations; `001-projects.mjs` creates `projects` and `member_git` per doc s4.3; repositories `projects.mjs`, `member-git.mjs`. | CRUD round-trips; migration idempotent on reopen; FK violation rejected; skips cleanly on Node without `node:sqlite` with a clear error | `packages/apra-fleet-se/test/projects-store.test.mjs` (new) | - | - | 4 |
| V05-S3-T4 | task | V05-S3-F3 | db.mjs + migration runner | as F3 | as F3 | `projects-store.test.mjs` | - | premium | 2 |
| V05-S3-T5 | task | V05-S3-F3 | projects + member_git repositories | as F3 | as F3 | `projects-store.test.mjs` | V05-S3-T4 | standard | 2 |
| V05-S3-F4 | feature | V05-S3-E1 | `/api/projects` route module (S9 projects, S4 screen) | `routes/projects.mjs` exports `registerProjectRoutes(supervisor, {store, client})` using the `route()` table (`server.mjs:181-188`); create validates `{id, name, backlogMember, beads:{kind:'clone',dir,remote,prefix}, operator}` and `git ls-remote <remote> refs/dolt/data` via `executeCommand` on the backlog member (DQ-12). Not mounted in `serve.mjs` yet. | mock-driven tests for 201/400/404/409; validation error shape `{field, reason}` | `packages/apra-fleet-se/test/projects-routes.test.mjs` (new, mockReq/mockRes pattern of `supervisor-api.test.mjs:74-86`) | V05-S3-F3 | - | 2 |
| V05-S3-T6 | task | V05-S3-F4 | Routes + validation + tests | as F4 | as F4 | `projects-routes.test.mjs` | V05-S3-T5 | standard | 2 |

### V05-S4 -- wave 2, fleet-mac1, branch `feat/v05-s4-shell-pages` off `v0.5_dashboard`

Why fleet-mac1: React pages and 1:1 TS routes, OS-neutral; keeps win1 on the shell-dependent
Windows tool work (S6) and lin1 on auth/proxy (S5).

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S4-E1 | epic | - | Shell pages: Members, Secrets, Health (inc. 1) | Complete W1 (members table, drawer with provision/setup/compose/remove, add-member wizard local/SSH), S2 Secrets (list/set via OOB URL/update/delete/setupGitApp), S3 Health (fleetStatus, version, "no workflow packages registered" until S5/S7). | every S1/S2/S3 action in doc s3.1 maps to a `/api/fleet/*` route and a UI control; UI tests cover table, drawer, wizard, secrets, health; routes tested via `handleConsoleRequest` | see tasks | - | - | 12 |
| V05-S4-F1 | feature | V05-S4-E1 | `/api/fleet/*` routes 1:1 with the client API | `routes/fleet.ts` adds detail/register/update/remove/setupSshKey/provisionLlmAuth/provisionVcsAuth/revokeVcsAuth/composePermissions/updateLlmCli/credentialStore{Set,List,Update,Delete}/setupGitApp/fleetStatus/version/executeCommand; bodies are the client option shapes. | each route has a test with a stubbed handler; errors map to 4xx with tool error text | `tests/console-routes-fleet.test.ts` (new) | - | - | 4 |
| V05-S4-T1 | task | V05-S4-F1 | Routes + local-api facade methods | as F1 | as F1 | `tests/console-routes-fleet.test.ts` | - | standard | 4 |
| V05-S4-F2 | feature | V05-S4-E1 | Members page + drawer + wizard (S1, W1) | Table columns per W1 (owner column shows `owner` when present, `(none)` otherwise); drawer actions; wizard (local or SSH remote; shell/provider/tiers); background refresh from cache (risk 2). | UI tests: renders W1 rows from fixture json; wizard submits `registerMember` shape; drawer buttons call the routes | `packages/apra-fleet-shell-ui/test/members.test.tsx` (new) | V05-S4-F1 | - | 5 |
| V05-S4-T2 | task | V05-S4-F2 | Members table + drawer | as F2 | as F2 | `members.test.tsx` | V05-S4-T1 | standard | 3 |
| V05-S4-T3 | task | V05-S4-F2 | Add-member wizard + ui-kit wizard/form primitives | as F2 | as F2 | `members.test.tsx`, `packages/apra-fleet-ui-kit/test/wizard.test.tsx` (new) | V05-S4-T2 | standard | 2 |
| V05-S4-F3 | feature | V05-S4-E1 | Secrets and Health pages (S2, S3) | Secrets: list, "add" opens the F3 URL in a new tab, update policy/members/expiry, delete; Health: version, data dir, update-available, packages list placeholder reading `GET /api/workflow-packages` (404-tolerant until S5). | UI tests for both pages; secret values never appear in any payload | `packages/apra-fleet-shell-ui/test/{secrets,health}.test.tsx` (new) | V05-S4-F1 | - | 3 |
| V05-S4-T4 | task | V05-S4-F3 | Secrets + Health pages | as F3 | as F3 | `secrets.test.tsx`, `health.test.tsx` | V05-S4-T1 | standard | 3 |

### V05-S5 -- wave 2, fleet-lin1, branch `feat/v05-s5-auth-registry-proxy` off `v0.5_dashboard`

Why fleet-lin1: HTTP guard, SSE proxy and JSON registry are OS-neutral server code; the streaming
proxy tests are easiest to keep deterministic on Linux CI.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S5-E1 | epic | - | One token, package registry, proxy (F13, C3, s4.4) | Lift PR 493's guard into `apra-fleet-client/src/auth/local-token.mjs` (token = `~/.apra-fleet/fleet.key`), guard `/api/*` and mutating `/ext/*` in the apra-fleet server, set the cookie on `GET /ui`, add the workflow-package registry routes and `<data>/workflow-packages.json`, the `/ext/<id>/*` reverse proxy with SSE and cookie forward, the compose_permissions denylist, and a `workflowPackages` config key (DQ-28 option d compatible). | unauthenticated `/api/fleet/*` -> 401, cookie or bearer -> 200; register/list/unregister round-trip; proxied SSE stream delivers events end-to-end in a test; supervisor `auth.mjs` imports the shared helper | see tasks | - | - | 12 |
| V05-S5-F1 | feature | V05-S5-E1 | Shared local-token helper (C3) | `local-token.mjs`: `readLocalToken()`, `requiresAuth(url)`, `guard(req)` (bearer or cookie), `cookieFor(token)`; supervisor `auth.mjs` becomes a thin re-export. | client tests for bearer/cookie/percent-encoded paths (50j6.10); supervisor auth tests still green | `packages/apra-fleet-client/test/local-token.test.mjs` (new) | - | - | 3 |
| V05-S5-T1 | task | V05-S5-F1 | Helper + tests + supervisor re-export | as F1 | as F1 | `local-token.test.mjs`, `packages/apra-fleet-se/test/auth*.test.mjs` | - | standard | 3 |
| V05-S5-F2 | feature | V05-S5-E1 | Guard in the apra-fleet server console | `server.ts`: `localTokenGuard` on `/api/*` and on non-GET `/ext/*`; `GET /ui` sets the cookie (HttpOnly, SameSite=Strict, Path=/); `/health` and `/mcp` untouched. | tests: 401/200 matrix; `/mcp` unaffected | `tests/console-auth.test.ts` (new) | V05-S5-F1 | - | 2 |
| V05-S5-T2 | task | V05-S5-F2 | Guard + cookie | as F2 | as F2 | `tests/console-auth.test.ts` | V05-S5-T1 | standard | 2 |
| V05-S5-F3 | feature | V05-S5-E1 | Workflow-package registry (F13) | `src/services/workflow-packages.ts` (atomic tmp+rename, `workflow-packages.json`); routes `POST /api/workflow-packages/register`, `DELETE /api/workflow-packages/:id`, `GET /api/workflow-packages` (with health poll result, greyed after 10 min failures, `apraFleetApi` semver check against `version.json`); static entries from `user-config.ts` key `workflowPackages: [{id, baseUrl}]` (no default). | register with an incompatible range -> 409; list shows health state; config entries merge | `tests/console-workflow-packages.test.ts`, `tests/user-config.test.ts` (extend) | V05-S5-F2 | - | 3 |
| V05-S5-T3 | task | V05-S5-F3 | Registry service + routes + config key | as F3 | as F3 | `tests/console-workflow-packages.test.ts` | V05-S5-T2 | standard | 3 |
| V05-S5-F4 | feature | V05-S5-E1 | `/ext/<id>/*` reverse proxy with SSE | `proxy.ts`: streams request/response bodies, forwards the cookie as bearer, rewrites `Location`, passes `text/event-stream` unbuffered, 502 body says "package offline" (risk 4). | SSE test with a local upstream delivering 3 events; 502 shape test; large body streaming test | `tests/console-proxy.test.ts` (new) | V05-S5-F3 | - | 3 |
| V05-S5-T4 | task | V05-S5-F4 | Proxy implementation + tests | as F4 | as F4 | `tests/console-proxy.test.ts` | V05-S5-T3 | premium | 3 |
| V05-S5-F5 | feature | V05-S5-E1 | compose_permissions denylist for console endpoints | `NEVER_AUTO_GRANT_PATTERNS` (63-75) gains `Bash(*127.0.0.1:8787*)`, `Bash(*localhost:8787*)`, `Bash(*:7523/ui*)`, `Bash(*:7523/api*)`, `Bash(*:7523/ext*)`. | denylist test covers the five | `tests/compose-permissions-denylist.test.ts` (extend) | - | - | 1 |
| V05-S5-T5 | task | V05-S5-F5 | Denylist entries + test | as F5 | as F5 | `tests/compose-permissions-denylist.test.ts` | - | cheap | 1 |

### V05-S6 -- wave 2, fleet-win1, branch `feat/v05-s6-member-owner-git-status` off `v0.5_dashboard`

Why fleet-win1: `member_git_status` builds git probe commands for pwsh7/powershell5/gitbash
members (`wrapPowerShellEncoded`, `src/os/windows.ts:41-45`); path and quoting rules on Windows
are the failure mode; tests decode the EncodedCommand (`tests/test-helpers.ts:17`).

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S6-E1 | epic | - | Member owner tag, env map, git status (F1, F1a, F2) | Registry record gains `owner {package, ref}`, `env {}` (name-validated, size-capped, DQ-23), `llmAuthExpiresAt`; `list_members`/`member_detail` emit `modelTiers, shell, vcsTokenExpiresAt, reservedBy, unreservable, owner, env`; new tools `member_owner` and `member_git_status`; client wrappers and typedef parity. | parity test green with the three typedefs extended; `member_git_status` returns `{checkout:null}` for a non-git folder and the full shape for a checkout on posix and Windows command builders; `member_owner set` refused with `member-held` while `reservedBy` is set | see tasks | - | - | 12 |
| V05-S6-F1 | feature | V05-S6-E1 | F1a fields and emission | `types.ts` Agent (6-69) + register/update schemas + list (118-121) + detail (33-52). No project/repo/group fields. | both json shapes carry the fields; compact output unchanged except an `owner=` chip | `tests/list-members.test.ts`, `tests/member-detail-repo-remote-url.test.ts`, `tests/register-member.test.ts`, `tests/update-member.test.ts` (extend) | - | - | 3 |
| V05-S6-T1 | task | V05-S6-F1 | Fields, schemas, emission, tests | as F1 | as F1 | as F1 | - | standard | 3 |
| V05-S6-F2 | feature | V05-S6-E1 | `member_owner` tool (F1) | `src/tools/member-owner.ts` `{member, action: set|clear, package?, ref?}`; refuses `member-held` when `reservedBy` is set (package `holds` consult added in S7); `register_member {owner}` accepted. | tests for set/clear/held/invalid | `tests/member-owner.test.ts` (new) | V05-S6-F1 | - | 2 |
| V05-S6-T2 | task | V05-S6-F2 | Tool + registration + tests | as F2 | as F2 | `tests/member-owner.test.ts` | V05-S6-T1 | standard | 2 |
| V05-S6-F3 | feature | V05-S6-E1 | `member_git_status` tool (F2) | Probe sequence (`git rev-parse --is-inside-work-tree`, `git status --porcelain=v2 --branch`, `git worktree list --porcelain`, `git remote get-url origin`, playbook `ls`, bible `git log -1 --format=%H -- .fleet/kb-canonical.json`) built per OS/shell via the existing execute path; derives `originSlug` (normalised host+path). | shape per doc s5 F2; Windows builder decoded in tests; non-git -> `{checkout:null}`; slug derivation table test (ssh/https/.git suffix) | `tests/member-git-status.test.ts` (new) | V05-S6-F1 | - | 5 |
| V05-S6-T3 | task | V05-S6-F3 | Probe builders + parser + slug | as F3 | as F3 | `tests/member-git-status.test.ts` | V05-S6-T1 | premium | 3 |
| V05-S6-T4 | task | V05-S6-F3 | Tool + registration + integration test on the local member | as F3 | as F3 | `tests/member-git-status.test.ts` | V05-S6-T3 | standard | 2 |
| V05-S6-F4 | feature | V05-S6-E1 | Client wrappers + parity | `memberOwner`, `memberGitStatus` methods; `RegisterMemberOptions`/`UpdateMemberOptions`/`MemberDetailResult` typedefs extended; api-reference rows. | parity test green; api tests for both | `packages/apra-fleet-client/test/{client-server-typedef-parity,fleet-client-api}.test.mjs` | V05-S6-F3 | - | 2 |
| V05-S6-T5 | task | V05-S6-F4 | Wrappers + typedefs + docs | as F4 | as F4 | as F4 | V05-S6-T4 | cheap | 2 |

### V05-S7 -- wave 3, fleet-lin1, branch `feat/v05-s7-registration` off `v0.5_dashboard`

Why fleet-lin1: registration handshake and nav rendering are OS-neutral; keeps mac1 on the
project domain and win1 on the dispatch env work.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S7-E1 | epic | - | fleet-supervisor registers as workflow package `se` (S8, DQ-28) | On start the supervisor POSTs the manifest (`apra-fleet/workflow-package@1`, doc s4.1) with the local token, serves `/api/health`, `/api/owner-refs`, `/api/members/:id/holds`, mounts the S3 project routes and a `/ui/*` placeholder; the shell renders registered nav entries and the iframe page; `member_owner`/`remove_member` consult `holds` (DQ-22). | shell nav shows "Projects" after the supervisor starts and greys it when health fails; `member_owner clear` on a member with a live reservation or non-finished assignment -> 409 `member-held`; unregister on clean shutdown | see tasks | - | - | 10 |
| V05-S7-F1 | feature | V05-S7-E1 | Registration module | `src/registration/{manifest,register,holds,owner-refs}.mjs`; `serve.mjs` calls `register()` after `supervisor.start()` (472) and `unregister()` in `stop`; retries with backoff when the apra-fleet server is down; version from `package.json`. | tests with a stub apra-fleet server: register/unregister/retry | `packages/apra-fleet-se/test/registration.test.mjs` (new) | - | - | 4 |
| V05-S7-T1 | task | V05-S7-F1 | Manifest + register/unregister + serve.mjs wiring | as F1 | as F1 | `registration.test.mjs` | - | standard | 3 |
| V05-S7-T2 | task | V05-S7-F1 | `holds` and `owner-refs` routes | `GET /api/owner-refs` lists project ids/names; `GET /api/members/:id/holds` reports live reservation (ledger) or non-finished assignment (store, empty until S13). | route tests | `registration.test.mjs` | V05-S7-T1 | standard | 1 |
| V05-S7-F2 | feature | V05-S7-E1 | Mount project routes + `/ui` placeholder | `serve.mjs` registers `registerProjectRoutes` (S3) with the store and an `ApraFleet` client; `/ui/*` serves a static dir hook (`static.mjs` added in S10; here a 200 placeholder page). | `GET /api/projects` reachable via `/ext/se/api/projects` through the shell proxy | `packages/apra-fleet-se/test/serve-mount.test.mjs` (new) | V05-S7-F1 | - | 2 |
| V05-S7-T3 | task | V05-S7-F2 | Mount + smoke test | as F2 | as F2 | `serve-mount.test.mjs` | V05-S7-T1 | standard | 2 |
| V05-S7-F3 | feature | V05-S7-E1 | Shell nav from the registry + iframe page (DQ-18) | `shell/packages.ts` polls `GET /api/workflow-packages`; `nav.tsx` adds entries with `scope: project` shown only when a project is selected; `pages/ext.tsx` iframe at `/ext/<id><path>` with `postMessage` deep-link mirroring; offline chip. | UI tests: nav renders from fixture, offline state, deep link round-trip | `packages/apra-fleet-shell-ui/test/nav.test.tsx` (new) | V05-S7-F2 | - | 3 |
| V05-S7-T4 | task | V05-S7-F3 | Nav + iframe page | as F3 | as F3 | `nav.test.tsx` | V05-S7-T3 | standard | 3 |
| V05-S7-F4 | feature | V05-S7-E1 | `holds` consult in `member_owner` and `remove_member` (DQ-22) | Both tools call every registered package's `holds` route (via `workflow-packages.ts`) and refuse `member-held`; `ownerRefs` validates `ref` on set. | tests with a stub registry | `tests/member-owner-holds.test.ts` (new), `tests/remove-member-decomm.test.ts` (extend) | V05-S7-F1 | - | 1 |
| V05-S7-T5 | task | V05-S7-F4 | Holds/ownerRefs consult + tests | as F4 | as F4 | as F4 | V05-S7-T2 | standard | 1 |

### V05-S8 -- wave 3, fleet-mac1, branch `feat/v05-s8-project-bind-health` off `v0.5_dashboard`

Why fleet-mac1: domain logic over the client, OS-neutral; the "add checkout" flow issues `git
clone` and `bd bootstrap` through `execute_command`, so the OS branching already lives in the
server (S6/S9), not here.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S8-E1 | epic | - | Project overview domain (S5 screen, W2; S9 projects) | Bind = `memberOwner set` + `updateMember {env: {BEADS_DIR}}` (env write lands in S9; here the call is made and a 4xx tolerated with a health warning) + `memberGitStatus` cached in `member_git`; unbind; add-checkout; health panel; git drawer JSON; export/import CLI. | all W2 rows derivable from `GET /api/projects/:id/overview`; health checks in doc s3.1 S5 implemented with unit tests; `apra-fleet supervisor export/import` round-trips | see tasks | - | - | 12 |
| V05-S8-F1 | feature | V05-S8-E1 | Bind / unbind / probe cache | `projects.mjs bind(project, member)`; `member_git` upsert with `probed_at`; `POST /api/projects/:id/members` and `DELETE`; grouping by `origin_slug` plus "no checkout". | tests with a fake client: bind writes owner+env+cache; 409 propagation from `member-held` | `packages/apra-fleet-se/test/projects-bind.test.mjs` (new) | - | - | 4 |
| V05-S8-T1 | task | V05-S8-F1 | bind/unbind + overview route | as F1 | as F1 | `projects-bind.test.mjs` | - | standard | 4 |
| V05-S8-F2 | feature | V05-S8-E1 | Add checkout on machine (DQ-16 names) | `checkout.mjs`: suggest name `<project>-<machine>-<origin-short>`, `registerMember` copied from a sibling, `executeCommand git clone`, `bd -C <dir> bootstrap` against `beads.remote`, optional `provision*`/`composePermissions`; each step idempotent (A10). | step list returned with per-step status; re-run is a no-op; command strings contain no `$VAR`/`~` (guard test) | `packages/apra-fleet-se/test/projects-checkout.test.mjs` (new) | V05-S8-F1 | - | 3 |
| V05-S8-T2 | task | V05-S8-F2 | Checkout flow + idempotency tests | as F2 | as F2 | `projects-checkout.test.mjs` | V05-S8-T1 | standard | 3 |
| V05-S8-F3 | feature | V05-S8-E1 | Health panel + git drawer | `health.mjs`: `refs/dolt/data` reachable, every group has a code-role-capable member, bible in sync per group, `env.BEADS_DIR` clone `sync.remote == beads.remote`, dirty/VCS-expiry warnings; `routes/git.mjs` returns the S10 drawer model ("no git checkout" when null). | each check unit-tested OK/WARN/FAIL | `packages/apra-fleet-se/test/projects-health.test.mjs` (new) | V05-S8-F1 | - | 3 |
| V05-S8-T3 | task | V05-S8-F3 | Health checks + git drawer route | as F3 | as F3 | `projects-health.test.mjs` | V05-S8-T1 | standard | 3 |
| V05-S8-F4 | feature | V05-S8-E1 | `apra-fleet supervisor export/import` (DQ-3) | `bin/se.mjs export <id> [--with-history]` / `import <file>` (upsert; refuses a project with live runs). | round-trip test; refusal test | `packages/apra-fleet-se/test/se-export-import.test.mjs` (new) | V05-S8-F1 | - | 2 |
| V05-S8-T4 | task | V05-S8-F4 | CLI + tests | as F4 | as F4 | `se-export-import.test.mjs` | V05-S8-T1 | cheap | 2 |

### V05-S9 -- wave 3, fleet-win1, branch `feat/v05-s9-member-env-reservation` off `v0.5_dashboard`

Why fleet-win1: env injection into `powershell -EncodedCommand` wrappers and the long_running
Windows wrapper (`execute-command.ts:286-316`) is exactly the class of bug CLAUDE.md warns about;
must be exercised on a real pwsh member.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S9-E1 | epic | - | Dispatch env map and reservation objects (F14, F7, F12) | `member.env` injected at the three dispatch sites via a shell-selected builder generalised from `auth-env.ts`; `update_member {env}`; `reservedBy` becomes `{runId, pid, at}` with dead-pid reaping; `member_reservation reserve {owner_ref}` refuses `member_other_owner`. | shell matrix tests show `export`/`$env:` prefixes for env on posix/pwsh incl. long_running; reservation object round-trips through `list_members`; stale pid reaped on the next `list_members`/`reserve` | see tasks | - | - | 12 |
| V05-S9-F1 | feature | V05-S9-E1 | `env-prefix.ts` builder + injection | `buildEnvPrefix(agent, os, extra)` merges auth env and `member.env` (values resolved in JS, escaped per shell); used at `execute-command.ts:356` (sync), the long_running wrapper generators (286-334) and `execute-prompt.ts:901` (+4 retry sites). | matrix test per site; `shell-command-guard`-style assertion that no `$VAR` reaches a member string | `tests/env-prefix.test.ts` (new), `tests/execute-command.test.ts`, `tests/execute-command-long-running-windows.test.ts`, `tests/execute-prompt-shell-matrix.test.ts` (extend) | - | - | 5 |
| V05-S9-T1 | task | V05-S9-F1 | Builder + auth-env refactor | as F1 | as F1 | `tests/env-prefix.test.ts` | - | premium | 2 |
| V05-S9-T2 | task | V05-S9-F1 | Inject at three sites + matrix tests | as F1 | as F1 | the three extended suites | V05-S9-T1 | standard | 3 |
| V05-S9-F2 | feature | V05-S9-E1 | `update_member {env}` | Schema (20-73) gains `env` (object, names `^[A-Z_][A-Z0-9_]*$`, <= 32 keys, <= 4 KiB); only an owning package's caller may set it when `owner` is present (caller passes `owner_ref`). | tests: set/clear/validate/refuse | `tests/update-member.test.ts` (extend) | V05-S9-F1 | - | 2 |
| V05-S9-T3 | task | V05-S9-F2 | Schema + apply + tests + client typedef | as F2 | as F2 | `tests/update-member.test.ts`, client parity | V05-S9-T2 | standard | 2 |
| V05-S9-F3 | feature | V05-S9-E1 | Reservation object + reaping + owner_ref (F7, F12) | `member-reservation.ts`: `reserve {member, run_id, pid, owner_ref?}` writes `{runId,pid,at}`; `release`/`force_release` unchanged semantics; dead pid (via `pid-helpers.ts`) reaped lazily; `owner_ref` mismatch -> `member_other_owner`; `list_members` emits the object; runner call sites (`member-provisioning.mjs`/`coordination.mjs`) keep working through the client wrapper (string `reservedBy` accepted as legacy on read). | outcome union extended and tested; e2e test `member-reservation-e2e` green | `tests/member-reservation.test.ts`, `tests/member-reservation-e2e.test.ts` (extend) | V05-S9-F2 | - | 5 |
| V05-S9-T4 | task | V05-S9-F3 | Reservation object + reaping | as F3 | as F3 | `tests/member-reservation.test.ts` | V05-S9-T3 | premium | 3 |
| V05-S9-T5 | task | V05-S9-F3 | owner_ref refusal + client wrapper options + docs | as F3 | as F3 | `packages/apra-fleet-client/test/fleet-client-api.test.mjs` | V05-S9-T4 | cheap | 2 |

### V05-S10 -- wave 4, fleet-win1, branch `feat/v05-s10-se-ui-projects` off `v0.5_dashboard`

Why fleet-win1: the bundle is served from disk by the supervisor installed under the owner's
Windows profile (`install --workflows all` staging, S12); resolving `ui/dist` relative to the
installed tree and Windows path separators is the risk. React code itself is OS-neutral.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S10-E1 | epic | - | fleet-supervisor UI bundle v1: Projects, Overview, Git panel (S4, S5/W2, S10/W3) | Vite React SPA in `packages/apra-fleet-se/ui/` depending on the ui-kit workspace sibling, `base: '/ui/'`, served by `static.mjs` at `/ui/*` (and `/ui/panels/git` for the member-drawer slot); pages call `/api/projects*` same-origin (through the shell proxy when framed). | W2 renders from fixture data; create project form validates and shows the `git ls-remote` result; bind/unbind/add-checkout buttons call the routes; W3 drawer shows both checkout and no-checkout variants; `npm run build:ui -w @apralabs/apra-fleet-se` output served by the supervisor | see tasks | - | - | 12 |
| V05-S10-F1 | feature | V05-S10-E1 | Package scaffold + static serving | `ui/package.json`, vite/vitest config, `packages/apra-fleet-se/package.json` script `build:ui`; `src/supervisor/static.mjs` mounted via the S7 hook, index fallback, MIME map, no traversal. | build + serve tests | `packages/apra-fleet-se/test/ui-static.test.mjs` (new) | - | - | 3 |
| V05-S10-T1 | task | V05-S10-F1 | Scaffold + static.mjs | as F1 | as F1 | `ui-static.test.mjs` | - | standard | 3 |
| V05-S10-F2 | feature | V05-S10-E1 | Projects list + create (S4) | List with backlog member, member count, groups, ready sprints; create form with `refs/dolt/data` validation feedback and the manual-steps text when the remote is missing (DQ-12). | UI tests | `packages/apra-fleet-se/ui/test/projects.test.tsx` (new) | V05-S10-F1 | - | 3 |
| V05-S10-T2 | task | V05-S10-F2 | Projects page | as F2 | as F2 | `projects.test.tsx` | V05-S10-T1 | standard | 3 |
| V05-S10-F3 | feature | V05-S10-E1 | Project Overview (W2) + health panel | Tabs, backlog-member panel with pull/push, members grouped by checkout group + "no checkout", bind/add-checkout actions, health rows OK/WARN. | UI tests from fixture matching W2 rows | `packages/apra-fleet-se/ui/test/overview.test.tsx` (new) | V05-S10-F2 | - | 4 |
| V05-S10-T3 | task | V05-S10-F3 | Overview page | as F3 | as F3 | `overview.test.tsx` | V05-S10-T2 | standard | 4 |
| V05-S10-F4 | feature | V05-S10-E1 | Git drawer panel (W3) | `/ui/panels/git?member=` page for the shell's `member.drawer` slot; register-worktree-as-member action. | both W3 variants tested | `packages/apra-fleet-se/ui/test/git-panel.test.tsx` (new) | V05-S10-F1 | - | 2 |
| V05-S10-T4 | task | V05-S10-F4 | Git panel | as F4 | as F4 | `git-panel.test.tsx` | V05-S10-T1 | standard | 2 |

### V05-S11 -- wave 4, fleet-lin1, branch `feat/v05-s11-beads-client-backlog` off `v0.5_dashboard`

Why fleet-lin1: the `bd` abstraction and D-push discipline are engine-adjacent, OS-neutral (every
`bd` runs on the backlog member through the server); Linux is where the real-bd integration
lane (`npm run test:integration`) is cheapest.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S11-E1 | epic | - | Backlog through one beads client (S9 backlog, S6 screen, DQ-26) | `beads/client.mjs` is the only source file issuing `bd` in the fleet-supervisor: interface `list/show/create/update/label/dep/close/sync`, `clone` impl over `executeCommand({member_name: backlogMember})` (BEADS_DIR arrives via `member.env`, S9), allowlisted verbs, D-push under `doltMutex`; backlog routes; supervisor `backlog.mjs` uses the client's normalize. | route tests cover every S6 action; allowlist rejects unknown verbs; push goes through the mutex; no `execBd*` call remains outside `beads/client.mjs` except `lib/exec-bd.mjs` users retired in S19 | see tasks | - | - | 12 |
| V05-S11-F1 | feature | V05-S11-E1 | `beads/client.mjs` + `clone` impl + verbs allowlist | as epic; `http` impl reserved as a stub throwing `not-implemented` with the same interface. | contract tests run against a fake executeCommand recording commands; every command string is Windows-safe (no expansion) | `packages/apra-fleet-se/test/beads-client.test.mjs` (new) | - | - | 5 |
| V05-S11-T1 | task | V05-S11-F1 | Interface + clone impl | as F1 | as F1 | `beads-client.test.mjs` | - | premium | 3 |
| V05-S11-T2 | task | V05-S11-F1 | Verb allowlist + mutexed push + normalize import swap in `backlog.mjs` | as F1 | as F1 | `beads-client.test.mjs`, `supervisor-dashboard.test.mjs` (green) | V05-S11-T1 | standard | 2 |
| V05-S11-F2 | feature | V05-S11-E1 | Backlog routes (S6) | `routes/backlog.mjs` under `/api/projects/:id/backlog`: tree with ready/blocked, filters (`repo:<slug>`, spans, untagged), create with `--label repo:<slug>` (default when one group), label add/remove, close/defer/reprioritise/reparent, pull/push status. | route tests with the fake client; W4 table rows reproducible from the tree endpoint | `packages/apra-fleet-se/test/backlog-routes.test.mjs` (new) | V05-S11-F1 | - | 5 |
| V05-S11-T3 | task | V05-S11-F2 | Read routes (tree, filters) | as F2 | as F2 | `backlog-routes.test.mjs` | V05-S11-T2 | standard | 2 |
| V05-S11-T4 | task | V05-S11-F2 | Mutating routes + sync | as F2 | as F2 | `backlog-routes.test.mjs` | V05-S11-T3 | standard | 3 |
| V05-S11-F3 | feature | V05-S11-E1 | Real-bd integration lane | One `test:integration` case: create/label/close on a temp clone through a real `bd`. | passes in `npm run test:integration -w @apralabs/apra-fleet-se` | `packages/apra-fleet-se/test/beads-client-real.test.mjs` (new) | V05-S11-F2 | - | 2 |
| V05-S11-T5 | task | V05-S11-F3 | Integration case | as F3 | as F3 | `beads-client-real.test.mjs` | V05-S11-T4 | standard | 2 |

### V05-S12 -- wave 4, fleet-mac1, branch `feat/v05-s12-supervisor-service` off `v0.5_dashboard`

Why fleet-mac1: PR 485's launchd registration is self-reported as unit-tested only; this sprint
verifies it on real macOS hardware (the brief's OS rule). Windows service registration is
re-verified in S27.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S12-E1 | epic | - | fleet-supervisor as an OS service (PR 485, s6 row "runs-forever") | Merge `origin/feat/fleet-supervisor-service-registration`; generalised ServiceManager with a `ServiceId`; `install --workflows all` stages the se tree incl. `ui/dist` and registers the service; `uninstall` stops and unregisters; deploy.md covers both processes and their smoke. | on macOS the LaunchAgent starts the supervisor which registers with the apra-fleet server (S7) and `/ui` shows "Projects"; unit tests for linux/windows managers green; `install-workflows` tests cover `ui/dist` staging | see tasks | - | - | 10 |
| V05-S12-F1 | feature | V05-S12-E1 | Land PR 485 on the branch | merge + conflict resolution against the S2/S5 console changes in `src/cli/install.ts`. | PR 485 tests green | `tests/service-manager.test.ts`, `tests/install-service.test.ts` | - | - | 3 |
| V05-S12-T1 | task | V05-S12-F1 | Merge + fix tests | as F1 | as F1 | as F1 | - | standard | 3 |
| V05-S12-F2 | feature | V05-S12-E1 | Stage `ui/dist` and the projects tree with the workflows install | `workflow-assets.ts` / `install.ts --workflows` copy `packages/apra-fleet-se/{ui/dist,src/projects,src/registration}` (SEA manifest extension in `gen-sea-config.mjs` is S27's re-verify; here from the npm tree). | `tests/install-workflows.test.ts` asserts the staged paths | `tests/install-workflows.test.ts` (extend) | V05-S12-F1 | - | 3 |
| V05-S12-T2 | task | V05-S12-F2 | Staging + tests | as F2 | as F2 | `tests/install-workflows.test.ts` | V05-S12-T1 | standard | 3 |
| V05-S12-F3 | feature | V05-S12-E1 | macOS real verification + deploy.md | LaunchAgent plist with the real node path (launchd PATH caveat), `RunAtLoad`, log paths; deploy.md `## Deploy` describes both services and `## Smoke test` checks `/api/health` of both plus the registration entry. | manual evidence in the sprint report: `launchctl list` shows the label and `/api/workflow-packages` lists `se` | `tests/service-manager.test.ts` (macos cases extended) | V05-S12-F2 | - | 4 |
| V05-S12-T3 | task | V05-S12-F3 | launchd verification + fixes | as F3 | as F3 | `tests/service-manager.test.ts` | V05-S12-T2 | standard | 3 |
| V05-S12-T4 | task | V05-S12-F3 | deploy.md Deploy/Smoke for two processes | as F3 | boundary heading contract kept | `generic-boundary-guard.test.mjs` | V05-S12-T3 | cheap | 1 |

### V05-S13 -- wave 5, fleet-lin1, branch `feat/v05-s13-sprint-definition-rolemap` off `v0.5_dashboard`

Why fleet-lin1: pure domain/state logic against the store and the beads client; continues the
lin1 backlog chain so the beads-client author context is reused.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S13-E1 | epic | - | Sprint definition, roleMap, ready (F11; S7 sprints tables; DQ-4, DQ-15, DQ-21, DQ-27a) | Tables `sprints`, `role_assignments`, `transitions`; define = epic bead + labels via the beads client; manifest = `sprint:<name>` labels; groups derived from assigned members' `member_git.origin_slug`; `POST .../roles` validates owner tag, checkout rule per role, orchestrator fixed to the backlog member; `GET .../availability`; `POST .../ready` refuses empty roleMap (400 `no-members-assigned`) and untagged tasks in a multi-group project; hold/release/order; launchDefaults per group from `member_git.upstream`. | state machine `open -> ready` covered by tests including every refusal in doc s2.3; W6 table reproducible from availability; transitions rows written | see tasks | - | - | 12 |
| V05-S13-F1 | feature | V05-S13-E1 | Store migration + sprint records | `003-sprints.mjs`; repositories with FK `role_assignments.sprint -> sprints`. | FK and upsert tests | `packages/apra-fleet-se/test/sprints-store.test.mjs` (new) | - | - | 2 |
| V05-S13-T1 | task | V05-S13-F1 | Migration + repositories | as F1 | as F1 | `sprints-store.test.mjs` | - | standard | 2 |
| V05-S13-F2 | feature | V05-S13-E1 | Define + manifest + groups | `sprints.mjs define()`, `addToManifest()`, `removeFromManifest()`, `groupsOf()`; routes. | tests with fake beads client and store | `packages/apra-fleet-se/test/sprints-define.test.mjs` (new) | V05-S13-F1 | - | 3 |
| V05-S13-T2 | task | V05-S13-F2 | Define/manifest/groups + routes | as F2 | as F2 | `sprints-define.test.mjs` | V05-S13-T1 | standard | 3 |
| V05-S13-F3 | feature | V05-S13-E1 | roleMap editor backend + availability | `POST .../roles` (400 `member-other-project`, `role-needs-checkout`, `orchestrator-not-assignable`), `GET .../availability` (free / assigned elsewhere / reserved by run) from `listMembers().reservedBy` + `role_assignments`. | every refusal tested; availability chip values per W6 | `packages/apra-fleet-se/test/sprints-roles.test.mjs` (new) | V05-S13-F2 | - | 4 |
| V05-S13-T3 | task | V05-S13-F3 | Roles validation | as F3 | as F3 | `sprints-roles.test.mjs` | V05-S13-T2 | premium | 2 |
| V05-S13-T4 | task | V05-S13-F3 | Availability + chips | as F3 | as F3 | `sprints-roles.test.mjs` | V05-S13-T3 | standard | 2 |
| V05-S13-F4 | feature | V05-S13-E1 | Ready, hold, order, launchDefaults | `POST .../ready` with the precondition list; `hold`/`release`; `PUT .../order`; `launchDefaults` per originSlug with majority upstream and an `ambiguous` flag. | tests for each precondition and for the ambiguous-base case | `packages/apra-fleet-se/test/sprints-ready.test.mjs` (new) | V05-S13-F3 | - | 3 |
| V05-S13-T5 | task | V05-S13-F4 | Ready/hold/order + tests | as F4 | as F4 | `sprints-ready.test.mjs` | V05-S13-T4 | standard | 3 |

### V05-S14 -- wave 5, fleet-win1, branch `feat/v05-s14-kb-code-server` off `v0.5_dashboard`

Why fleet-win1: `code_index_status` reads `<workFolder>/.gitnexus/meta.json` and `git rev-parse
HEAD` through `execute_command` on any member; Windows paths and PowerShell JSON output are the
risk; the KB provider is `node:sqlite` in the server (already covered by CI on Windows).

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S14-E1 | epic | - | KB and Code server side (F4, F5, C2; S8/S9 screens backend) | New tools `kb_demote {id, to, reason}` and `code_index_status {member}`; client wrappers for all 16 `kb_*` and 7 `code_*` tools plus the two new ones; fleet-supervisor `routes/kb.mjs` (per checkout group by live `repo_remote_url`) and `routes/code.mjs` (status/reindex any member; query/impact/map/context for local members only, DQ-8). | client method count = server tool count for kb/code (a new parity test); `kb_demote` lowers confidence with provenance; `code_index_status` on a member without an index returns `{present:false}`; routes tested with fakes | see tasks | - | - | 12 |
| V05-S14-F1 | feature | V05-S14-E1 | `kb_demote` (F4) | Service method in `kb-service.ts` mirroring `kb_promote`; tool + registration; invariants test (never below `unconfirmed`, records reason). | tests | `tests/knowledge/kb-demote.test.ts` (new) | - | - | 2 |
| V05-S14-T1 | task | V05-S14-F1 | Tool + service + tests | as F1 | as F1 | `tests/knowledge/kb-demote.test.ts` | - | standard | 2 |
| V05-S14-F2 | feature | V05-S14-E1 | `code_index_status` (F5) | Reads `meta.json` (nodes/edges/files/indexedAt/lastCommit) and `HEAD` through the OS-selected command; `commitsBehind` computed with `git rev-list --count`. | posix + Windows builders decoded in tests; absent index case | `tests/code-index-status.test.ts` (new) | - | - | 3 |
| V05-S14-T2 | task | V05-S14-F2 | Tool + tests | as F2 | as F2 | `tests/code-index-status.test.ts` | - | standard | 3 |
| V05-S14-F3 | feature | V05-S14-E1 | C2 client wrappers + kb/code parity test | 25 wrappers with typedefs; a parity test that scans `tool-registry.ts` for `kb_*`/`code_*` names and asserts a wrapper exists. | parity test green; api-reference rows | `packages/apra-fleet-client/test/kb-code-parity.test.mjs` (new), `fleet-client-api.test.mjs` (extend) | V05-S14-F1, V05-S14-F2 | - | 3 |
| V05-S14-T3 | task | V05-S14-F3 | Wrappers + parity + docs | as F3 | as F3 | as F3 | V05-S14-T2 | cheap | 3 |
| V05-S14-F4 | feature | V05-S14-E1 | fleet-supervisor KB and Code routes | `routes/kb.mjs`: stats/list/query/promote/demote/capture(supersedes)/invalidate/sweep/reconcile-prefilter/setup per group; bible export/import per member preceded by `memberGitStatus`; `routes/code.mjs`: status for every member, reindex via `executeCommand long_running` + `monitorTask`, query/impact/map/context only when the member is local. | route tests with fakes; remote member query -> 400 `local-only` | `packages/apra-fleet-se/test/kb-code-routes.test.mjs` (new) | V05-S14-F3 | - | 4 |
| V05-S14-T4 | task | V05-S14-F4 | KB routes | as F4 | as F4 | `kb-code-routes.test.mjs` | V05-S14-T3 | standard | 2 |
| V05-S14-T5 | task | V05-S14-F4 | Code routes | as F4 | as F4 | `kb-code-routes.test.mjs` | V05-S14-T4 | standard | 2 |

### V05-S15 -- wave 5, fleet-mac1, branch `feat/v05-s15-backlog-ui` off `v0.5_dashboard`

Why fleet-mac1: React only; continues the mac1 UI chain (S4, S10) so the kit conventions stay
with one author.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S15-E1 | epic | - | Backlog UI (S6, W4) | Header filters incl. group chips (all/per slug/spans/untagged count), tree with ready/blocked and group chip, row actions (view/close/defer/reprioritise/reparent/set group), proposal cards with drag in/out, new/edit/delete proposal; "Mark ready" button present but wired in S16. | W4 table reproducible; drag calls `label add/remove`; all actions hit the S11 routes | see tasks | - | - | 10 |
| V05-S15-F1 | feature | V05-S15-E1 | ui-kit tree and dnd primitives | `packages/apra-fleet-ui-kit/src/{tree,dnd}` with keyboard fallback. | kit tests | `packages/apra-fleet-ui-kit/test/{tree,dnd}.test.tsx` (new) | - | - | 3 |
| V05-S15-T1 | task | V05-S15-F1 | Primitives | as F1 | as F1 | as F1 | - | standard | 3 |
| V05-S15-F2 | feature | V05-S15-E1 | Backlog page | filters, tree, row actions, sync status line. | UI tests | `packages/apra-fleet-se/ui/test/backlog.test.tsx` (new) | V05-S15-F1 | - | 4 |
| V05-S15-T2 | task | V05-S15-F2 | Page + actions | as F2 | as F2 | `backlog.test.tsx` | V05-S15-T1 | standard | 4 |
| V05-S15-F3 | feature | V05-S15-E1 | Proposal cards | cards with groups, beads per group, cross-group blocks flag; define/edit/delete; drag targets. | UI tests | `packages/apra-fleet-se/ui/test/proposals.test.tsx` (new) | V05-S15-F2 | - | 3 |
| V05-S15-T3 | task | V05-S15-F3 | Cards + drag | as F3 | as F3 | `proposals.test.tsx` | V05-S15-T2 | standard | 3 |

### V05-S16 -- wave 6, fleet-mac1, branch `feat/v05-s16-sprints-ui` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S16-E1 | epic | - | Sprints UI: stack + roleMap editor (S7, W5, W6) | Stack sections RUNNING/READY/PROPOSED/DONE (run rows arrive in S21), roleMap editor with per-role pickers filtered by checkout rule, availability chips, orchestrator fixed row, per-group base/branch with the `ambiguous` prompt, Mark ready surfacing 400 reasons, hold/release, order up/down. | W5/W6 reproducible from fixtures; every refusal reason rendered verbatim | see tasks | - | - | 12 |
| V05-S16-F1 | feature | V05-S16-E1 | Stack page | as epic | UI tests | `packages/apra-fleet-se/ui/test/sprints-stack.test.tsx` (new) | - | - | 4 |
| V05-S16-T1 | task | V05-S16-F1 | Stack sections + hold/order | as F1 | as F1 | `sprints-stack.test.tsx` | - | standard | 4 |
| V05-S16-F2 | feature | V05-S16-E1 | roleMap editor | as epic | UI tests incl. greyed roles for checkout-less members | `packages/apra-fleet-se/ui/test/rolemap-editor.test.tsx` (new) | V05-S16-F1 | - | 6 |
| V05-S16-T2 | task | V05-S16-F2 | Editor pickers + chips | as F2 | as F2 | `rolemap-editor.test.tsx` | V05-S16-T1 | standard | 4 |
| V05-S16-T3 | task | V05-S16-F2 | Base/branch per group + Mark ready | as F2 | as F2 | `rolemap-editor.test.tsx` | V05-S16-T2 | standard | 2 |
| V05-S16-F3 | feature | V05-S16-E1 | Backlog "Mark ready" wiring | proposal card button calls `POST .../ready` and shows the result. | UI test | `packages/apra-fleet-se/ui/test/proposals.test.tsx` (extend) | V05-S16-F2 | - | 2 |
| V05-S16-T4 | task | V05-S16-F3 | Wire + test | as F3 | as F3 | `proposals.test.tsx` | V05-S16-T3 | cheap | 2 |

### V05-S17 -- wave 6, fleet-win1, branch `feat/v05-s17-kb-code-ui` off `v0.5_dashboard`

Why fleet-win1: the Code page's local-member queries run against a Windows checkout path on the
owner's box; verifying `repo:` path forms for `code_query` there is the risk.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S17-E1 | epic | - | KB and Code pages + Code drawer panel (S8, S9) | KB: one tab per checkout group + "all", list/filter/view/promote/demote/supersede/invalidate/stats/sweep, bible export/import labelled with member/branch/commit/dirty, "bible in sync" panel; Code: every member's index status, reindex (any), query/impact/map (local only), hidden for checkout-less members; `/ui/panels/code`. | every S8/S9 action reachable; remote member shows status+reindex only; bible actions name the member and commit first | see tasks | - | - | 12 |
| V05-S17-F1 | feature | V05-S17-E1 | KB page | as epic | UI tests | `packages/apra-fleet-se/ui/test/kb.test.tsx` (new) | - | - | 6 |
| V05-S17-T1 | task | V05-S17-F1 | Store tabs + actions | as F1 | as F1 | `kb.test.tsx` | - | standard | 4 |
| V05-S17-T2 | task | V05-S17-F1 | Bible panel + sync check | as F1 | as F1 | `kb.test.tsx` | V05-S17-T1 | standard | 2 |
| V05-S17-F2 | feature | V05-S17-E1 | Code page + panel | as epic | UI tests | `packages/apra-fleet-se/ui/test/code.test.tsx` (new) | - | - | 6 |
| V05-S17-T3 | task | V05-S17-F2 | Index table + reindex with monitor | as F2 | as F2 | `code.test.tsx` | - | standard | 3 |
| V05-S17-T4 | task | V05-S17-F2 | Query/impact/map views + drawer panel | as F2 | as F2 | `code.test.tsx` | V05-S17-T3 | standard | 3 |

### V05-S18 -- wave 6, fleet-lin1, branch `feat/v05-s18-engine-launch-data` off `v0.5_dashboard`

Why fleet-lin1: engine changes with the generic-boundary guard; the bd-record/replay suite runs
fastest on Linux and the real-bd lane is available there.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S18-E1 | epic | - | Engine consumes launch data (S4, S6; E-R1; DQ-14 prerequisites) | `--repo-label` gate in `discoverScope` (`beads-scope.mjs:329-336`); `--beads-dir`/`--beads-remote` args (`sprint-args.mjs`, `cli.mjs`, `spawner.buildSprintArgv` 202-253); runner refuses when `--beads-dir` disagrees with `process.env.BEADS_DIR`; `serve.mjs` passes `env` to `createSpawner` per launch (`BEADS_DIR`, `APRA_FLEET_PROJECT_ID`, token) built in JS from the project row; `api.launch` injects `roleMap.orchestrator = [project.backlogMember]` when a project is given; runner hard-fails on a missing orchestrator when launched with a project (legacy fallback kept otherwise, TODO at `runner.js:1310-1323`); `dolt-sync.mjs` prefers the launch beads remote over the member probe; planner prompt receives the label vocabulary as data (`{repoLabels: [...]}`) with generic wording. | `check-generic-boundary.mjs` green; argv snapshot tests; scope gate test with mixed labels; env mismatch refusal test; sync-remote precedence test; planner prompt renders the vocabulary only when given | see tasks | - | - | 12 |
| V05-S18-F1 | feature | V05-S18-E1 | `--repo-label` scope gate | as epic | tests | `packages/apra-fleet-se/test/beads-scope-extraction.test.mjs` (extend), `test/repo-label-scope.test.mjs` (new) | - | - | 3 |
| V05-S18-T1 | task | V05-S18-F1 | Gate + args + tests | as F1 | as F1 | as F1 | - | standard | 3 |
| V05-S18-F2 | feature | V05-S18-E1 | Beads dir/remote as launch data + spawner env | `--beads-dir`, `--beads-remote`, spawner `env`, mismatch refusal, dolt-sync precedence. | tests | `packages/apra-fleet-se/test/spawner.test.mjs`, `dolt-sync-configured-remote.test.mjs` (extend), `test/beads-dir-env-mismatch.test.mjs` (new) | V05-S18-F1 | - | 5 |
| V05-S18-T2 | task | V05-S18-F2 | Args + env + refusal | as F2 | as F2 | as F2 | V05-S18-T1 | premium | 3 |
| V05-S18-T3 | task | V05-S18-F2 | dolt-sync precedence + topology from launch data | `checkMemberTopology` keeps per-origin checks but takes the expected origin from launch data when present (`git-topology.mjs:172-187`). | tests | `packages/apra-fleet-se/test/dolt-sync-configured-remote.test.mjs`, `test/git-topology*.test.mjs` | V05-S18-T2 | standard | 2 |
| V05-S18-F3 | feature | V05-S18-E1 | Orchestrator injection + hard-fail; planner vocabulary | as epic | tests incl. the api recordingSpawner argv; boundary guard green | `packages/apra-fleet-se/test/supervisor-api.test.mjs` (extend), `test/orchestrator-hard-fail.test.mjs` (new), `test/generic-boundary-guard.test.mjs` | V05-S18-F2 | - | 4 |
| V05-S18-T4 | task | V05-S18-F3 | Inject + hard-fail | as F3 | as F3 | as F3 | V05-S18-T3 | premium | 2 |
| V05-S18-T5 | task | V05-S18-F3 | Planner vocabulary as data (prompts.mjs, planner.md) | Generic sentence: "tag every task with exactly one of the provided repo labels" only when the list is non-empty. | boundary guard green; prompt snapshot | `packages/apra-fleet-se/test/planner-prompt*.test.mjs` | V05-S18-T4 | standard | 2 |

### V05-S19 -- wave 7, fleet-lin1, branch `feat/v05-s19-sqlite-ledger-instances` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S19-E1 | epic | - | supervisor.sqlite behind ledger/history + per-project instances (S2, S7 runs/history) | `ledger.mjs` (interface 463-628) and `history.mjs` (229-301) get sqlite-backed implementations over `runs`, `transitions`, `events`, `stats`; `id-allocator.mjs` (`child_id_marks`, fixing its `~/.apra-fleet/supervisor` path divergence at 86-87) and `dolt-mutex.mjs` (`mutex_holder`) likewise; first-start migration renames `reservations.json`, `sprint-history.json`, `child-id-allocator.json` to `*.migrated-<date>`; `createSupervisor` takes a route prefix and `serve.mjs` mounts one instance per project row at `/p/<id>/api/*` plus the legacy root instance; readopt/watchdog untouched. | all existing ledger/history/readopt/watchdog tests pass on the sqlite implementation; migration test from fixture JSON; two projects mounted serve independent `/api/sprints` | see tasks | - | - | 12 |
| V05-S19-F1 | feature | V05-S19-E1 | sqlite ledger + history | as epic | existing suites green with the new store | `packages/apra-fleet-se/test/{ledger,history,supervisor-readopt}*.test.mjs` | - | - | 5 |
| V05-S19-T1 | task | V05-S19-F1 | Ledger over `runs` | as F1 | as F1 | as F1 | - | premium | 3 |
| V05-S19-T2 | task | V05-S19-F1 | History over `transitions`/`events`/`stats` | as F1 | as F1 | as F1 | V05-S19-T1 | standard | 2 |
| V05-S19-F2 | feature | V05-S19-E1 | Allocator + mutex tables + JSON migration | as epic | migration test; allocator path test | `packages/apra-fleet-se/test/{id-allocator,dolt-mutex}*.test.mjs`, `test/store-migrate-json.test.mjs` (new) | V05-S19-F1 | - | 3 |
| V05-S19-T3 | task | V05-S19-F2 | Tables + migration | as F2 | as F2 | as F2 | V05-S19-T2 | standard | 3 |
| V05-S19-F3 | feature | V05-S19-E1 | Per-project instances (DQ-1) | `createSupervisor({prefix})`, route tables prefixed (`server.mjs:174-215`), `serve.mjs` loop over `projects`; `/api/health` lists instances. | two-instance test | `packages/apra-fleet-se/test/serve-mount.test.mjs` (extend) | V05-S19-F2 | - | 4 |
| V05-S19-T4 | task | V05-S19-F3 | Prefix + mounting | as F3 | as F3 | `serve-mount.test.mjs` | V05-S19-T3 | premium | 4 |

### V05-S20 -- wave 7, fleet-win1, branch `feat/v05-s20-viewer-auth` off `v0.5_dashboard`

Why fleet-win1: the token reaches the viewer via the detached child's env on Windows (spawn
`env` + `Win32_Process`), the case doc s4.5 flags; also re-verifies `/ui` from the SEA on Windows
after the S12 install changes.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S20-E1 | epic | - | Per-sprint viewer bound to loopback with the token (4v8r, S1 viewer) | `viewer/index.mjs` `listen(port, '127.0.0.1')` (1597); `POST /stop|/pause|/resume|/save_logs` require bearer = `process.env.APRA_FLEET_LOCAL_TOKEN` (set by the spawner env, S18) or fall back to fleet.key read via the client helper; `proxy.mjs` forwards the supervisor's token; regression playbook viewer checks. | unauthenticated POST to the viewer -> 401; supervisor `POST /sprints/:id/live/stop` still works end-to-end; SEA binary on Windows serves `/ui` after `install --workflows all` | see tasks | - | - | 8 |
| V05-S20-F1 | feature | V05-S20-E1 | Viewer bind + guard | as epic | tests | `packages/apra-fleet-se/test/viewer-auth.test.mjs` (new; fixture `test/fixtures/dashboard/viewer-child.mjs`) | - | - | 4 |
| V05-S20-T1 | task | V05-S20-F1 | Bind + guard + tests | as F1 | as F1 | `viewer-auth.test.mjs` | - | standard | 4 |
| V05-S20-F2 | feature | V05-S20-E1 | Proxy token forward + playbook | as epic | proxy test; playbook curl lines updated | `packages/apra-fleet-se/test/proxy-token.test.mjs` (new) | V05-S20-F1 | - | 2 |
| V05-S20-T2 | task | V05-S20-F2 | Proxy + playbook | as F2 | as F2 | `proxy-token.test.mjs` | V05-S20-T1 | standard | 2 |
| V05-S20-F3 | feature | V05-S20-E1 | Windows SEA `/ui` regression | Build the binary on fleet-win1, `install --workflows all`, confirm `/ui`, `/ext/se/ui`, viewer guard; fixes limited to `gen-sea-config.mjs`/`static.ts` if any. | evidence in report; `tests/sea-http-verify.test.ts` extended for `/ui` | `tests/sea-http-verify.test.ts` (extend) | V05-S20-F2 | - | 2 |
| V05-S20-T3 | task | V05-S20-F3 | Verify + fix | as F3 | as F3 | `tests/sea-http-verify.test.ts` | V05-S20-T2 | standard | 2 |

### V05-S21 -- wave 7, fleet-mac1, branch `feat/v05-s21-sprints-ui-runs` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S21-E1 | epic | - | Sprints UI: runs, live viewer, controls, history, stats (S7 running/done; W5 rows S1a/S1b/S6/S7) | Run rows per checkout group with cycle/phase/reserved members, live viewer iframe at `/p/<id>/sprints/<run>/live`, pause/stop/abort per run, joint verdict, waiting reasons per member, DONE list with PR links and history log, stats page, honest "fleet-supervisor offline" and 502 states (risk 4). Consumes the route contract documented in doc s3.1 S7 and the existing `/api/sprints` shapes (`api.mjs:752-769`, `proxy.mjs:468-479`); S22 wires the scheduler-side routes to the same shapes. | fixtures for W5 render; controls call the live routes; offline state shown when `/ext/se` returns 502 | see tasks | - | - | 10 |
| V05-S21-F1 | feature | V05-S21-E1 | Run rows + controls + viewer iframe | as epic | UI tests | `packages/apra-fleet-se/ui/test/sprint-runs.test.tsx` (new) | - | - | 5 |
| V05-S21-T1 | task | V05-S21-F1 | Rows + controls | as F1 | as F1 | `sprint-runs.test.tsx` | - | standard | 3 |
| V05-S21-T2 | task | V05-S21-F1 | Viewer iframe + offline states | as F1 | as F1 | `sprint-runs.test.tsx` | V05-S21-T1 | standard | 2 |
| V05-S21-F2 | feature | V05-S21-E1 | History + stats pages | as epic | UI tests | `packages/apra-fleet-se/ui/test/history-stats.test.tsx` (new) | V05-S21-F1 | - | 5 |
| V05-S21-T3 | task | V05-S21-F2 | History page | as F2 | as F2 | `history-stats.test.tsx` | V05-S21-T2 | standard | 3 |
| V05-S21-T4 | task | V05-S21-F2 | Stats page | as F2 | as F2 | `history-stats.test.tsx` | V05-S21-T3 | cheap | 2 |

### V05-S22 -- wave 8, fleet-lin1, branch `feat/v05-s22-scheduler-runs-per-group` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S22-E1 | epic | - | Scheduler: N runs per sprint, reservations, waiting (inc. 5 core; S3 discovery; F11 enforcement; DQ-14) | Tick loop per project instance: discover `open`/`ready` sprint beads into `sprints` rows; for each `ready` sprint not on hold, re-probe assigned members' git status, partition non-orchestrator members by originSlug, attach checkout-less members by role to every run, launch guard (owner tag 409, F11, capacity, OS), `pendingLaunch` TTL, spawn one run per group with `--repo-label`, branch `<sprint>/<slug-short>`, `waiting` with `waitingReason {role, originSlug, rejected[]}`, release on pause/finish via the runner, transitions, joint verdict, cross-group `blocks` flag, per-run pause/stop/abort/hold routes at `/p/<id>/api/sprints/:id/...`. | state table in doc s2.3 covered transition by transition; two-group sprint spawns two runs with disjoint members and the same orchestrator; a reserved member yields `waiting` with the named reason and launches on release; joint verdict PASS only if all PASS | see tasks | - | - | 12 |
| V05-S22-F1 | feature | V05-S22-E1 | Discovery + partition | `partition.mjs`, discovery on start and tick. | tests | `packages/apra-fleet-se/test/{partition,sprint-discovery}.test.mjs` (new) | - | - | 3 |
| V05-S22-T1 | task | V05-S22-F1 | Partition + discovery | as F1 | as F1 | as F1 | - | standard | 3 |
| V05-S22-F2 | feature | V05-S22-E1 | Launch guard + waiting | as epic | tests for each rejection reason | `packages/apra-fleet-se/test/{launch-guard,waiting-reasons}.test.mjs` (new) | V05-S22-F1 | - | 4 |
| V05-S22-T2 | task | V05-S22-F2 | Guard + pendingLaunch | as F2 | as F2 | `launch-guard.test.mjs` | V05-S22-T1 | premium | 2 |
| V05-S22-T3 | task | V05-S22-F2 | Waiting reasons + release re-evaluation | as F2 | as F2 | `waiting-reasons.test.mjs` | V05-S22-T2 | standard | 2 |
| V05-S22-F3 | feature | V05-S22-E1 | Run lifecycle + joint verdict + controls | as epic | tests with recordingSpawner | `packages/apra-fleet-se/test/scheduler.test.mjs` (new), `supervisor-api.test.mjs` (extend) | V05-S22-F2 | - | 5 |
| V05-S22-T4 | task | V05-S22-F3 | Spawn per group + transitions | as F3 | as F3 | `scheduler.test.mjs` | V05-S22-T3 | premium | 3 |
| V05-S22-T5 | task | V05-S22-F3 | Joint verdict + per-run routes | as F3 | as F3 | `supervisor-api.test.mjs` | V05-S22-T4 | standard | 2 |

### V05-S23 -- wave 8, fleet-win1, branch `feat/v05-s23-retire-dashboard` off `v0.5_dashboard`

Why fleet-win1: the full-console regression runs against the owner's Windows deployment
(`sandbox-deploy.mjs` on Windows, both processes); this is where "deployed periodically so
progress is observable" is proven.

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S23-E1 | epic | - | Retire `dashboard.mjs`; full-stack sandbox and regression (inc. 5 last row) | `GET /` redirects to `/ui`; `/state` and `/events` stay as JSON/SSE for the bundle; `launch-form.mjs`/`history-view.mjs`/`log-view.mjs` HTML removed or reduced to JSON; `sandbox-deploy.mjs up` starts both processes and asserts the registration entry; regression playbook scenario walks shell -> project -> backlog -> sprint launch through the UI routes; docs. | `supervisor-dashboard.test.mjs` rewritten for the JSON routes; sandbox test asserts registration; playbook run passes on Windows | see tasks | - | - | 10 |
| V05-S23-F1 | feature | V05-S23-E1 | Dashboard routes retired | as epic | tests | `packages/apra-fleet-se/test/supervisor-dashboard.test.mjs` (rewrite) | - | - | 4 |
| V05-S23-T1 | task | V05-S23-F1 | Redirect + JSON-only views | as F1 | as F1 | as F1 | - | standard | 4 |
| V05-S23-F2 | feature | V05-S23-E1 | Sandbox both processes + regression scenario | as epic | tests + playbook | `tests/sandbox-deploy.test.ts` (extend), `tests/regression-playbook-sandbox-lifecycle.test.ts` | V05-S23-F1 | - | 4 |
| V05-S23-T2 | task | V05-S23-F2 | sandbox-deploy registration assert | as F2 | as F2 | `tests/sandbox-deploy.test.ts` | V05-S23-T1 | standard | 2 |
| V05-S23-T3 | task | V05-S23-F2 | Playbook console scenario | as F2 | as F2 | playbook run | V05-S23-T2 | standard | 2 |
| V05-S23-F3 | feature | V05-S23-E1 | Docs | `docs/console.md` (objects, screens, routes), README section, architecture note. | ASCII; llms-full regenerated by the hook | `tests/gen-llms-full.test.ts` | V05-S23-F2 | - | 2 |
| V05-S23-T4 | task | V05-S23-F3 | Write docs | as F3 | as F3 | as F3 | V05-S23-T3 | cheap | 2 |

### V05-S24 -- wave 8, fleet-mac1, branch `feat/v05-s24-groomer-page` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S24-E1 | epic | - | Groomer review page (inc. 6, MVP M3 groomer) | `POST /api/projects/:id/groomer/run` dispatches the backlog-groomer role prompt via `executePrompt` on a code-role member with the operator identity and backlog JSON as launch data; output validated against `apra-pm/agents/schemas/backlog-groomer-output.json`; suggestions persisted (`groomer_runs`, `groomer_items`); UI accept/reject on proposal cards applying label/close/defer through the beads client. | schema-validated run recorded; accept applies the mutation and marks the item; reject records a reason | see tasks | - | - | 10 |
| V05-S24-F1 | feature | V05-S24-E1 | Groomer backend | as epic | tests with fake executePrompt | `packages/apra-fleet-se/test/groomer.test.mjs` (new) | - | - | 5 |
| V05-S24-T1 | task | V05-S24-F1 | Run + persist + validate | as F1 | as F1 | `groomer.test.mjs` | - | standard | 3 |
| V05-S24-T2 | task | V05-S24-F1 | Accept/reject routes | as F1 | as F1 | `groomer.test.mjs` | V05-S24-T1 | standard | 2 |
| V05-S24-F2 | feature | V05-S24-E1 | Groomer UI | as epic | UI tests | `packages/apra-fleet-se/ui/test/groomer.test.tsx` (new) | V05-S24-F1 | - | 5 |
| V05-S24-T3 | task | V05-S24-F2 | Suggestions panel on cards | as F2 | as F2 | `groomer.test.tsx` | V05-S24-T2 | standard | 5 |

### V05-S25 -- wave 9, fleet-lin1, branch `feat/v05-s25-doctor-notify-backup` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S25-E1 | epic | - | Doctor, notify, backup, stats (inc. 6; MVP s5.9/s5.10/s5.14) | `doctor.mjs`: `stalled -> paused` (pause_for_human) with email via `sendEmail`; usage-limit pause/resume with re-reserve refusal path; nightly `VACUUM INTO <backup>/se-<date>.sqlite` + `bd backup` on the backlog member + copy of the apra-fleet JSON files; stats roll-ups per finished run. | transition tests; backup produces the three artefacts; stats row per finished run | see tasks | - | - | 10 |
| V05-S25-F1 | feature | V05-S25-E1 | Doctor transitions + notify | as epic | tests | `packages/apra-fleet-se/test/doctor.test.mjs` (new) | - | - | 5 |
| V05-S25-T1 | task | V05-S25-F1 | Doctor | as F1 | as F1 | `doctor.test.mjs` | - | premium | 3 |
| V05-S25-T2 | task | V05-S25-F1 | Notify + resume re-reserve | as F1 | as F1 | `doctor.test.mjs` | V05-S25-T1 | standard | 2 |
| V05-S25-F2 | feature | V05-S25-E1 | Backup + stats | as epic | tests | `packages/apra-fleet-se/test/{backup,stats}.test.mjs` (new) | V05-S25-F1 | - | 5 |
| V05-S25-T3 | task | V05-S25-F2 | Backup job | as F2 | as F2 | `backup.test.mjs` | V05-S25-T2 | standard | 3 |
| V05-S25-T4 | task | V05-S25-F2 | Stats roll-up | as F2 | as F2 | `stats.test.mjs` | V05-S25-T3 | cheap | 2 |

### V05-S26 -- wave 9, fleet-mac1, branch `feat/v05-s26-macos-e2e-docs` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S26-E1 | epic | - | macOS end-to-end and user guide | Full regression playbook on macOS against the branch; fixes limited to `ui/**` and docs; bugs elsewhere filed as `[carry-over]` beads for a wave-10 hardening pass; `docs/console.md` user guide with screenshots described in text. | playbook PASS on macOS or every failure filed; docs complete | see tasks | - | - | 8 |
| V05-S26-F1 | feature | V05-S26-E1 | Regression run + UI fixes | as epic | evidence + tests | regression playbook | - | - | 5 |
| V05-S26-T1 | task | V05-S26-F1 | Run + fix + file | as F1 | as F1 | playbook | - | standard | 5 |
| V05-S26-F2 | feature | V05-S26-E1 | User guide | as epic | docs | `tests/gen-llms-full.test.ts` | V05-S26-F1 | - | 3 |
| V05-S26-T2 | task | V05-S26-F2 | Write guide | as F2 | as F2 | as F2 | V05-S26-T1 | cheap | 3 |

### V05-S27 -- wave 9, fleet-win1, branch `feat/v05-s27-windows-e2e` off `v0.5_dashboard`

| key | type | parent key | title | description | acceptance | test | depends on | tier | est (h) |
|---|---|---|---|---|---|---|---|---|---|
| V05-S27-E1 | epic | - | Windows end-to-end from the SEA binary | `npm run build:binary`, `install --workflows all` (SEA manifest must carry `ui/dist` and `src/projects`/`src/registration`: extend `gen-sea-config.mjs`), both services registered (schtasks/NSSM path per `service-manager/windows.ts`), `/ui` from SEA, export/import round-trip, Windows regression playbook; fixes limited to `src/cli`, `src/os`, `scripts/`. | binary-only install on a clean profile reaches "Projects" in the shell; playbook PASS on Windows or failures filed | see tasks | - | - | 8 |
| V05-S27-F1 | feature | V05-S27-E1 | SEA manifest for the se UI/projects tree | as epic | `tests/gen-sea-config.test.ts` extended; `tests/install-sea-no-project-root.test.ts` green | as named | - | - | 3 |
| V05-S27-T1 | task | V05-S27-F1 | Manifest + install staging from SEA | as F1 | as F1 | as F1 | - | standard | 3 |
| V05-S27-F2 | feature | V05-S27-E1 | Windows verification run | as epic | evidence + fixes | regression playbook, `tests/install*.test.ts` | V05-S27-F1 | - | 5 |
| V05-S27-T2 | task | V05-S27-F2 | Run + fix + file | as F2 | as F2 | as F2 | V05-S27-T1 | standard | 5 |

---

## 4. Launch bodies (wave 1) for `POST http://localhost:8787/api/sprints`

Field names per `api.mjs validateLaunchRequest` (407-448) and `launch()` (488-599): `issue`,
`branch`, `base`, `members`, `goal`, `maxCycles`, `roleMap`. `members` is unioned with the roleMap
members and the unreservable `supervisor` is excluded from reservation automatically
(`memberUnion(members, roleMap, unreservable)`, `api.mjs:506`). Until S1 merges, `sync` is not
accepted (tbup), so each wave-1 sprint is single-member: the doer also holds every dispatched
role; the orchestrator is the `supervisor` member (beads clone holder). Replace
`<EPIC-ID>` with the bead id created from `V05-S<n>-E1`. Send the bearer once S1 has landed
(`-H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key)"` on POSIX; `Get-Content` on pwsh).

Wave 0 (main), fleet-win1:

```json
{
  "issue": "<EPIC-ID-V05-S0-E1>",
  "branch": "fix/v05-s0-win-dispatch-pipe-stall",
  "base": "main",
  "members": ["fleet-win1"],
  "goal": "P1",
  "maxCycles": 3,
  "roleMap": {
    "orchestrator": ["supervisor"],
    "planner": ["fleet-win1"], "plan-reviewer": ["fleet-win1"],
    "doer": ["fleet-win1"], "reviewer": ["fleet-win1"],
    "deployer": ["fleet-win1"], "integ-test-runner": ["fleet-win1"],
    "regression-test-runner": ["fleet-win1"], "ci-watcher": ["fleet-win1"],
    "harvester": ["fleet-win1"]
  }
}
```

W0-a, fleet-lin1:

```json
{
  "issue": "<EPIC-ID-V05-S1-E1>",
  "branch": "feat/v05-s1-groundwork",
  "base": "v0.5_dashboard",
  "members": ["fleet-lin1"],
  "goal": "P1/P2",
  "maxCycles": 5,
  "roleMap": {
    "orchestrator": ["supervisor"],
    "planner": ["fleet-lin1"], "plan-reviewer": ["fleet-lin1"],
    "doer": ["fleet-lin1"], "reviewer": ["fleet-lin1"],
    "deployer": ["fleet-lin1"], "integ-test-runner": ["fleet-lin1"],
    "regression-test-runner": ["fleet-lin1"], "ci-watcher": ["fleet-lin1"],
    "harvester": ["fleet-lin1"]
  }
}
```

W0-b, fleet-win1 (launch after S0 is merged and the production server redeployed):

```json
{
  "issue": "<EPIC-ID-V05-S2-E1>",
  "branch": "feat/v05-s2-ui-shell-members",
  "base": "v0.5_dashboard",
  "members": ["fleet-win1"],
  "goal": "P1/P2",
  "maxCycles": 5,
  "roleMap": {
    "orchestrator": ["supervisor"],
    "planner": ["fleet-win1"], "plan-reviewer": ["fleet-win1"],
    "doer": ["fleet-win1"], "reviewer": ["fleet-win1"],
    "deployer": ["fleet-win1"], "integ-test-runner": ["fleet-win1"],
    "regression-test-runner": ["fleet-win1"], "ci-watcher": ["fleet-win1"],
    "harvester": ["fleet-win1"]
  }
}
```

W0-c, fleet-mac1:

```json
{
  "issue": "<EPIC-ID-V05-S3-E1>",
  "branch": "feat/v05-s3-client-and-store",
  "base": "v0.5_dashboard",
  "members": ["fleet-mac1"],
  "goal": "P1/P2",
  "maxCycles": 5,
  "roleMap": {
    "orchestrator": ["supervisor"],
    "planner": ["fleet-mac1"], "plan-reviewer": ["fleet-mac1"],
    "doer": ["fleet-mac1"], "reviewer": ["fleet-mac1"],
    "deployer": ["fleet-mac1"], "integ-test-runner": ["fleet-mac1"],
    "regression-test-runner": ["fleet-mac1"], "ci-watcher": ["fleet-mac1"],
    "harvester": ["fleet-mac1"]
  }
}
```

From wave 2 on, add `"sync": true` (S1 F3) when a roleMap names more than one machine; the
scheduler of inc. 5 (S22) replaces these hand-written bodies with the roleMap editor.

---

## 5. Assumptions, doubts, adopted DQ defaults

Assumptions (A) and doubts (D):

- D1 (blocking for S2): the confidential dashboard repo is on the owner's machine, not reachable
  by the remote doers. The plan assumes the OWNER seeds the generic UI layer (components,
  tokens, page shells; no cloud/tenant/auth-provider code) as one commit on `v0.5_dashboard`
  under `packages/apra-fleet-ui-kit` and `packages/apra-fleet-shell-ui` before S2 launches
  (DQ-2 "ported, pending confirmation"; risk 3 licensing review happens in that commit).
  Fallback if not seeded: S2 T1 writes a fresh minimal kit against the wireframes (the sprint
  still fits; the paste can land later as a swap inside the same package boundary).
- A2: `v0.5_dashboard` is cut from `def08eba` by the owner before wave 1; `main` is merged into it
  after S0 and whenever the owner wants (the branch is long-lived; merges are the owner's action,
  squash policy applies to PRs into it).
- A3: single-member wave-1 sprints because `--sync` cannot be passed via the API today (tbup); the
  doer holds every dispatched role, so each wave-1 sprint deploys/tests on its own OS.
- A4: PR merges into `v0.5_dashboard` are done by the owner (the runner publishes PRs; nothing
  auto-merges); wall-clock numbers assume merges within ~2 h of PASS.
- A5: fleet-mac1/fleet-lin1/fleet-win1 currently show `llm-auth=none`; the owner re-provisions
  LLM auth before wave 1 (`provision_llm_auth`), and their checkouts point at
  `github.com/Apra-Labs/apra-fleet` with `bd` + Dolt installed (every existing sprint assumes it).
- A6: S0 (am7w/0cil) goes to `main` first because the Windows doer cannot reliably finish a Deploy
  phase without it; if the owner prefers not to touch `main`, run S0 on `v0.5_dashboard` instead
  and cherry-pick to `main` later -- same file set, same doer.
- D7: S21 (runs UI) builds one wave ahead of the scheduler routes (S22); it targets the existing
  `/api/sprints` + live proxy shapes and the doc's S7 contract, so a small follow-up in S23/S26
  may be needed if S22 changes a field. Accepted to keep three sprints per wave.
- D8: F13's package `holds` consult from `member_owner` (S7 F4) and the `holds` route itself (S7
  T2) live in different processes but the same sprint; tests use a stub registry. Real
  cross-process verification happens in S12's macOS smoke and S23's regression.
- D9: the design's `compose_permissions` denylist addition is expressed as Bash command patterns
  (`NEVER_AUTO_GRANT_PATTERNS`, `compose-permissions.ts:63-75`) because no network/URL allowlist
  exists in that tool; if members reach the console through a non-Bash tool this is
  insufficient and a follow-up bead is due.
- D10: `apra-fleet-client/docs/api-reference.md` is the only client doc (not repo `docs/`);
  parity tests cover only register/update/detail typedefs, so S14 adds a kb/code parity test and
  S3/S6/S9 extend the three typedefs; "client updated with tool change" is enforced by those tests.
- D11: estimates assume the bd-record/replay mock suite (`npm test` in apra-fleet-se) covers new
  supervisor code without new recordings; sprints that need real-bd recordings (S11 T5) budget it.
- D12: the `id-allocator.mjs` path divergence (`~/.apra-fleet/supervisor`, 86-87) is fixed in S19
  by moving the state into `supervisor.sqlite`; until then S3's store only opens
  `~/.apra-fleet-se/supervisor.sqlite` and never touches the allocator.

DQ defaults adopted as the doc recommends (none overridden): DQ-1 one process, N instances (S19);
DQ-4 labels for identity, sqlite for state (S13); DQ-7 OOB secret entry (S3 F3); DQ-8 code
queries local-only (S14); DQ-9 bind writes tag+env only, setup buttons separate (S8); DQ-10 keep
the fleet-supervisor skill alongside the console (S23 docs point both ways); DQ-11 merge order
(PR 493 in S1, FS-S1 fields in S6, F1/F2 in S6, F14 in S9, FS-S2 in S9, 4v8r in S20 before S22
exposes controls); DQ-12 dedicated beads remote default, console never creates remotes (S3 F4,
S10 F2); DQ-13 `scope: global` for cross-origin knowledge (S17); DQ-14 N runs per sprint now
(S22), `--manifest` later (out of scope); DQ-15 enforce `repo:` at ready (S13); DQ-16 suggested
member names (S8 F2); DQ-18 iframe v1 (S7 F3); DQ-20 fleet.key (S1); DQ-21 sqlite role
assignments (S13); DQ-22 remove_member honours holds (S7 F4); DQ-23 generic env map (S9);
DQ-24 keep `repo:` labels (S11/S13/S18); DQ-25 not touched (v2 out of scope); DQ-26 backlog is
SE-only, `beads/normalize.mjs` in the client (S3, S11); DQ-27 (a) hard per-role checkout flag,
implemented as a rule table in the fleet-supervisor's roles validation (S13), not in
`role-policies.mjs` (keeps the engine generic); DQ-28 (b) "workflow package"/registration with
the (d) config shortcut kept compatible (S5); DQ-29 keep the name fleet-supervisor. Settled by the
owner and honoured: DQ-2, DQ-3, DQ-5, DQ-6, DQ-17, DQ-19, DQ-27 first half.

*End of document.*
