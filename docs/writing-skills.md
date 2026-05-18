# Writing a skill

Fleet ships two skills -- `fleet` (the MCP tool reference) and `pm` (the Project
Manager workflow). A skill is how you package a *workflow* on top of Fleet so it
can be invoked by name and reused. This page explains what a skill is and how to
build your own.

## What a skill is

A skill is a directory of Markdown that your AI coding agent loads as
instructions. It is not compiled code and there is no plugin API to implement --
a skill *describes* a workflow, and the agent carries it out using Fleet's MCP
tools.

The PM skill, for example, is Markdown that tells the agent how to plan a
sprint, dispatch a doer, run a reviewer, and raise a PR. Everything it does, it
does by calling Fleet tools like `register_member` and `execute_prompt`.

## Where skills live

Skills are installed into your provider's skills directory:

| Provider | Directory |
|----------|-----------|
| Claude | `~/.claude/skills/<name>/` |
| Gemini | `~/.gemini/skills/<name>/` |

Fleet's installer writes `fleet/` and `pm/` there. Your own skill is just
another directory alongside them.

## Anatomy

A skill directory contains one required file and any number of supporting ones:

```
my-skill/
  SKILL.md            <- required: the entry point
  helper-notes.md     <- optional: sub-documents the agent reads on demand
  templates/          <- optional: files the skill sends to members
  scripts/            <- optional: helper scripts
```

### SKILL.md

`SKILL.md` opens with YAML frontmatter, then the workflow body:

```markdown
---
name: my-skill
description: One sentence on what this skill does and when to use it.
note: This skill requires the 'fleet' skill to function.
---

# My Skill

You are a ... that ...

## Step 1
...
```

- `name` -- the skill's identifier; matches the directory name.
- `description` -- used to decide when the skill is relevant. Be specific.
- `note` -- optional; declare a dependency on the `fleet` skill if you call
  Fleet MCP tools.

Keep `SKILL.md` focused. Push detail into sub-documents and reference them by
filename so the agent loads them only when needed -- this is how the `pm` skill
keeps `SKILL.md` short while `single-pair-sprint.md`, `doer-reviewer.md`, and
the `tpl-*.md` templates carry the depth.

## The tools a skill can use

A skill coordinates agents through Fleet's MCP tools. The most common:

| Tool | Use |
|------|-----|
| `register_member` | Add a machine or local workspace as a member. |
| `execute_prompt` | Run an AI prompt on a member. |
| `execute_command` | Run a shell command on a member (no tokens). |
| `send_files` / `receive_files` | Move files to and from a member. |
| `compose_permissions` | Generate provider-native permission config. |
| `fleet_status` / `member_detail` | Inspect member state. |

The `fleet` skill documents the full tool set. Your skill should activate the
`fleet` skill (via the `note` field) rather than re-documenting tools.

## Build your own

1. Create `~/.claude/skills/my-skill/SKILL.md` with the frontmatter above.
2. Write the workflow as numbered steps, in plain imperative prose. Reference
   Fleet tools by name where the agent should call them.
3. Move long reference material into sibling `.md` files; link them by filename.
4. Test by invoking the skill in your AI coding agent and watching it run.

## Worked examples

The two skills in this repository are the best reference:

- [`skills/fleet/SKILL.md`](../skills/fleet/SKILL.md) -- the MCP tool reference
  and member-management mechanics.
- [`skills/pm/SKILL.md`](../skills/pm/SKILL.md) -- a full multi-step workflow:
  sprint variants, doer-reviewer pairing, templates, and lifecycle commands.

Read those alongside this page when designing your own.
