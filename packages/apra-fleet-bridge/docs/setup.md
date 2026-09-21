# fleet-bridge setup

How to prepare a machine to run fleet-sprints triggered from a DevOps platform.

Every step below was executed against a real Azure DevOps project while writing this;
the worked example uses `https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy`
and a member named `aztoy`. Substitute your own.

**You do not need Azure Blob Storage or a self-hosted pipeline agent to start.** The
bridge runs fully without either; blob storage is what a *pipeline-triggered* sprint
needs, because the pipeline job exits in minutes while the sprint runs for days - see
"Remote observability" below. A self-hosted agent is deferred; see "What you can skip".

---

## Prerequisites

- apra-fleet server running and reachable over **HTTP** (the bridge hard-fails on
  anything else; it will not self-spawn a stdio server)
- The supervisor running on `127.0.0.1:8787`
- `bd` (beads) on PATH
- An Azure DevOps project, a repo whose base branch builds, and 2-3 work items

Check the first two:

```bash
curl -s http://127.0.0.1:8787/api/health
```
Expect `"status":"ok"` and no seam whose value ends in `:stub`.

---

## 1. Deposit the PAT

Create an Azure DevOps PAT with **Work Items** (read/write) and **Code** (read/write).
Add **Code (Status)** only if you plan to use `setBuildStatus`.

```bash
apra-fleet secret --set fleet_bridge_azdevops_pat --persist
```

The name matters: `fleet_bridge_azdevops_pat` is the bridge's default. If you use a
different name, pass `--secret-name` (or the `adoPatSecretName` pipeline parameter) to
every verb.

**Never put the value anywhere else.** Not in a config file, not in a pipeline
variable that gets echoed, not in chat. The bridge only ever handles the *name*; the
value is substituted server-side as `{{secret.NAME}}` and never enters the bridge's
process.

Verify it landed (this returns names and metadata only, never values):

```
credential_store_list
```

---

## 2. Register a member

A member is the machine that will run the sprint. Its work folder must contain a clone
of the target repo.

```bash
mkdir -p /c/ak/aztoy
```

Then register it through the fleet (MCP `register_member`, or the equivalent CLI):

```
friendly_name: aztoy
work_folder:   C:\ak\aztoy
member_type:   local
llm_provider:  claude
vcs_provider:  azure-devops
```

`vcs_provider` is **required** for a member that will push and open PRs. The engine
hard-errors with no default if it is absent, and `fleet-bridge preflight` fails on it.

---

## 3. Provision git credentials on the member

```
provision_vcs_auth
  provider:      azure-devops
  member_name:   aztoy
  org_url:       https://dev.azure.com/apralabs
  pat:           {{secret.fleet_bridge_azdevops_pat}}
```

Note the response may say `verified: false` / `verificationSkipped: true`. That means
the credential was deployed but not exercised - the clone in the next step is the real
proof.

---

## 4. Clone the repo into the work folder

Registration creates a `.claude/` directory in the work folder, so `git clone . `
refuses ("destination path already exists and is not an empty directory"). Use init +
fetch instead, which preserves it:

```bash
git init -q
git remote add origin https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy
git fetch -q origin
DEF=$(git remote show origin | sed -n 's/.*HEAD branch: //p')
git checkout -q -t origin/$DEF
```

Check which branch you actually want. `git remote show origin` reports the repo's
HEAD branch, but that is only a default, and it is not always the branch you intend
to build and raise PRs against - this repo's HEAD is a workshop branch while the
branch that matters is `main`. Set `baseBranch` to the branch you want PRs targeted
at, and confirm it exists on the remote (`git ls-tree --name-only origin/<branch>`)
rather than trusting HEAD.

A successful fetch proves the PAT, the org URL and the credential provisioning all
work.

---

## 5. Bootstrap beads and set the tracker coordinates

```bash
bd bootstrap
bd config set ado.org apralabs
bd config set ado.project e2e-fleet-testing
git config beads.role maintainer
```

Three things worth knowing here:

