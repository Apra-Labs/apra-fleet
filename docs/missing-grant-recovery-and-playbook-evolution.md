# Design Proposal: Missing Grant Error Recovery & Playbook Permission Evolution

## Status
Proposed (2026-08-05). Revised 2026-08-05 after design review -- see `## Revision Notes` at the end for what changed and why.

Nothing in this document is implemented yet, with one exception noted inline: the AGY half of the translation layer (`convertClaudeAllowToAgyPermissions` -> `.gemini/antigravity-cli/settings.json`) already exists. Everything else is a target design.

## Related Documents
- `docs/auto-sprint-permission-diff-safety-block.md` (Auto-sprint permission diff safety & non-self-granting workflow rule)
- `docs/runner-error-classification.md` (Runner error classification & `isNoMutationDispatchFailure` predicate)
- `docs/adr-provider-agnostic-api.md` (Provider-agnostic API contract across LLM providers)
- `docs/provider-matrix.md` (Provider capabilities and CLI settings mapping)
- `src/tools/compose-permissions.ts` (the existing `permissions.json` ledger, `NEVER_AUTO_GRANT`, `CO_OCCURRENCE`, and config delivery)
- Bead `apra-fleet-5oo` (Member sprint-role readiness is never provisioned or preflight-verified -- gaps surface reactively mid-sprint)

---

## Context & Problem Statement
When an LLM member (such as Claude Code CLI, AGY CLI, Codex, or OpenCode) attempts to run an un-permissioned CLI command or file tool, the LLM CLI intercepts the tool call and halts execution before running it.

Currently, `apra-fleet`'s error classifier (`classifyPromptError`) groups `permission_error` into the broad `auth` error category. This causes upstream workflows (`fleet-sprint`, `apra-pm`) to misidentify tool permission blocks as authentication failures, triggering invalid API key / OAuth re-provisioning (`provision_llm_auth`) that cannot resolve missing CLI tool grants. The blast radius is concrete and worth naming precisely, because it is what makes this worth fixing:

- `execute_prompt` emits `reason: 'auth'`.
- `isAuthDispatchError` (`packages/apra-fleet-se/fleet-sprint/errors.mjs`) fires a `provision_llm_auth` self-heal that cannot possibly help.
- `isNonRetryableDispatchError` (same file) then aborts the retry loop, so the sprint dies on a diagnosis that was wrong at second zero.

Furthermore, there is currently no structured mechanism for Fleet to tell callers **which specific permission grant** would unblock the LLM, nor a safe operational boundary to evolve project permission requirements.

### What this proposal does NOT solve (stated so it is not mistaken for complete)
1. **Silent degradation is the larger problem and is out of scope here.** The failure mode this document addresses is the *loud* one: the CLI refuses a tool and the dispatch fails. The more common and more expensive shape is the quiet one -- a headless `-p` dispatch hits a denied tool, the agent works around it or narrates "I do not have permission to run docker", and the process **exits 0 with a plausible-sounding but incomplete result**. All classification described here hangs off the non-zero-exit path in `execute-prompt.ts`, so none of it fires for that case. Detecting in-band refusals on a successful dispatch requires reading the provider's structured turn events, not its exit code, and should be its own proposal. Until then, do not describe this design as "permission failures are now handled".
2. **This does not make permissions correct, only observable.** A grant proposed here is evidence that a profile or playbook was wrong. The durable fix is upstream, in the profiles.

### Root cause note: the categories are not the whole bug
It is tempting to read the problem as "the category list is wrong". The deeper defect is **where classification runs and over what**. `classifyPromptError` is first-match-wins over the entire concatenated stdout/stderr of an arbitrarily long agent transcript -- a stream that contains the model's own prose, every command it ran, and every test fixture it printed. No taxonomy survives that surface. A live example from this same branch: adding `permission denied` to the `auth` pattern meant a test suite legitimately printing `EACCES: permission denied` reclassified the whole dispatch as a credential failure. That token has since been removed, but the structural hazard remains for every pattern in the list. Adding categories without narrowing the matching surface reproduces the bug with more ways to be wrong. Section "Detailed Specification 1.A" addresses this directly and is the load-bearing part of this proposal.

---

## Architecture & Core Principles

### 1. Multi-Provider Unified Permission Abstraction (`grantsNeeded`)
Fleet provides a single, unified permission abstraction layer across **all LLM providers (Claude, AGY, Codex, OpenCode, Copilot)**.

