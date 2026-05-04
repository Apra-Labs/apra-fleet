# Member Permissions

## Before Dispatch
Call `compose_permissions(member, role)`. Role: `doer` | `reviewer`.
Tool detect stack, select profile, deliver config.

## Denial
Denial in output? Call `compose_permissions` with `grant`.
Tool validate, expand, deliver config.

## Role Switch
Re-run `compose_permissions`.

## Blocked
`sudo`, `su`, `env`, `printenv`, `nc`, `nmap` blocked. Escalate.