**`bd config set` will warn** that `ado.org` and `ado.project` are "not a recognized
config key". Ignore it - that whitelist is stale. `bd ado status` reads both correctly.

**Do NOT run `bd config set ado.pat`.** That writes the token to disk. The bridge
injects the PAT per-call instead, so beads never needs to store it.

**This step is the one `preflight` cannot check.** The bridge passes only the PAT when
dispatching `bd ado pull/push`, never the org or project, so beads must already know
them. Skip this and `ingest` fails at the first tracker pull with a confusing error.

---

## 6. Verify

`bd ado status` on its own will report **"Not configured"** with a red X, because the
PAT is deliberately absent from beads' own config. That is correct. To verify the way
the bridge actually calls it, inject the secret exactly as the bridge does - the
placeholder **bare**, never quoted:

```bash
AZURE_DEVOPS_PAT={{secret.fleet_bridge_azdevops_pat}} bd ado status
```

(run through `execute_command` on the member, so the fleet resolves the placeholder)

Expect `Status: Configured` and a masked PAT. This single command exercises the whole
secret path: credential store, server-side substitution, member dispatch, and beads'
Azure DevOps client.

Then:

```bash
fleet-bridge preflight --member aztoy --repo-local-path C:\ak\aztoy --base-branch <default-branch>
```

It runs all nine checks without stopping at the first failure, so one run tells you
everything that needs fixing. Each failure names its own remedy.

---

## Running the first sprint

Do these from a shell before touching a pipeline. They exercise the risky paths where
the errors are readable:

```bash
fleet-bridge ingest  --refs <id>,<id>,<id> --member <name> --repo-local-path C:/path/to/clone
fleet-bridge launch  --await-until plan-round
fleet-bridge status  --sprint-id <id>
```

**Pass `--repo-local-path` to `ingest` as well as to `preflight`.** Every local `bd`
call runs in that directory, and the beads DB belongs to the repo under test, not to
wherever the bridge binary was launched from. Omit it and `ingest` operates on
whatever beads DB happens to sit in the launching shell's working directory - or none.

The flag is `--refs` (the pipeline parameter is named `workItems`), comma-separated.
Each ref may be a bare work item id or the full work item URL.

`ingest` refuses work items that have no acceptance criteria. That is deliberate: the
doer is contractually instructed to skip beads without them, so a run against vague
items burns hours and produces little. Use `--allow-missing-criteria` only to explore.

`--await-until plan-round` holds until the planner and plan-reviewer have produced a
verdict - typically 10-20 minutes - then detaches and lets the sprint continue. A
timeout exits green and **never** stops the sprint.

---

## The two branch fields, which read backwards

This catches people, so read it once:

| Field | What it is |
|---|---|
| `targetBranch` | **Where the work is done.** The sprint creates this branch and commits to it. |
| `baseBranch` | **What the pull request targets.** The sprint branch is cut from it, and the PR lands back into it. |

The names invite the opposite reading - "target" sounds like the PR's destination,
which is `baseBranch`. It is not. The vocabulary comes from the fleet-sprint engine,
where `branch` is the sprint branch and `base` is its branch point, and the bridge
keeps the engine's meaning rather than inventing a second one.

A worked example: to develop three work items and raise a PR into `main`, set
`baseBranch` to `main` and `targetBranch` to something new like
`feat/note-list-querying`.

**Setting them to the same value is rejected**, and deliberately so. If it were
allowed, the sprint would commit straight onto the base branch - unreviewed, no
branch - and then try to open a pull request from that branch into itself. On a
protected branch that is exactly the outcome the PR flow exists to prevent. The
comparison is case-sensitive, because `Main` and `main` are genuinely different git
refs.

---

## A note on work item types

**The bridge never assumes a work item type.** Not `Epic`, not `Issue`, not
`User Story`, not `Task`. This is deliberate: the three supported platforms disagree
with each other, and Azure DevOps disagrees with itself across process templates -
Basic gives you `Epic / Issue / Task`, Agile gives `Epic / Feature / User Story /
Task / Bug`, Scrum gives `Epic / Feature / Product Backlog Item / Task / Bug`, and a
custom process can give you anything at all. GitHub has no types; Bitbucket has its
own.