Callers and workflows interact strictly using Fleet's standard **Claude permission vocabulary** -- which means the vocabulary already used by `skills/fleet/profiles/*.json` and by Claude itself, not a new dialect:
- `Bash(<cmd>:*)` (e.g., `Bash(git:*)`, `Bash(docker:*)`, `Bash(cargo:*)`)
- `Read`, `Glob`, `Grep` (file read operations)
- `Write`, `Edit` (file write operations)
- `WebFetch`, `WebSearch` (web access)
- `Task` (subagent invocation)
- `mcp__<server>__<tool>` (MCP tool invocation)

Note that these are the real tool names. An earlier draft of this document invented `Web`, `Fetch`, `Agent` and `Mcp(<server>/*)`; those tokens appear in no profile and in no provider, so adopting them would have created a third dialect that nothing speaks and that silently matches nothing. Any token set chosen here MUST be verifiable against `skills/fleet/profiles/base-dev.json` and `base-reviewer.json`.

`compose_permissions` accepts this unified language and handles provider-specific translation internally for each provider:
- **Claude**: Writes to `.claude/settings.local.json` (and seeds workspace trust in `~/.claude.json`).
- **AGY**: Translates via `convertClaudeAllowToAgyPermissions` and writes to `.gemini/antigravity-cli/settings.json`. *(Implemented today.)*
- **Codex / OpenCode / Copilot**: See the expressiveness limits below -- these providers do not have an allowlist model, and pretending they do is a design error.

#### 1.1 Translation rules (normative)
The abstraction is only safe if translation is lossless in the restrictive direction. Two rules, both currently violated or unstated:

- **Never widen.** If a source rule cannot be expressed in the target model without granting *more* than the source did, translation MUST fail loudly and surface the un-translatable rule rather than emit the broader one. This is not theoretical: the shipped AGY converter maps `Bash(npm run build:*)` to `{action: 'command', target: 'npm run build'}`, discarding the argument pattern, and maps `Read`/`Write` to `read_file:*` / `write_file:*`, i.e. unrestricted. The unified vocabulary can only ever be as expressive as its least expressive target, so the direction of error must be pinned deliberately instead of falling out of the implementation.
- **Never silently drop.** An unrecognized token MUST warn and be surfaced to the caller. Silently ignoring it narrows the member's permissions with no diagnostic, which presents to an operator as "the grant did not work" with nothing to read. (The AGY converter now warns and emits an inert `custom` rule for unmapped tokens; that is the intended shape -- loud, non-widening, and traceable.)

#### 1.2 Expressiveness asymmetry across providers
The three provider permission models are not the same shape, and the design must say so rather than table them as peers:

| Provider | Model | Can `compose_permissions` fix a block? |
| :--- | :--- | :--- |
| Claude | tool + argument pattern, `allow`/`deny`/`ask` in a settings file | Yes |
| AGY | `{action, target}` rule list in a settings file | Yes |
| Codex | sandbox mode + approval policy (`--sandbox`, `--ask-for-approval`) -- **no per-command allowlist exists** | No |
| OpenCode | approval flag only | No |
| Copilot | approval flag only | No |

For Codex/OpenCode/Copilot, a tool refusal is real but **no grant can fix it**; the remediation is a different dispatch-time approval mode, which is a member configuration decision, not a permission grant. Classifying those refusals as `missing_grant` and proposing a playbook permission diff would generate a diff that cannot possibly work. See Category D below.

### 2. Provider Error Parsing Parity
All provider adapters reverse their respective CLI block signatures into Fleet's unified grant strings (`grantsNeeded`). Callers never parse raw provider stderr/stdout.

### 3. Disambiguating permission failures by REMEDIATION OWNER
The organizing question is not "which layer refused" -- that is an implementation detail Fleet often cannot determine reliably from text. The organizing question is **"who can fix this, and with what action?"** That is the only thing the caller can act on, and it is what determines whether a retry, a grant, a playbook diff, or a human on the host is the correct next step.

- **Category A: `missing_grant` (LLM CLI gate block)**
  - *Definition*: The LLM CLI refused to execute a tool because it is not permissioned in LLM settings (`.claude/settings.local.json` / `.gemini/antigravity-cli/settings.json`).
  - *Detection*: Positive identification from the provider's **structured refusal event** only (see 1.A below). Never inferred from free text.
  - *Remediation*: Fleet can fix it by writing a config it owns -- `compose_permissions`, gated on the playbook permission contract and human approval.
  - *Retryable*: No, not until the grant is applied AND verified.

