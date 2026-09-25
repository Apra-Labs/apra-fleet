<p align="center">
  <img src="assets/lazyfleet-hero.svg" alt="A very relaxed manager naps on a couch with a laptop on his belly while three workers type busily at their desks" width="100%">
</p>

<h1 align="center">lazyfleet</h1>

<p align="center"><b>Claude does the managing. You do the napping.</b></p>

<p align="center">
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-d97757.svg" alt="Works with Claude Code">
  <img src="https://img.shields.io/badge/node-22%2B-339933.svg" alt="Node 22+">
</p>

---

You install it once. After that you use Claude Code exactly as before, and two
annoying things just stop happening:

1. **You stop worrying about pasting secrets.** Drop an API key, a database
   password or a whole `.env` straight into chat. Claude never receives it. It
   gets a stand-in like `{{secure.github_token}}`, and the real value is put
   back only at the moment a command or file edit runs on your machine.
2. **You stop managing anything.** When a job splits into independent pieces,
   Claude spins up helpers on its own, runs them in parallel, merges the work
   and cleans up after itself. There is nothing to name, register or remove.

No config files, no new commands to learn, no vocabulary.

## Install

```bash
git clone -b feat/lazyfleet https://github.com/vbv-nyk/apra-fleet.git lazyfleet
cd lazyfleet && npm install && npm run build && npm link
lazyfleet
```

That last command sets everything up and tells you when it is done. Restart any
open Claude Code sessions. That's it - go lie down.

```
Setting up lazyfleet...

  [1/3] Connecting to Claude Code ........ ok
  [2/3] Starting the background helper ... ok
  [3/3] Routing Claude through it ........ ok
```

Works with a Claude Pro/Max subscription or an API key. Needs Node 22+.

## What it looks like

You type:

> deploy to staging, the token is ghp_Zq8vT2mK9pL4wR8zN3bY6cF1hJ5sD0gA7xE2

Claude sees:

> deploy to staging, the token is {{secure.github_token}}

Claude runs `gh auth login --with-token <<< {{secure.github_token}}`, and your
machine runs it with the real token. The token also gets hidden in everything
that follows: command output, files Claude reads, and earlier messages as the
conversation is re-sent.

## The settings page

```bash
lazyfleet ui
```

Opens a local page (only reachable from your own machine) with:

| Tab | What you get |
|---|---|
| **Vault** | Everything that has been caught, masked. Show, copy the stand-in, add one by hand, remove. |
| **Activity** | A live feed of what was caught and hidden, and where it came from. |
| **Helpers** | Who is working on what right now. Read-only - Claude runs this. |
| **Settings** | How aggressive detection is, how many helpers may run at once, when idle ones get cleaned up, and whether Claude should ask before anything remote or paid. |

## Everyday commands

You will rarely need these.

| Command | Does |
|---|---|
| `lazyfleet ui` | Open the vault and settings page |
| `lazyfleet status` | Is it running, and is Claude going through it |
| `lazyfleet off` | Bypass it for a while (secrets are **not** hidden while off) |
| `lazyfleet on` | Switch back on |
| `lazyfleet uninstall` | Undo every change it made. Your vault is kept. |

## How the secret hiding works

```
 Claude Code  --->  lazyfleet (127.0.0.1)  --->  Anthropic API
                    - hide secrets going out
                    - put them back in tool calls coming in
```

Claude Code lets you point it at a different API address. lazyfleet sets that to
a small proxy on your own machine, which forwards everything to Anthropic after
cleaning it:

- **Outgoing.** Every secret already in the vault is swapped for its stand-in,
  wherever it appears. New secrets are caught in what you type and in tool output,
  using known key formats (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack, Google,
  JWTs, private keys...), context (`DB_PASSWORD=...`, `user:pass@host`,
  "my password is ..."), and random-looking strings you paste. Anything you write
  as `secret: VALUE` is always caught.
- **Incoming.** When Claude uses a stand-in in a command or a file, the real value
  is put back before Claude Code runs it. This works even when the stand-in
  arrives split across the streamed response.
- **Fails closed.** If a request cannot be checked, it is refused, not sent.
- **Stored encrypted** (AES-256-GCM) on disk, readable only by your user.

### Honest limits

- The real value still exists **on your machine**: in your terminal scrollback,
  and in Claude Code's local conversation files. The promise is "never sent to
  the model", not "never on disk".
- Detecting a brand-new secret in an unusual format is best-effort. If you want
  a guarantee, write it as `secret: VALUE`, or add it on the settings page first.
- Values shorter than 6 characters are not hidden. They would match too much
  ordinary text.
- If the background helper is down while Claude is routed through it, Claude
  cannot connect. That is deliberate (failing closed). `lazyfleet status` tells
  you, and `lazyfleet on` or `lazyfleet off` fixes it.
- Removing a secret from the vault means it stops being hidden, including in
  older conversations that already used it.

## How the helpers work

When a task splits into independent pieces - several bug fixes, a refactor across
unrelated modules, separate test suites - Claude creates a helper for each piece
in its own copy of the repo, runs them in parallel, merges the results and removes
the helpers. It keeps doing small jobs itself, because splitting a two-line fix
only slows it down.

Helpers on your machine need no permission and cost nothing extra. Anything that
would run on another machine or cost money is still asked about first, in plain
terms ("this would start billing at about $X/hour - go ahead?"), unless you turn
that off in Settings. Helpers that are left idle get cleaned up automatically.

## Under the hood

lazyfleet is a thin layer on top of
[Apra Fleet](https://github.com/Apra-Labs/apra-fleet), an open-source MCP server
for coordinating AI agents across machines. Everything Apra Fleet can do is still
there. See the [full reference](docs/reference.md) for the underlying tools,
multi-provider setup, remote machines, cloud compute and the PM workflow.

| Where | What |
|---|---|
| `src/lazy/` | The whole layer: proxy, detection, vault, settings page, service, CLI |
| `~/.lazyfleet/` | Settings, activity log, vault metadata |
| `~/.claude/settings.json` | One line: `env.ANTHROPIC_BASE_URL` |

Development: `npm test` runs everything; `tests/lazy-*.test.ts` cover the layer.

## License

Apache 2.0 - see [LICENSE](LICENSE). Built on Apra Fleet by Apra Labs.