What the bridge actually uses:

- **On ingest**, it reads only the *shape* beads gives it - id, external ref, title,
  parent, acceptance criteria. Parent/child comes from whatever hierarchy link beads
  pulled, whatever the two ends are called. If none of the ingested items is a parent
  of the others, the bridge creates a synthetic local root instead of insisting on a
  particular type at the top.
- **Internally**, sprint work is tracked as beads, whose own vocabulary (`epic`,
  `task`) is local and unrelated to the tracker's.
- **On carry-over**, a bead that is *already linked* (it carries an `external_ref`)
  goes to `bd ado push`, the update path - beads owns the field mapping there and the
  bridge passes no type at all. A bead with **no** link yet has to be **created**, and
  beads cannot do that here: `bd ado push` creates work items with
  `System.State = 'New'`, an Agile/Scrum initial state, which HTTP 400s on a Basic
  project (`To Do / Doing / Done`) while beads reports it as a *Warning* and exits 0.
  Same class of assumption as a hardcoded type name, one level down - a state
  vocabulary - and `bd config` has no state-mapping key to configure it out of.
  So creation goes over REST (`src/adapters/azure-devops.mjs`, `createWorkItem`) and
  sets **only** `System.Title` and `System.Description`: with no `System.State` in the
  patch, Azure DevOps applies the work item type's own initial state, which is correct
  on every process template. The new work item's URL is then stamped back onto the
  bead with `bd update --external-ref`, which is what makes a re-run publish nothing.

Two consequences for you:

1. Any hierarchy works. The worked example uses Basic's `Epic -> Issue -> Issue`
   because that is what the toy project's process template offers, not because the
   bridge wants it. A flat list of work items with no parent works too.
2. If carry-over items come back as the wrong type, that is a **beads** setting, not a
   bridge one. Look at `ado.filter.types` and beads' own mapping - the bridge has no
   knob for it and adding one would put the same mapping in two places.
3. For the REST **creation** path above the bridge does need one type name, and it
   still never assumes one. Set `adoWorkItemType` (flag `--work-item-type`, env
   `FLEET_BRIDGE_ADO_WORK_ITEM_TYPE`) to pick explicitly; it is validated against the
   project's real type list before anything is created. Leave it unset and the bridge
   asks the project which types it has and takes the first of
   `Issue, Task, User Story, Product Backlog Item, Requirement` that the project
   actually reports - smallest trackable unit first. If the project reports none of
   them, finalize fails and names both the project's real types and this setting; it
   never guesses a name that would 400 later, and never skips the item in silence.

---

## Carry-over and the tracker's state vocabulary

Carry-over publication does **not** go through `bd ado push`, and the reason is
worth knowing before you point the bridge at a different project.

`bd ado push` sets `System.State` to `New` when it creates a work item. `New` is an
**Agile/Scrum** state. A project on the **Basic** process has `To Do / Doing / Done`
and rejects it:

```
The field 'State' contains the value 'New' that is not in the list of supported
values  (status 400)
```

Worse, `bd` reports that as a *Warning* and exits 0, so every layer above it reads
the push as successful and the carry-over silently disappears.

So the bridge creates carry-over work items itself, and **sets no state at all** -
Azure DevOps then applies whichever initial state the work item type defines. That is
the only behaviour that is correct on Basic, Agile, Scrum and any custom process
alike, and it is the same rule as "the bridge never assumes a work item type", one
layer down: a state name is part of the tracker's vocabulary too.

If carry-over ever reports zero published items, the bridge now fails loudly with a
non-zero exit rather than exiting 0 - a silent success here means losing the entire
point of the finalize phase.

---

## Remote observability: the append-blob sink and the archive page