- **Category B: `workspace_not_trusted` (already exists -- listed here because it belongs to this family)**
  - *Definition*: The CLI silently ignores a config Fleet wrote, because the workspace was never trusted.
  - *Why it matters here*: This is the existing precedent for "Fleet writes a permission config and the CLI does not honor it" (`apra-fleet-eft.40.x`). Claude drops `permissions.allow` wholesale for an untrusted workspace. **A grant written to an untrusted workspace is a no-op**, so any missing-grant remediation MUST sequence trust before grant. It is not a separate problem that happens to look similar; it is the failure mode a naive grant-and-retry loop will hit first.
  - *Remediation*: `seedWorkspaceTrust`, then re-apply the grant.

- **Category C: `os_permission_denied` (host OS / kernel / daemon block)**
  - *Definition*: The LLM CLI executed the tool, and the host operating system or a daemon returned a permission error (e.g. `unix:///var/run/docker.sock: connect: permission denied`, `EACCES: permission denied`, `sudo: a password is required`).
  - *Detection*: **Derived as the residual**, not pattern-matched in competition with Category A. See 1.A.
  - *Remediation*: System administration on the member host (e.g. `sudo usermod -aG docker $USER`). `compose_permissions` can never fix this, no matter what is granted.
  - *Retryable*: No. Must never produce a proposed grant or a playbook diff.

- **Category D: `provider_cannot_grant` (no allowlist model exists)**
  - *Definition*: A Codex/OpenCode/Copilot member was refused by its approval policy. Real refusal, but no grant can express the fix.
  - *Remediation*: Change the member's `unattended` mode / approval policy deliberately, as an operator decision. Never auto-proposed.

- **Category E: policy-forbidden (not a classification, a gate)**
  - Any extracted grant that is in `NEVER_AUTO_GRANT` (`Bash(sudo:*)`, `Bash(su:*)`, `Bash(env:*)`, `Bash(printenv:*)`, `Bash(nc:*)`, `Bash(nmap:*)`, `Bash(chmod 777:*)`) must be refused at **proposal** time, not merely at apply time. Today `compose_permissions` blocks these when granting; the playbook-diff flow introduced by this proposal is a second path to the same outcome and needs the same gate, or the gate is trivially routed around by a human approving a generated diff.

#### Is the Category A / Category C split worth it? (design decision, recorded)
Yes, and the split is necessary rather than merely tidy -- but the *method* an earlier draft proposed for it was the folly, not the split.

The case for collapsing them is superficially reasonable: both end in "a human does something", more categories mean more ways to misclassify, and the textual signals overlap heavily (`permission denied` appears in both). If the two classes were remediated identically, a finer split would be pure classification risk for no gain.

They are not remediated identically, and the asymmetry is expensive in one direction. `missing_grant` is fixable by Fleet writing a config it owns. `os_permission_denied` is **never** fixable that way, for any grant. Conflating them means the system's automatic response -- propose a grant, diff the playbook -- is wrong roughly half the time, and its failure mode is not a harmless no-op: the grant gets reviewed, approved, committed to the playbook, and applied; the retry fails identically because the docker socket was always the problem; and the project has now **permanently widened its permission surface in exchange for nothing**. A misdiagnosis that ratchets permissions open is materially worse than a misdiagnosis that just reports the wrong word, which is why the split earns its keep. The real folly is the status quo -- lumping both into `auth` and firing a credential self-heal at a filesystem problem.

The legitimate objection -- more categories, more misclassification -- is answered by construction rather than by hoping the regexes are good:

- `missing_grant` is **positively identified** from the provider's structured refusal event, where the CLI explicitly announces that *it* declined a tool call. High precision by design.
- Everything else that mentions "permission" is, by definition, output the *tool itself* produced after the CLI allowed it to run. So `os_permission_denied` needs no competing pattern list; it is the **residual** -- a permission-shaped failure that is not a structured refusal. It is a diagnostic label on "not Category A", not a peer matcher.

The two categories are therefore asymmetric, not two fuzzy matchers racing for first-match in the same chain, and the added classification risk is close to zero. If a future implementer finds themselves writing a regex list for `os_permission_denied` that competes with `missing_grant` in `classifyPromptError`'s first-match-wins array, that is the signal this design has been misread.

---

## Cross-Document Alignment & System Integration

### A. Alignment with `docs/auto-sprint-permission-diff-safety-block.md`
`docs/auto-sprint-permission-diff-safety-block.md` documents a real workflow safety incident where automated scripts attempted self-granting. It established the rule:
> *"When there IS something to check, don't have the sprint self-grant... Have the workflow SURFACE the missing permissions as a clear, structured message back... without the workflow needing self-grant authority at all."*

