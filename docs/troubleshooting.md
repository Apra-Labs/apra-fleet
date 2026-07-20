# Troubleshooting

Common symptoms and how to resolve them. If something here does not match what
you see, search [GitHub Issues](https://github.com/Apra-Labs/apra-fleet/issues)
or ask in [Discussions](https://github.com/Apra-Labs/apra-fleet/discussions).

## Members

**Member shows as offline**

- Check the machine is reachable: `ping <ip>`.
- For remote members, verify SSH directly: `ssh user@host "echo ok"`.
- If SSH works but the member is still offline, re-provision auth: ask Fleet to
  "Provision auth for `<member>`".

**Empty response from a member**

Usually an expired auth token. Ask Fleet to "Provision auth for `<member>`".
For VCS tokens specifically, re-run `provision_vcs_auth`.

**Auth error (401 / 403)**

- GitHub App tokens: re-mint with `provision_vcs_auth`.
- Bitbucket / Azure DevOps: the token likely expired -- get a fresh one, then
  re-provision and retry. See the `auth-*.md` references in the fleet skill.

**Member blew past a checkpoint**

Check what actually happened on the member:
ask Fleet to run `cat progress.json` on it.

## Permissions

**Permission denied on a member**

Fleet can configure member permissions. Ask it to, for example, "Grant
`build-server` permission to run `npm install`". Under the hood this runs
`compose_permissions`, which writes provider-native config:

| Provider | Config location |
|----------|-----------------|
| Claude | `.claude/settings.local.json` |
| Gemini | `.gemini/policies/` |
| Codex | `.codex/config.toml` (approval mode) |
| Copilot | `.github/copilot/settings.local.json` |

**Permission granted but still denied on Claude**

Claude Code only honors `.claude/settings.local.json` permissions once the
project folder is a **trusted workspace**. If the member's work folder has
never been opened and trusted in Claude Code directly, the permissions Fleet
writes there are inert. Open the folder in Claude Code once and accept the
trust prompt, then retry.

## Timeouts

A dispatch can end in two distinct ways:

- **Inactivity timeout (`timeout_s`)** -- fires when no stdout/stderr output
  arrives for N seconds (default 300s / 5 min). It is transport-level, so it
  applies to every member and provider. The usual cause is a build or test
  runner that buffers output (`npm test`, `vitest`, `cargo build`) and stays
  silent for long stretches even while working. Fix: raise `timeout_s` to
  600-1200 for build/test dispatches.
- **Total timeout (`max_total_s`)** -- fires after N seconds of wall-clock time
  regardless of output. Use it as a hard ceiling on long jobs, alongside
  `timeout_s` when you want both a silence guard and a wall-clock cap.

## Credentials

**A token or password appeared in command output**

Store the secret with `credential_store_set`, then reference it as
`{{secure.NAME}}` in `execute_command`. Fleet redacts it to `[REDACTED:NAME]`
before the LLM ever sees the output. See
[docs/features/oob-auth.md](features/oob-auth.md).

**Rotate a credential without re-provisioning**

Run `credential_store_delete name=<NAME>` then `credential_store_set
name=<NAME>`. The new value is picked up immediately on the next
`execute_command` that references `{{secure.NAME}}`.

## Git

**Cannot push workflow files or merge PRs from a member**

Minted VCS tokens may lack CI/CD permissions. Run those operations from your
main AI coding session instead -- it has your full git credentials. See
[docs/design-git-auth.md](design-git-auth.md).

## Stuck agents

**A member is stuck after a session reset**

Escalate the model tier (cheap -> standard -> premium) and retry. If it is still
stuck, the task likely needs a human decision -- inspect `progress.json` and
intervene directly.

## Logs

For unexplained behavior -- missing output, silent failure, unexpected results
-- check the server logs:

```
$APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log
```

These are JSON lines. Filter by member or by tool with `jq`:

```bash
jq 'select(.member_id == "<uuid>")' fleet-<pid>.log
jq 'select(.tag == "<tool>")'       fleet-<pid>.log
```

The **Fleet Logs** section of the fleet skill's `SKILL.md` has the full field
reference and more `jq` examples.