Skip this whole section if you only ever run sprints from a shell on the machine you
are sitting at. Read it if a pipeline launches the sprint: **the pipeline job exits
minutes in, the sprint runs for days, and after the job ends nothing in the pipeline
can show you the local log file on the agent.** Two things fix that, and both use one
storage container:

| What | When it writes | What you get |
|---|---|---|
| Append-blob progress sink | continuously, while `watch`/`daemon` runs | `<container>/<sprintId>.jsonl` - the same records as the local mirror, appended in ~10 s batches |
| Archive page | once, at `finalize` | `<container>/sprints/<sprintId>/index.html` - the real dashboard, frozen, permanently shareable |

Enabling blob storage **adds** the remote copy. It never replaces the local JSONL
mirror, which stays the record of last resort when a remote write fails.

### 1. Create the storage account and container

Any general-purpose v2 account works. Two constraints that are not optional:

- **Hierarchical namespace (ADLS Gen2) must be OFF.** Append-blob support differs
  there, and the sink's appendpos protocol is what makes a daemon restart
  duplicate-free.
- **The container must be private.** Sprint logs carry agent output, source
  fragments, and error text. Never enable anonymous blob access.

```bash
az storage account create -n <account> -g <rg> -l <region> --sku Standard_LRS --kind StorageV2
az storage container create --account-name <account> -n sprint-logs
```

### 2. Mint a container SAS

The bridge holds exactly one credential of its own: this SAS. Mint it scoped to the
one container, with only the permissions the sink and the archive need, and with an
expiry comfortably past your longest sprint plus its finalize.

```bash
az storage container generate-sas \
  --account-name <account> -n sprint-logs \
  --permissions racw \
  --expiry 2026-12-31T00:00:00Z \
  --https-only -o tsv
```

`racw` = read, add, create, write. `add` is the one people forget: it is what
`Append Block` needs. Without it the sink fails on every flush (and tells you so -
see "How you know it is working").

### 3. Give the bridge the three values

The two coordinates follow the same precedence as every other setting - **CLI flag >
environment variable > `bridge.config.json`**:

| Value | Flag | Environment variable | `bridge.config.json` |
|---|---|---|---|
| Account URL | `--blob-account-url` | `FLEET_BRIDGE_BLOB_ACCOUNT_URL` | `blobAccountUrl` |
| Container | `--blob-container` | `FLEET_BRIDGE_BLOB_CONTAINER` | `blobContainer` |
| SAS | *(none, on purpose)* | `FLEET_BRIDGE_BLOB_SAS` | *(none, on purpose)* |

**The SAS is an environment variable and nothing else.** A flag would put a live
credential into argv, where `ps`, a crash dump and the pipeline's own command echo
can all read it; a config-file key would commit it. In Azure Pipelines, map the
secret variable onto the step:

```yaml
- script: npm exec --yes fleet-bridge watch --sprint-id $(SprintId)
  env:
    FLEET_BRIDGE_BLOB_SAS: $(blobSasSecret)
```

Set **both** coordinates or **neither**. Setting one alone fails at startup with a
named error rather than quietly downgrading to local-only - an operator who thinks
remote logging is on and is wrong is worse off than one who was told plainly.

### 4. What a working run looks like

```
$ fleet-bridge watch --sprint-id spr-1 \
    --blob-account-url https://myacct.blob.core.windows.net --blob-container sprint-logs
```

Within about ten seconds the container holds:

```
sprint-logs/
  spr-1.jsonl            <- grows continuously; one JSON record per line
  spr-1.manifest.json    <- {"version":1,"sprintId":"spr-1","parts":[...]}
```

and after `finalize`:

```
sprint-logs/
  sprints/spr-1/index.html                     <- open this in a browser
  sprints/spr-1/activities/<activityId>.json
  sprints/spr-1/extensions/beads/<beadId>.json
```

The final work-item comment carries the archive URL, so the operator gets the link
without being told where to look.

### How you know it is working

Check it positively, once, on your first run - do not assume silence means success:

```bash
az storage blob list --account-name <account> -c sprint-logs -o table
```

