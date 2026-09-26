# @apralabs/apra-fleet-bridge

A bridge between DevOps platforms (Azure DevOps, GitHub, Bitbucket) and
fleet-sprint. It lets a pipeline on any of those platforms pull work items into
beads, launch a fleet-sprint, watch it to completion, and report the result
back to the tracker -- without the platform ever talking to the supervisor
directly.

One binary, six verbs:

- `preflight` -- fail fast, before anything mutates
- `ingest`    -- tracker work items -> a sprint-ready beads scope
- `launch`    -- start the sprint via the supervisor and record its handle
- `watch`     -- poll the sprint and mirror progress back to the platform
- `finalize`  -- close out a terminal sprint (PR, carry-over, report)
- `status`    -- resolve a handle and print its current state

This package is monorepo-internal: it is not published, and it is not part of
the root package's `files` allowlist. It is a workspace member consumed only
from within this repository (pipeline templates, examples, and tests).

See `packages/apra-fleet-se/docs/fleet-bridge-design.md` for the design and
`packages/apra-fleet-se/docs/fleet-bridge-implementation-plan.md`
for the implementation plan.