Our proposal is in **100% alignment**: `apra-fleet-workflow` surfaces `missing_grant` with `grantsNeeded`, while `apra-fleet-se` updates playbook `## Permissions` for human review/commit.

### B. Alignment with `docs/runner-error-classification.md` -- CORRECTED
In `fleet-sprint`'s error classification architecture, the `isNoMutationDispatchFailure(err)` predicate determines whether post-dispatch git sync/teardown is skipped.

**`missing_grant` MUST be added to `AGENT_RAN_DISPATCH_REASONS` (`packages/apra-fleet-se/fleet-sprint/runner.js`), alongside `max_turns_exhausted` and `watchdog_timeout`.**

An earlier draft of this document asserted the opposite -- that a `missing_grant` is intercepted "before any code or git state is mutated", so `isNoMutationDispatchFailure` evaluating to `true` was desirable. That reasoning is wrong, and shipping it would lose work:

- A grant block is only pre-mutation if it happens on the agent's *first* tool call. In practice it happens on turn 40, after the agent has already edited files, run tests, and committed.
- `isNoMutationDispatchFailure` returns `true` for **any** `AgentDispatchError` outside `AGENT_RAN_DISPATCH_REASONS`, so a new `missing_grant` reason lands in the no-mutation bucket by default -- exactly the wrong side.
- `runner.js` then **skips the post-dispatch G-push/D-push entirely** ("nothing to publish"), stranding real commits unpushed on the member.

The correct framing: a `missing_grant` dispatch is a member of the same family as `max_turns_exhausted` -- the agent provably ran and may have produced partial work that must still be published. Teardown must run normally. This is a must-fix before any implementation, and it needs a row in `packages/apra-fleet-se/test/error-classification-routing-table.test.mjs`.

### C. Reconciling the two permission stores (authority statement)
Two durable records of "what this project is allowed to do" will exist. The design is incomplete without saying which wins:

| Store | Written by | Scope | Committed to git? |
| :--- | :--- | :--- | :--- |
| `permissions.json` ledger | `compose_permissions` (`loadLedger`/`saveLedger`) | project folder | Not necessarily |
| Playbook `## Permissions` | Human, via the flow in this document | per playbook (`deploy.md`, `integ-test-playbook.md`, `regression-test-playbook.md`) | Yes, always |

**Proposed authority: the committed playbook `## Permissions` section is the source of truth. The `permissions.json` ledger is a derived cache plus an audit trail, never an independent grant source.** Rationale: only the playbook is reviewed and version-controlled, which is the entire control premise of the safety-block rule. Concretely this requires:
- `compose_permissions` continues to record `{permission, reason, date}` in the ledger for audit, but a ledger entry with no corresponding playbook line MUST be reported as drift rather than silently re-applied on the next compose.
- A drift report (playbook says X, member has Y) is the mechanism that makes the ratchet visible. Without it, the two stores diverge silently and nobody can answer "why does this member have docker".

There is also a **scope mismatch** that must be stated: playbook permissions are conceptually per-playbook and per-role, but `compose_permissions` delivers **per-member**. A grant that `deploy.md` needs lands on the member and is thereby available to every other role dispatched to that member, including the reviewer -- whose `base-reviewer` profile is deliberately narrower than `base-dev`. Either delivery becomes role-scoped, or the design must state plainly that the effective grant is the union across all playbooks targeting that member. Do not leave this implicit; today the union is what actually happens.

---

## Detailed Specification

### 1. Error Classification & Reverse Grant Extraction (`src/utils/prompt-errors.ts`)

#### A. Detection: structured envelopes, not raw regex
An earlier draft described `missing_grant` detection as "100% deterministic parsing from CLI stderr/stdout". That claim is false and must not survive into the implementation. What is being parsed is human-facing prose emitted by a non-deterministic LLM CLI, out of a stream that also contains the model's own narration and the output of every command it ran. The agent saying "I tried docker but got Permission denied", a test fixture asserting a permission error, and a genuine refusal are textually indistinguishable. Provider wording is also not a stability contract and changes between releases.

Normative detection rules:

