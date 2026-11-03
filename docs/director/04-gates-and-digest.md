# Director: gates, digest and operator modes

Status: DRAFT spec, v0.5. Vocabulary: `01-concepts.md`.

The goal of this spec is that every question the system needs answered by a
human is (a) data, (b) answerable in under 10 seconds from a phone, and (c)
never blocks work that does not depend on it.

---

## 1. Gate beads

A gate is a beads issue with `issue_type: gate` in the PROJECT's backlog (same
DB as the work it blocks, so dependency edges are ordinary `blocks` edges).

Fields (beads native where possible, the rest in `metadata`):

| field | where | content |
|---|---|---|
| title | native | the question, one line, ends with `?` |
| description | native | context: what happened, why it needs a human, links (PR, run, log) |
| priority | native | inherited from the highest-priority blocked bead |
| labels | native | `gate`, `gate-class:<action_class>`, plus `customer-visible` when applicable |
| metadata.options | metadata | 2-4 options: `{key, label, effect}`; `effect` is a machine action the event router can execute |
| metadata.recommended | metadata | option key |
| metadata.evidence | metadata | short text: precedent decision ids, numbers, links |
| metadata.firesAt | metadata | ISO time; absent for `propose_blocking` |
| metadata.decisionId | metadata | the decision record that created it |
| metadata.answeredBy / answeredAt / answer | metadata | filled on resolution |

Rules:
- A gate MUST name the beads it blocks via `blocks` edges, so the scheduler's
  existing readiness logic excludes the blocked work automatically.
- `firesAt = now + base.gates.default_expiry_hours` for `propose`.
- A gate MUST NOT block unrelated work. If the decision is project-wide (e.g.
  "pause all feature work?"), the effect is a policy-level action, not a
  dependency edge on every bead.
- One open gate per (action_class, subject) pair. A second identical proposal
  updates the existing gate's evidence instead of creating a duplicate.
- Gates created during `exhausted` risk mode carry `firesAt` only if the class
  would have been `do`/`do_notify` outside exhausted mode; otherwise none.

## 2. Resolution

| path | how | event emitted |
|---|---|---|
| answer via API | `POST /api/director/:project/gates/:id/answer {option, note?}` with the OPERATOR credential (`02` section 7) or a delegate token | `gate.answered` |
| answer via email reply | reply whose first line is `<gate-short-id> <option-key> <nonce>`; `nonce` is a per-gate HMAC (keyed by the operator credential) printed only in the email sent to the operator/delegate; replies without a valid nonce are ignored and logged | `gate.answered` |
| answer via dashboard / `/fleet-status` | button per option (calls the API) | `gate.answered` |
| expiry | supervisor tick finds `firesAt <= now` and no answer | `gate.expired` (executes `recommended`, debits `defaults_fired`) |
| obsolete | the subject disappears (PR closed, bead closed) | `gate.obsolete`, gate closed with reason |

On `gate.answered` / `gate.expired` the event router re-evaluates the chosen
option's `effect` through the policy engine. The answer satisfies ONLY the
authority step (the `propose` / `propose_blocking` result of step 3); steps
0-2 and 4-7 of `02` section 4.1 are evaluated again against the state at
execution time (tenant, hard rules, caps, spend, backpressure, breaker,
budget). If any of them now refuses, the effect is not executed, the decision
outcome is `reevaluated-refused:<reason>`, and the gate is re-opened with the
reason added to its evidence (expiry cleared). Otherwise the effect executes,
the decision is recorded, the gate bead is closed and the precedent exported
(`02` section 6).

Effects of `policy_file_change` gates open a PR with the proposed diff against
the integration branch; they never commit. Merging that PR is a human act (I6).

Email reply parsing is OPTIONAL in v0.5 (sprint D4b stretch); API, dashboard and
`/fleet-status` answers are required.

## 3. Digest

One message per project per day at `notify.digest_at` (operator time zone), plus
immediate messages for the events marked `urgent` in `03-events-and-playbooks.md`.
Quiet hours delay non-urgent messages.

Digest sections, in order (empty sections omitted):

1. **Needs you** - open gates, oldest `firesAt` first: question, recommended
   option with one-line evidence, time until default fires, one link per option.
2. **Shipped** - PRs merged since the last digest (auto-merged marked), sprint
   verdicts.
3. **Waiting on review** - PRs awaiting a human, age, risk class; backpressure
   status (`3/5`).
4. **Went wrong** - aborts, breaker trips, CI fix attempts exhausted, defaults
   that fired, risk counters spent this week vs limit.
5. **Next up** - the next 5 queue entries in consume order.
6. **Fleet** - utilization per member over 24 h, idle members and why
   (no eligible ready work / backpressure / budget / breaker).

Configuration split: transport settings (provider, from, SMTP host/port/user)
are machine configuration in `supervisor.config.json` `notify` (introduced by
D1b, secrets in the credential store); recipients, digest time and quiet hours
come from the project policy `notify.*`, falling back to the machine config's
`to` when the policy has none.

Transport: the existing `send_email` MCP tool (SMTP/SendGrid). Slack (issue #77)
is a later transport behind the same digest builder; the builder produces
transport-neutral sections.

Digest content is built by code from the stores. The director role MAY add a
3-sentence summary at the top ("what changed and what I recommend"), clearly
labelled as generated.

## 4. Operator modes

A per-operator (not per-project) setting that changes delivery and default
expiry, never authority:

| mode | delivery | default expiry |
|---|---|---|
| `present` | gates notified immediately | `gate_default_expiry_hours` |
| `light` (default) | daily digest + urgent only | `gate_default_expiry_hours` |
| `away` | digest only; urgent goes to delegates if configured | expiry halves for internal work; `propose_blocking` gates route to delegates |

`away` never upgrades any mode. Customer-visible gates still wait (I8); with a
delegate configured they go to the delegate.

Delegates: `policy.yaml` MAY list `delegates: [{email, classes: [...]}]`. Each
delegate gets a delegate token (credential store, issued by an operator-only
route) valid only for the listed classes; the answer is recorded with their
identity and has the same effect as the operator's for those classes only.

## 5. Acceptance

- Creating the same proposal twice yields one gate with updated evidence.
- A gate with `blocks` edges removes exactly those beads from scheduler
  readiness and restores them on resolution.
- Expiry executes the recommended option, debits `defaults_fired`, records the
  decision with `outcome=expired:<option>`.
- `propose_blocking` gates never expire.
- Digest builder: golden-file tests for each section from fixture stores; no
  section ever contains a secret value or a token.
- Answer API refuses the supervisor bearer alone (operator credential or
  delegate token required); a delegate cannot answer a class outside their
  list (403).
- Re-evaluation: a gate answered after the breaker tripped (or after the
  tenant/spend state changed) does not execute; it is re-opened with the reason.
- Email reply without a valid nonce is ignored (if email replies are built).