`spr-1.jsonl` should exist and its size should grow between two checks while the
sprint is running.

And when it is **not** working, you will be told, in three places:

- **A banner in the watch log** after three consecutive failed flushes - a boxed,
  multi-line block naming the sink, how long it has been down, how many records are
  stranded in memory, the last error, and which sink is still healthy. It repeats
  every 15 minutes, so it cannot scroll away unnoticed, and it announces recovery
  too.
- **A comment on the work item**, because the operator is not watching the agent's
  log. Same facts, same heartbeat.
- **A final banner when the run ends** if the sink was still failing, stating plainly
  that the remote log is incomplete and the local mirror is the real record.

A failing sink never stops the sprint. A sprint two days in is worth far more than
its remote log, so the sink keeps buffering and retrying; what it will not do is stay
quiet about it.

The archive export behaves the same way at `finalize`: a failed upload does not fail
finalize (the sprint is over and carry-over has already been published), but it
prints a banner and writes `Archive: export FAILED (...)` into the final comment
instead of silently omitting the line. Re-running `finalize` for that sprint re-runs
the export; it overwrites and is safe to repeat.

### Costs and limits worth knowing once

- An append blob accepts **50,000 appends**. The sink batches on a 10-second timer
  (~17,300 appends over 48 hours) and rolls to `<sprintId>-part2.jsonl` at 45,000,
  recording every part in the manifest. You should never see a roll in practice.
- A daemon restart resumes from a cursor persisted in the spool and re-uses the
  append position, so a restart mid-sprint produces neither a gap nor a duplicate.
  The cursor is why a restarted sink never re-creates the blob: creating an append
  blob in Azure overwrites it.
- Storage cost for a sprint's logs is cents per month.

---

## The LAN viewer is deliberately unauthenticated

`fleet-bridge viewer` binds `0.0.0.0` by default, performs no authentication of the
LAN client, and injects the supervisor's bearer token on every upstream request. It
withholds `POST /api/shutdown` and nothing else, so any host that can reach the port
can launch, pause or stop sprints on the runner.

**This is an accepted risk, not an oversight.** It is recorded here so nobody
"discovers" it later and assumes it was missed:

- The viewer is opt-in. `daemon` never starts it; you have to run the verb.
- A browser address-bar navigation cannot send an `Authorization` header, so a
  header-based guard makes the page unreachable rather than protected - an earlier
  `--viewer-token` attempt did exactly that and was removed.
- A cookie-based guard is the intended design, and depends on work in progress
  elsewhere.

Until then: run it on a trusted network, or bind it to loopback and reach it through
an SSH tunnel.

---

## What you can skip, and why

**Azure Blob Storage**, if - and only if - you always watch a sprint from the machine
it runs on. The local JSONL mirror and the work-item comments are a complete story in
that case. The moment the sprint is launched by a pipeline job that exits while the
sprint keeps running, the operator has no way to see progress, and that is what blob
storage is for. See "Remote observability" above for the setup.

**The live SPA (Part D2).** Only the *archive* page ships today: a permanent page
written once, at `finalize`. There is no live blob-fed viewer yet.

**A self-hosted pipeline agent.** Only needed to trigger via Azure Pipelines. Every
step above, and the whole first sprint, runs from a shell. Prove the loop by hand
first; then a pipeline failure is unambiguously a pipeline problem. Note that
registering an agent needs a PAT with **Agent Pools (Read & manage)**, a scope the
bridge itself never needs.

---

## Known gaps

- **`preflight` does not check beads' ado config** (step 5). Add it to your own
  checklist until the check exists.
- **One daemon cannot serve two Azure DevOps organisations.** A sprint handle carries
  no adapter coordinates, so `watch`/`finalize` use the daemon's own configuration for
  every sprint it manages. The failure mode is silence: comments simply never post.
- **The PowerShell path is unproven.** The worked example ran on a gitbash member, so
  the POSIX branch of the member-dispatched REST client is exercised and the
  PowerShell branch is not.