1. **Match against the provider's structured error envelope, not the raw stream.** Claude `--output-format json` fields; Codex NDJSON `type: 'error'` events; AGY transcript entries. Each provider adapter owns this (Architecture principle 2) and exposes it through `classifyError`.
2. **Raw-text matching is a last-resort heuristic, and it is explicitly allowed to return `unknown`.** Returning `unknown` is a correct, expected outcome. It is strictly better than a confident wrong answer that fires a self-heal or proposes a grant.
3. **Bound the match window.** Where a structured envelope is unavailable, classification runs over the terminal error region of the output, not the entire transcript. A permission string appearing in the middle of a 200 KB successful transcript is evidence about a command the agent ran, not about how the dispatch ended.
4. **`os_permission_denied` is derived, not matched.** It is the label applied to a permission-shaped terminal failure that is NOT a structured refusal. It gets no entry in the first-match-wins pattern array. (See the design decision recorded in Architecture 3.)
5. **Precision over recall, and say which you chose.** Every pattern added to `classifyPromptError` must be justified against its false-positive cost, because `auth` fires `provision_llm_auth` and `isNonRetryableDispatchError` kills the retry loop. `permission_error` currently remains in the `auth` pattern and should move to `missing_grant` detection as part of this work -- it is the last token in that regex that describes a tool block rather than a credential failure.

#### B. Reverse Extractor (`extractGrantsNeeded`)
Parses the structured refusal identified in (A) and reverses provider signatures back to Fleet's unified grant strings:

| CLI Error Output | Extracted Grant (`grantsNeeded`) |
| :--- | :--- |
| `Permission denied: Tool 'Bash' with command 'docker ps' is not allowed.` | `["Bash(docker:*)"]` |
| `Permission error: Action 'command' with target 'cargo' is not permitted.` | `["Bash(cargo:*)"]` |
| `Tool 'Write' to file '/etc/hosts' is outside the workspace.` | `["Write"]` |
| `Permission denied for action 'read_url' on 'https://...'.` | `["WebFetch"]` |

Normative behavior the table alone does not convey:

- **No-match is normal and MUST be supported.** `grantsNeeded` is optional. `{reason: 'missing_grant', grantsNeeded: []}` is a valid, expected result meaning "we know a grant is missing, we could not name it" -- callers surface the raw refusal text to the human. Implementers must not make the field required and force a guess.
- **Extraction deliberately widens, and that is a decision, not an accident.** `docker ps` -> `Bash(docker:*)` promotes one command to an entire binary; `CO_OCCURRENCE` then expands `Bash(docker:*)` into `docker-compose` and `docker buildx`. One blocked `docker ps` therefore proposes three binaries. This is a reasonable ergonomic tradeoff for a human-reviewed diff and an unacceptable one for anything automated. State the widening in the proposed diff so the reviewer sees what they are approving.
- **Dedupe and cap.** A single dispatch can be refused many times. Emit a deduplicated set with a fixed upper bound.
- **Run against the untruncated buffer.** Output is truncated elsewhere for logging and previews; extraction must not inherit that truncation.

#### C. Threat model for `grantsNeeded` (new -- previously unstated)
`grantsNeeded` is derived from text the model itself can emit. An agent that wants docker access can simply print `Permission denied: Tool 'Bash' with command 'docker ps' is not allowed.` to stdout, and the system will faithfully propose granting it. Structured-envelope matching (1.A) raises the bar substantially, since the model cannot forge the CLI's own event stream as easily as it can print a line, but it does not eliminate the concern.

The governing rule, which the safety section already implies and this section makes explicit:

> **`grantsNeeded` is a hint for a human. It is never an authority, and never an input to an automated write.**

Corollaries:
- The `apra-fleet-workflow` prohibition on auto-granting (Safety 1) is absolute, not a default.
- `NEVER_AUTO_GRANT` members must be refused at proposal time (Category E). A generated diff proposing `Bash(sudo:*)` is precisely the artifact a tired operator approves.
- The playbook diff is where this threat lands operationally. Proposed diffs should carry provenance -- which member, which dispatch, which refusal text -- so the reviewer is approving evidence rather than a bare line.

---

### 2. Output Schema Update (`src/tools/execute-prompt.ts`)

Update `ExecutePromptStructured`:

```typescript
export interface ExecutePromptStructured {
  isError: boolean;
  reason?: 'auth' | 'server' | 'overloaded' | 'workspace_not_trusted' | 'missing_grant' | 'os_permission_denied' | 'provider_cannot_grant' | 'max_turns_exhausted' | 'nonzero_exit' | 'stalled' | 'busy' | 'reserved' | 'dispatch_failed';
  grantsNeeded?: string[];
  usage?: { input_tokens: number; output_tokens: number };
}
```

When `failureCategory === 'missing_grant'`, `execute_prompt` returns:

