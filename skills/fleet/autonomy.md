# Autonomy: Using The Fleet Without Being Asked

Fleet is the normal way to work, not a special mode the user opts into. The user
should never have to say "use fleet", name a member, or learn a fleet term to get
the benefit of one. Read this before deciding how to execute any non-trivial task.

## The fan-out test

Split work across workers ONLY when ALL FOUR hold:

1. **Two or more units.** The work breaks into pieces that can each be stated on
   their own, without reference to the others.
2. **Disjoint files.** The pieces do not edit the same files. Overlap means
   serialize - concurrent edits to one file produce conflicts, not speed.
3. **Non-trivial each.** Every piece is more than a few minutes of real work.
   Two-line edits are faster done inline than handed off.
4. **Independently checkable.** Each piece has its own tests, build, or review
   that can pass or fail without the others.

If any one fails, do the work inline yourself. **Bias toward inline.** A needless
fan-out costs tokens, adds coordination overhead, and creates merge conflicts -
it is strictly worse than not using the fleet at all. A missed fan-out costs only
wall-clock time.

**Ceiling: 3 concurrent workers.** Go higher only when the user asks. If
`local-settings.md` exists next to this file, its limits replace this default.

## Cost gate: local is free, everything else is not

| Action | Ask the user first? |
|---|---|
| Create or reuse a worker on this machine | **No.** Just do it. |
| Register a remote member | **Yes.** |
| Start or resume cloud compute (`cloud_control`) | **Yes** - it bills. |
| Store a credential (`credential_store_set`) | **Yes** - it needs their terminal. |
| Remove a worker this session created automatically | **No.** |
| Remove a member the user created by hand | **Yes.** |

Local members inherit LLM auth and git credentials from this machine, so there is
nothing to provision and nothing to bill. See `fast-local.md` for the four-step
setup. This is why local fan-out needs no permission and remote fan-out does.

## Lifecycle of an auto-created worker

1. **Isolate.** `git worktree add` a directory per worker so their edits cannot
   collide. Never point two workers at the same folder.
2. **Register.** `register_member` with `member_type: "local"`, the worktree as
   `work_folder`, `tags: ["auto"]`, and `unattended: "auto"`.
3. **Permit.** `compose_permissions` with the stack profile matching the repo.
   Always before the first dispatch, never after.
4. **Dispatch.** `execute_prompt` inside a background Agent, one unit of work per
   worker, with the acceptance criteria stated in the prompt.
5. **Collect.** Gather results, merge the worktrees, run the full test suite once
   at the end - individual workers only verified their own slice.
6. **Reap.** `remove_member` every worker tagged `auto`, then remove its worktree.

Step 6 is not optional. Auto-spawn without auto-reap fills the fleet with dead
members within a week, and a stale member list makes every later decision worse.

There is a backstop, but do not rely on it: the fleet server sweeps idle
`auto`-tagged members on startup, after a TTL (2 hours by default, set via
`FLEET_AUTO_MEMBER_TTL_MIN`). It only ever touches members carrying the `auto`
tag, and it never removes one that is busy. Members the user registered by hand
are never swept. The backstop exists for runs that are interrupted before step 6 -
it is not a substitute for cleaning up after yourself.

## Language contract

The user asked for fleet's benefits without fleet's vocabulary. Honour that.

**Never write these to the user:** member, dispatch, provision, onboard, register,
decommission, orchestrator, MCP, any tool name (`execute_prompt`, `compose_permissions`),
any UUID, any provider CLI flag.

**Write this instead:**

| Instead of | Say |
|---|---|
| "Dispatching to member dev2 via execute_prompt" | "Asked dev2 to take the parser" |
| "Registering a local member and composing permissions" | "Setting up dev2" |
| "Provisioning LLM auth on the remote member" | "Signing that machine in" |
| "3 members idle, 1 busy" | "dev1 is still on the migration; the rest are done" |
| "Removing auto-tagged members" | "Cleaned up the workers" |

Refer to workers by name and icon, as `docs/vocabulary.md` already requires. The
user knows what "dev2" is because you told them what you gave dev2 to do.

## Asking well

Asking is fine. Asking in fleet jargon is not. When the cost gate above requires a
question, phrase it in terms of money, time, or risk - never infrastructure.

- Remote machine: "This would run faster on the build box. Want me to set that up?
  It needs a one-time sign-in."
- Cloud: "I can run this on the GPU instance - that starts billing at roughly
  $X/hour. Go ahead?"
- Credential: "This needs your npm token. I will open a prompt in your terminal so
  it never passes through the chat."

Do not ask whether to parallelise local work. That decision is yours - make it with
the fan-out test and report what you did afterwards.
