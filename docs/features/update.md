# Self-Update Command

## What it does

`apra-fleet update` checks GitHub for the latest stable release and, if a newer
version exists, downloads its installer and runs it -- no manual download step
needed.

## Flags

| Command | Effect |
|---------|--------|
| `apra-fleet update` | Check for and install the latest stable release. |
| `apra-fleet update --check` | Report whether a newer release exists, without installing. |
| `apra-fleet update --help` | Show usage. |

## Behaviour

`apra-fleet update` with no flags:

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
6. Spawns the installer detached, then exits with status 0:

   ```
   <installer> install --force --llm <provider> --skill <skill>
   ```

   `--force` makes the installer stop the running apra-fleet server before
   replacing the binary. The `--llm` and `--skill` values come from
   `install-config.json` (see below).

Any unexpected error is caught and printed as `Error: Update failed -- <message>`.

## install-config.json

`update` reads `~/.apra-fleet/data/install-config.json` and uses the first
provider entry to recover the `--llm` provider and its `--skill` set, so the
update preserves the original install configuration. If the file is missing or
cannot be parsed, `update` prints a warning and falls back to
`--llm claude --skill all`.

## Stopping and restarting the server

The installer is run with `--force`, so it stops the running apra-fleet server
(and its workers) before overwriting the binary. The server is not a daemon --
it starts again on demand the next time an LLM CLI connects to it (run `/mcp` in
Claude Code, or restart the CLI).

`update` spawns the installer detached and exits 0 immediately, so it prints
`Updating to <tag> -- restarting...` before the installer has actually finished.
To confirm the new version is in place, check afterwards:

```
apra-fleet --version
```

## Notes

- `apra-fleet update` always installs when a newer stable release exists. Use
  `apra-fleet update --check` first if you only want to see whether one is
  available.
- The 5-second timeout covers the release-metadata check only; the installer
  download itself is not time-bounded.
- The installer overwrites the binary in place with no `.bak`. To roll back,
  download the previous release's installer and run it with `--force`.
