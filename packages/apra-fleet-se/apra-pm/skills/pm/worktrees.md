# Worktrees -- topology, parallel tracks, lifecycle, transport

pm isolates parallel work with git worktrees. A worktree is a second checkout
of the same repository sharing one `.git` object database. That shared object DB is
what makes worktrees the right tool: a commit made in one worktree is instantly
visible from every other worktree and from the orchestrator.

## Topology: one worktree per track

A track is one independent unit of work with its own branch, worktree, and full
pipeline (`planner` -> `plan-reviewer` -> `doer` -> `reviewer`).

```
repo/                          <- base checkout; the orchestrator runs git from here
  .git/                        <- shared object DB and refs
repo-wt/
  track-1/   [feat/x-track-1]  <- track 1's full pipeline runs here
  track-2/   [feat/x-track-2]  <- track 2's full pipeline runs here, concurrently
```

Rules that fall out of how git works:

- **One branch per worktree.** Git forbids checking out the same branch in two
  worktrees. Each track owns exactly one branch in exactly one worktree.
- **A track's four roles share its worktree, sequentially.** Planner, plan-reviewer,
  doer, and reviewer for one track never run at the same instant -- the plan loop
  precedes the execute loop, and within the execute loop the doer stops at a VERIFY
  checkpoint before the reviewer is dispatched. Each reads the committed files in
  place.
- **Parallelism is across tracks.** Two tracks = two worktrees = two full pipelines
  running concurrently, unable to touch each other's files. This is the entire
  reason to use worktrees: file isolation for concurrent work.

Use a single track unless the work splits into genuinely independent, low-coupling
units (see `sprint.md` Parallel tracks). A single track is one worktree and is the
common case.

## Lifecycle (the orchestrator owns this via git)

Create, off the base branch, before dispatching a track:

```
git -C <repo> fetch origin            # if a remote exists; skip if local-only
git -C <repo> worktree add -b <branch> <repo>-wt/<track> <base-ref>
```

`<base-ref>` is `origin/<base>` when a remote exists, or the local `<base>` branch
otherwise. For multiple tracks, create one worktree per track off the same base.

List / inspect at any time:

```
git -C <repo> worktree list
git -C <repo> log --oneline <base>..<branch>     # what a track's doer has committed
git -C <repo> diff <base>...<branch>             # a track's review surface
```

Remove at cleanup (after the PR is raised, or after the track merges into the
integration branch):

```
git -C <repo> worktree remove <repo>-wt/<track>
git -C <repo> branch -d <branch>     # after merge; -D to force-discard
```

If a worktree's `.git` pointer gets corrupted (can happen when a POSIX shell layer
touches a Windows worktree), repair it: `git -C <repo> worktree repair`.

## Transport between roles

Because all worktrees share the object DB, every handoff -- planner to plan-reviewer,
doer to reviewer, track to integration branch -- needs no network. An agent commits
to its track's branch; the orchestrator and the next agent see those commits
immediately via `git log <branch>` / `git diff <base>...<branch>`.

Tell each dispatched agent in its prompt whether a remote exists:

- **Remote present:** the agent may push its commits; pushing is harmless and gives
  durability and a PR target.
- **Local-only:** the agent commits every turn and skips pushing; the shared object
  DB already carries the work to every other worktree and to the orchestrator.

Detect once at the start: `git -C <repo> remote` (empty output means local-only).

## Named, persistent worktrees

Each track's worktree is named and persistent: a stable path, an explicit lifecycle
(created before the track starts, removed at cleanup), and shared by the track's
four roles across the whole pipeline. This matters because a track is dispatched
many times -- the plan loop, then phase after phase, plus CHANGES NEEDED cycles --
and successive roles read the same working tree. The worktree lives for the whole
life of the track so each dispatch lands in the same place.
