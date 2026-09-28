# The fleet project model: supervisor, members, and beads

This is the formal schema behind "which folder does the supervisor run from,
and why does it need beads at all." It exists because that used to be left in
a fuzzy state: the supervisor's registered working directory is its own
installed engine path, unrelated to any real project, and the fix (a
persisted project-folder setting, see the note on rule 1 below) closes that
gap.

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
   - **Fixed -- a persisted project-folder setting, not a hardcoded
     directory.** The registered service's `WorkingDirectory` is still the
     engine's own installed path (`~/.apra-fleet/workflows/fleet-sprint`),
     which has no relationship to any user project's `.beads` folder -- a
     stopgap of defaulting it to `process.cwd()` at install time was
     considered and deliberately dropped, since a service's cwd is not
     something an operator controls anyway. Instead, the supervisor resolves
     its project folder by precedence at startup: an explicit `--beads-dir`
     flag (not used by the registered unit itself), else the folder
     **persisted** in `supervisor.config.json` under the supervisor's own
     data dir, else the `.beads` walk-up above. The persisted setting is
     what makes a service-registered supervisor reach a real project: it can
     be seeded at install time (`apra-fleet install --project-dir <path>`)
     or set later from the console's Projects page, which reads/writes the
     same file through the supervisor's own guarded `GET`/`POST
     /api/project`. A persisted folder that has since gone missing degrades
     to a warning and an "unknown" beads status rather than refusing to
     start (deliberately asymmetric with a typo'd `--beads-dir`, which is
     still fatal -- see [`../../../docs/install.md`](../../../docs/install.md)'s
     "Project folder" note for the full precedence, setting, and
     staleness-tolerance detail).
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

- Rule 1's `BEADS_DIR`/walk-up behavior has not been independently verified
  against the installed `bd` CLI's own documentation in this change -- it is
  stated here as the intended contract; confirm against `bd --help` /
  upstream beads docs if you need to depend on the exact walk-up semantics.
- Rule 6's orchestrator role (no git, no LLM) is a convention, not a code
  constraint -- there is no validation today that stops an orchestrator
  member from being registered with a git-capable or LLM-capable
  configuration.
