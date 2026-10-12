# Pending release notes

Entries accumulated since the last release. When cutting a release, fold these
into the `gh release edit vX.Y.Z --notes "..."` summary (see
release-playbook.md, section 4), then clear this file.

## Upgrade notes

- **kb-server now binds loopback only (127.0.0.1) by default.** Earlier builds
  bound the OS wildcard address. A team-shared KB server deployment that relied
  on that default becomes unreachable from other machines (clients see
  ECONNREFUSED) after upgrading. Start it with `--host <addr>` (for example
  `--host 0.0.0.0`) to restore remote access. Without `--host`, the server now
  prints a one-line notice on stderr saying it listens on loopback only.
