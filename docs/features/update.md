# Self-Update Command

## What it does

`apra-fleet update` checks GitHub for the latest stable release and, if a newer
version exists, downloads its installer and launches it -- no manual download
step needed.

## Behaviour

1. Prints `Checking for updates...`.
2. Fetches release metadata from
   `https://api.github.com/repos/Apra-Labs/apra-fleet/releases/latest` with a
   5-second timeout. On a non-OK response it prints
   `Error: Could not check for updates (Status: <code>)` and stops.
3. Compares the release tag against the installed version (the `_<hash>` build
   suffix is stripped first). If the tag is a pre-release (`-alpha`, `-beta`,
   `-rc`) or is not newer than the installed version, it prints an
   "up to date" message and stops.
4. Selects the installer asset for the current platform:

   | Platform | Asset |
   |----------|-------|
   | Windows x64 | `apra-fleet-installer-win-x64.exe` |
   | macOS ARM | `apra-fleet-installer-darwin-arm64` |
   | Linux x64 | `apra-fleet-installer-linux-x64` |

   If no matching asset is found it prints
   `Error: Could not find installer for platform <platform>` and stops.
5. Prints `Updating to <tag> -- restarting...`, downloads the installer into the
   system temp directory, and (on macOS/Linux) marks it executable.
6. Spawns the installer detached, then exits immediately with status 0:

   ```
   <installer> install --llm <provider> --skill <skill>
   ```

   The `--llm` and `--skill` values come from `install-config.json` (see below).

Any unexpected error is caught and printed as `Error: Update failed -- <message>`.

## install-config.json

`update` reads `~/.apra-fleet/data/install-config.json` and uses the first
provider entry to recover the `--llm` provider and its `--skill` set, so the
update preserves the original install configuration. If the file is missing or
cannot be parsed, `update` prints a warning and falls back to
`--llm claude --skill all`.

## Important: a running server blocks the update

`apra-fleet update` launches the installer **without `--force`**. The installer
has a running-process guard: if an apra-fleet server is still running, the
installer aborts instead of replacing the binary. On Windows the running
executable is file-locked and cannot be overwritten in any case.

Because `update` spawns the installer detached (with its output discarded) and
exits 0 immediately, it prints `Updating to <tag> -- restarting...` even when the
installer later aborts. **The "restarting" message is not proof the update
completed** -- always verify afterwards:

```
apra-fleet --version
```

To update reliably while a server is running, stop the server first, or run the
installer manually with `--force` -- which stops the running server before
replacing the binary:

```
apra-fleet-installer-<platform> install --force
```

## Notes

- There is no `--check` flag -- `apra-fleet update` always proceeds to install
  when a newer stable release exists.
- The 5-second timeout covers the release-metadata check only; the installer
  download itself is not time-bounded.
- The installer overwrites the binary in place with no `.bak`. To roll back,
  download the previous release's installer and run it with `--force`.