```json
{
  "isError": true,
  "reason": "missing_grant",
  "grantsNeeded": [
    "Bash(docker:*)"
  ],
  "error": "Permission error: Action 'command' with target 'docker' is not permitted."
}
```

**Back-compatibility.** Adding `reason` values is additive: older callers that do not recognize a value must treat it as `nonzero_exit`. The workflow layer already reads `structuredContent.reason` generically, so no change is required there -- but the contract must state it, because `fleet-sprint` branches on specific reasons in several places and a new value silently falling into the default bucket is only safe if that bucket is the conservative one.

---

### 3. Downstream Client Alignment (`packages/apra-fleet-client`) -- mechanism, not a rule

The repository guideline (`CLAUDE.md` / `AGENTS.md`) requires `packages/apra-fleet-client` to track any change to `src/tools/*` schemas or behavior. An earlier draft of this section said to "update `structuredContent.reason` JS Doc / type definitions" in `packages/apra-fleet-client/src/client/api.mjs`. That instruction is not followable as written: **there is no such typedef today.** `executePrompt` is a bare passthrough, and the only `reason` in that file belongs to an unrelated tool. An implementer following the instruction literally would find nothing to edit and move on.

There is also direct evidence that a prose rule is insufficient: the `reason` union has already been extended (`server`, `overloaded`) with no client change and nothing caught it -- correctly, because nothing in the client mirrors the union.

**Proposal: make parity structural instead of procedural.**
- Define the `reason` enum and the `grantsNeeded` shape ONCE in `packages/fleet-api-contract`, which already exists and already builds schemas.
- `src/tools/execute-prompt.ts` and `packages/apra-fleet-client` both import it. Divergence becomes a build error rather than a review miss.
- Add a contract test in `packages/fleet-api-contract` that fails when the server's emitted reasons and the client's declared reasons differ.

This is worth doing independently of this proposal. It is worth more given that client ownership has already been contested across concurrent sprints (see the hard constraint recorded on bead `apra-fleet-iuc`, which forbade reason-enum changes precisely because two sprints could not coordinate on this file).

---

### 4. Grant Application & Verification (new section)

Writing a grant is not the same as the grant taking effect. This section exists because the `workspace_not_trusted` history proves the gap is real.

