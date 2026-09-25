<!-- llm-context: Design notes for the member reservation model -- the reservation-object shape, its legacy-string compatibility contract, lazy dead-holder reaping, and the owner-tag refusal that runs ahead of it. -->
<!-- keywords: member reservation, reservedBy, reservation object, lazy reaping, dead pid, owner_ref, member_other_owner, unreservable -->
<!-- see-also: cross-shell-command-construction.md -->

# Member reservation design

A fleet member can be reserved by a sprint/run so that a second sprint does
not dispatch to it concurrently. This document covers the reservation
object's shape, why it is layered on top of the older string-only
reservation rather than replacing it, and the reaping and refusal rules
built on top of it.

## Reservation is an object, with the old string kept as a same-write mirror

The reservation is stored as `{runId, pid, at}`: the sprint/run id holding
it, the reserving process's id on the fleet server's host (when the caller
supplied one), and an ISO timestamp. The member's older, plain string
holder field is written and cleared in the *same* update as the object, so
the two can never diverge into disagreeing states. That mirror exists
because a number of independent readers across the codebase -- an owner
refusal check, a dispatch-time holder check, and an external conflict
check that reads the member list as JSON -- all treat that field as an
opaque sprint-id string and were never touched by this change. Keeping the
mirror in lockstep let the object model land without requiring every one
of those call sites to be rewritten in the same change.

A member that only ever carries the legacy string (no reservation object
written yet) is read back as `{runId: <the string>, pid: null, at: null}`.
A pid-less reservation, whether legacy or explicit, is **never reaped** --
its holder may be running on a different host entirely, and liveness can
only be checked against the local host's process table.

## Reaping is lazy, and deliberately fails safe

A reservation with a recorded pid is checked for liveness the next time a
reserve is attempted, not on a timer: if the recorded pid is no longer
alive, the reservation is cleared before the new reserve's holder check
runs, so a dead holder cannot wedge the member indefinitely. Two choices
here bias toward "leave a stale reservation for an operator to clear"
over "risk stealing a live one":

- Liveness checking treats a permission error (`EPERM`, e.g. checking a
  pid owned by another user) as *alive*. A false "dead" verdict would let
  a second sprint steal a reservation whose holder is actually still
  running, which is a worse failure than leaving a stale reservation
  behind for a forced release.
- A pid-less reservation is never reaped, for the same reason: no local
  signal exists to declare it dead.

Because pid liveness alone cannot distinguish the original holder from an
unrelated process that the OS later recycles onto the same pid, a reaped
reservation is a best-effort signal, not a proof -- an operator forcing a
release remains the fallback for a case reaping cannot resolve on its own.

## Owner-tag refusal runs before reaping, so a refusal writes nothing

When a reserve call supplies an owner tag and the member already carries a
*different* owner tag, the reserve is refused outright -- this is not a
conflict over who currently holds the member, it is a refusal to touch a
member that belongs to a different consumer at all. That check runs before
the lazy-reap step specifically because reaping is a real write to the
member record: if reaping ran first, an owner-refused call would still
have a side effect (clearing a dead reservation) despite being refused,
which would be surprising to a caller who was told nothing happened.

## Design implication for callers

Any code that reads "who holds this member" should go through the single
reader that returns the reservation view described above (object, or
synthesized legacy view, or `null`), rather than reading the mirror string
directly -- the mirror exists for backward compatibility with pre-existing
readers, not as a second source of truth to branch on in new code.
