# The fleet project model: supervisor, members, and beads

This is the formal schema behind "which folder does the supervisor run from,
and why does it need beads at all." It exists because that was previously left
in a fuzzy state (the supervisor's working directory is hardcoded to its own
installed engine path, unrelated to any real project -- a known, tracked gap;
see the note on rule 1 below).

**Why the supervisor needs beads at all:** only to show sprint/backlog status
to the operator (the dashboard) and to let the operator plan/launch new
sprints from that backlog. It does not do sprint work itself -- that is what
dispatched members do.

## The rules

1. **A fleet-supervisor runs only `curl` and `bd` commands, from its working
   directory.** It resolves its beads DB the same way `bd` itself resolves a
   database from any directory: if a `BEADS_DIR` environment variable is set,
   beads are read from there; otherwise `bd` looks for a `.beads` directory in
   the folder it is running from; otherwise it walks up the folder hierarchy
   until it finds one.
   - **Status: the walk-up/`BEADS_DIR` resolution itself is upstream `bd` CLI
     behavior (gastownhall/beads), not code apra-fleet implements or wraps.**
     apra-fleet's only responsibility is to make sure the supervisor's
     *working directory* is the right starting point for that resolution.
   - **This is a real, known bug -- tracked, not yet fixed:** the supervisor's
     registered `WorkingDirectory` is hardcoded to
     `~/.apra-fleet/workflows/fleet-sprint` (where the engine itself is
     installed) -- a path with no relationship to any user project's `.beads`
     folder, so the walk-up never reaches it as things stand today. A
     stopgap (defaulting `WorkingDirectory` to `process.cwd()` at install
     time) was considered and deliberately dropped in favor of a proper fix:
     a folder-selection setting on the supervisor's Backlog tab, persisted to
     a `supervisor.config.json` the supervisor reads, plus graceful
     degradation when no beads DB can be found (rather than crashing). See
     bead `apra-fleet-n88b` for the full design and status.
2. **A fleet-supervisor is meant to supervise just one project.** One
   registered service, one `WorkingDirectory`, one beads-resolution root.
   Supervising a second project means registering (or running) a second
   supervisor instance pointed at that project's directory.
3. **A project can have only one beads database, but any number of code
   repositories.** The beads DB is the shared coordination surface across
   however many repos the work actually touches; it does not live per-repo.
   This is a property of how `bd` databases are created and referenced, not
   something apra-fleet enforces in code -- treat it as the intended usage
   model.
4. **A fleet member always works from a single folder, hence it can only work
   with one git repository.** This matches the existing member-registration
   model: each registered member has one working folder (`register_member`'s
   `workFolder`), and all of that member's dispatched work (`execute_command`,
   `execute_prompt`) runs relative to it.
5. **A project can have multiple fleet members, each with their own folder,
   hence each potentially on a different git repository.** Each member
   resolves beads the same way the supervisor does (rule 1): `BEADS_DIR`, else
   a `.beads` walk-up from that member's own working folder. Nothing about
   this differs between a member and the supervisor -- both are just a
   process that needs to reach the project's one beads DB from wherever it
   happens to be running.
6. **A project with more than one member also needs an orchestrator member**
   (beads access, no git, no LLM dispatch of its own) **-- though any of the
   project's members can play that role.** This is a design convention this
   repo's own multi-member setups follow (e.g. a Windows box coordinating
   several Linux/macOS dev members), not a role type enforced by the code
   today: nothing currently prevents an "orchestrator" member from also
   having git or an LLM provider configured. Treat "no git, no LLM" as the
   recommended shape for a dedicated orchestrator, not a validated constraint.
7. **Hence very simple projects can use a single member that plays all the
   roles** -- supervisor, orchestrator, and worker collapse onto one folder,
   one beads DB, one git repo, one LLM. This is the common case for a
   single-developer project and needs no extra setup beyond registering that
   one member.

## Open gaps (tracked, not yet enforced)

- Rule 1's supervisor `WorkingDirectory` does not yet point at the supervised
  project -- it is hardcoded to the installed engine path. Bead
  `apra-fleet-n88b` (P1) tracks the real fix: a folder-selection setting on
  the Backlog tab, persisted to `supervisor.config.json`, plus graceful
  degradation (no crash) when no beads DB can be found.
- Rule 1's `BEADS_DIR`/walk-up behavior has not been independently verified
  against the installed `bd` CLI's own documentation in this change -- it is
  stated here as the intended contract; confirm against `bd --help` /
  upstream beads docs if you need to depend on the exact walk-up semantics.
- Rule 6's orchestrator role (no git, no LLM) is a convention, not a code
  constraint -- there is no validation today that stops an orchestrator
  member from being registered with a git-capable or LLM-capable
  configuration.