1. **Trust before grant.** `seedWorkspaceTrust` runs first. A grant written to an untrusted workspace is silently discarded by Claude.
2. **Verify after grant -- write-level, implemented.** `deliverConfigFile` inspects the exit code of both the `mkdir`/`New-Item` and the write command, and then re-reads the file back and structurally compares it against the intended merged content (order-independent key comparison for JSON, substring match for TOML/string payloads) before treating the delivery as successful. A nonzero exit code or a mismatched read-back raises a typed delivery error; the caller returns an explicit failure string and skips the permissions ledger update -- a failed or no-op write can no longer be reported as a successful grant. This closes the write-level half of the gap ("did the bytes land"). It does **not** close the CLI-honoring half: "wrote the file correctly" is still not the same guarantee as "the CLI reads and applies it" (see the `workspace_not_trusted` case above, where a syntactically correct file is present but the CLI ignores it because the workspace isn't trusted). Verifying CLI-level uptake would require driving the actual provider CLI, which is out of scope for `compose_permissions` itself.
3. **Concurrency.** `deliverConfigFile` is an unlocked read-modify-write. Two concurrent composes against one member will silently drop one another's changes, and JSON array fields are replaced rather than merged, so a reactive grant can narrow a member's permission set to only the newly granted rules. Grant application needs a per-member lock and an explicit array-merge policy. (Still open -- the write-level verification added above detects a lost-update after the fact via the read-back mismatch, but does not prevent the race.)
4. **Session resume.** CLIs read settings at process start. A grant applied while a session is live may not take effect until a fresh session, so "grant then resume the same session" can loop forever. Define the expected behavior: apply grant -> require a fresh session -> retry once.
5. **Windows delivery.** The PowerShell write path performs naive single-quote doubling. Grant strings now originate from model-influenced text, so escaping requirements must be explicit on both OS paths.

---

## Safety & Operational Workflow

### 1. `apra-fleet-workflow` (Neutral Runtime Security Rule)
- `apra-fleet-workflow` **MUST NOT** auto-react to `missing_grant` by automatically calling `compose_permissions`.
- It surfaces the `missing_grant` exception cleanly to the calling workflow layer.
- *Rationale*: Auto-granting arbitrary CLI commands at the transport layer would destroy permission boundaries, allowing compromised LLMs to escalate their own permissions. See the threat model in 1.C -- the input to any such decision is model-influenced text.

### 2. Prefer preflight discovery over reactive discovery
Discovering a missing grant at turn 40 of a 60-minute dispatch is the most expensive possible time to discover it, and under the flow below it costs the whole sprint. This proposal should therefore be built **against** bead `apra-fleet-5oo` (member sprint-role readiness is never provisioned or preflight-verified; gaps surface reactively mid-sprint), not in parallel with it.

The intended end state:
- **Preflight (primary):** before dispatch, compare the playbook's declared `## Permissions` against the member's actual composed permission set and refuse to launch on a gap, naming it. Cheap, deterministic, no LLM involved, no wasted dispatch budget.
- **Reactive `missing_grant` (backstop):** catches what preflight could not know -- a grant needed for a command the playbook never declared. This is the honest scope of the mechanism in this document. It should be the exception, and a rising rate of reactive grants is a signal that the profiles or playbooks are wrong.

### 3. `apra-fleet-se` / `fleet-sprint` Playbook Evolution
- In `apra-fleet-se`, task execution is driven by declarative playbooks (`deploy.md`, `integ-test-playbook.md`, `regression-test-playbook.md`).
- Each playbook declares its permissions in a `## Permissions` section (the heading level used by the existing playbooks and read by the deployer / integ-test-runner / regression-test-runner agents):
  ```markdown
  ## Permissions
  - Read
  - Write
  - Bash(git:*)
  - Bash(npm:*)
  ```
- When a sprint execution encounters `reason: 'missing_grant'` (e.g. `grantsNeeded: ["Bash(docker:*)"]`):
  1. `fleet-sprint` captures `grantsNeeded` and logs a proposed diff for the target playbook, **with provenance** (member, dispatch, verbatim refusal text) and with any co-occurrence widening shown explicitly:
     ```diff
     ## Permissions
     - Read
     - Write
     - Bash(git:*)
     - Bash(npm:*)
     + Bash(docker:*)
     + Bash(docker-compose:*)   # added by CO_OCCURRENCE expansion
     ```
  2. **Human Control**: The user reviews the proposed playbook update, verifies that `docker` is required and safe for this playbook, and commits the updated playbook to git.
  3. Subsequent sprint runs execute against the explicitly approved, committed playbook permissions.
- **A grant in `NEVER_AUTO_GRANT` is never proposed at all** (Category E). The flow reports it as requiring operator escalation, with no diff to approve.
- **The current sprint still dies.** Step 3 says "subsequent sprint runs", which means the in-flight sprint is lost every time a new grant is discovered. This is acceptable only because section 2 above makes reactive discovery the exception rather than the norm. If reactive discovery is common in practice, this flow is too expensive and the design needs a park/resume path instead.

### 4. Ratchet control (permission creep)
Permissions under this flow only ever accumulate; nothing in the design removes one. Over a handful of sprints, every playbook converges on near-unrestricted, one individually reasonable approval at a time. Two mitigations, both required:
- **Provenance and expiry.** The ledger already records `{permission, reason, date}`. Carry the same provenance into the playbook entry (at minimum, the reason and the date), and define a periodic review in which entries not exercised since some horizon are proposed for removal.
- **Drift reporting.** Per section C above, a member permission with no playbook line is drift and must be reported. Without this, the ratchet is invisible.

---

## Observability (new section)

The highest-leverage output of this design is not the recovery -- it is the data. Record, per dispatch: whether a `missing_grant` fired, which grants were extracted, which playbook and role were in scope, and whether the subsequent grant actually unblocked the work. That series answers the question the profiles cannot answer today: *which permissions do our roles actually need?* A grant that fires repeatedly across projects belongs in `skills/fleet/profiles/*.json`, not in one playbook. This is cheap to add and should not be deferred to a follow-up.

---

## Verification & Test Plan

1. **Unit Tests (`tests/prompt-errors.test.ts`)**:
   - Verify `classifyPromptError` distinguishes `auth` vs `missing_grant` vs `os_permission_denied`.
   - **False-positive guards (the point of the exercise):** a passing dispatch whose transcript contains `EACCES: permission denied` from a test fixture classifies as neither `auth` nor `missing_grant`; agent prose narrating a permission problem does not classify as `missing_grant`; a permission string in the middle of an otherwise successful transcript does not classify the dispatch.
   - Verify an unrecognized refusal yields `{reason: 'missing_grant', grantsNeeded: []}` rather than a fabricated grant.
   - Verify `extractGrantsNeeded` extracts `["Bash(docker:*)"]`, `["Bash(cargo:*)"]`, `["Write"]`, and `["WebFetch"]` from Claude, AGY, Codex, and OpenCode block output, deduplicating repeats.
2. **Translation Tests**:
   - Verify translation never widens: a rule that cannot be expressed in the target model fails loudly rather than emitting a broader rule.
   - Verify an unmapped token warns and is surfaced rather than silently dropped.
3. **Integration Tests (`tests/integration/agy-integration.test.ts` & `tests/execute-prompt.test.ts`)**:
   - Verify `execute_prompt` returns structured `{ isError: true, reason: "missing_grant", grantsNeeded: ["Bash(docker:*)"] }`.
   - Verify trust-before-grant sequencing, and that a grant applied to an untrusted workspace is reported rather than silently ineffective.
4. **Routing Table Test (`packages/apra-fleet-se/test/error-classification-routing-table.test.mjs`)**:
   - Verify `missing_grant` is in `AGENT_RAN_DISPATCH_REASONS`, i.e. `isNoMutationDispatchFailure` is **false** for it and post-dispatch G-push/D-push still runs. This is the regression guard for the corrected section B.
5. **Client Contract Tests (`packages/fleet-api-contract`)**:
   - Verify the shared `reason` enum is the single source for both server and client, and that the test fails when they diverge.
6. **Safety Tests**:
   - Verify a `NEVER_AUTO_GRANT` member is never proposed as a playbook diff.
   - Verify `apra-fleet-workflow` never calls `compose_permissions` in response to `missing_grant`.

---

## Open Questions

1. Should `os_permission_denied` occupy a `reason` value at all, or is it better expressed as an advisory field on a generic failure? It is genuinely useful to the operator ("do not retry, do not grant, go fix the host"), which argues for keeping it -- but it is derived rather than detected, and reason values imply detection.
2. Role-scoped versus member-scoped delivery (section C): is making `compose_permissions` role-aware in scope here, or is the union across playbooks accepted and documented?
3. Does the drift report belong in this proposal or in the preflight work under `apra-fleet-5oo`? It is the natural output of the preflight comparison.

---

## Revision Notes (2026-08-05 design review)

Changes made to the original draft, and why:

- **Corrected the `isNoMutationDispatchFailure` claim (section B)** from "will evaluate to true" to "`missing_grant` must be added to `AGENT_RAN_DISPATCH_REASONS`". The original reasoning assumed a grant block happens before any mutation; it typically happens mid-task after commits exist, and the original guidance would have skipped the post-dispatch push and stranded that work. Must-fix.
- **Replaced regex-first detection with structured-envelope detection (1.A)** and removed the "100% deterministic parsing" claim. Added the bounded match window, the explicit permission to return `unknown`, and the precision-over-recall rule.
- **Reframed the taxonomy around remediation owner** rather than which layer refused, and recorded the design decision on whether the tool-permission / OS-permission split is worth its classification risk (it is; `os_permission_denied` is derived as the residual rather than pattern-matched, which is what keeps the added risk near zero).
- **Added `workspace_not_trusted` as the governing precedent** and the trust-before-grant sequencing requirement.
- **Added Category D (`provider_cannot_grant`)** so Codex/OpenCode/Copilot refusals are not given grant-shaped remediation that cannot work, and added the provider expressiveness table.
- **Fixed the unified vocabulary tokens** to the ones the profiles and providers actually use, and added the never-widen / never-silently-drop translation rules.
- **Added the permission-store authority statement (section C)**, the scope mismatch between per-playbook intent and per-member delivery, and drift reporting.
- **Replaced the client-parity instruction with a mechanism** (shared enum in `packages/fleet-api-contract` plus a contract test), because the original instruction referenced a typedef that does not exist and prose rules have already failed to hold on this exact field.
- **Added the `grantsNeeded` threat model (1.C)** and the "hint, never an authority" rule; added the `NEVER_AUTO_GRANT` gate at proposal time.
- **Added grant application & verification (section 4)**: verification after write, per-member locking, array-merge policy, session-resume semantics, Windows escaping.
- **Added preflight-over-reactive discovery** tied to bead `apra-fleet-5oo`, and stated plainly that the reactive flow costs the current sprint.
- **Added ratchet control and observability sections.**
- **Scoped the proposal honestly up front**: silent degradation on an exit-0 dispatch is the larger problem and is explicitly out of scope here.
