/**
 * All user-facing onboarding text constants.
 * Logic never constructs display text directly — it always imports from here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOKEN COST ESTIMATE — onboarding UX overhead
 * ─────────────────────────────────────────────────────────────────────────────
 * Token counts are approximate (GPT-4 / Claude tokenization, ~4 chars/token).
 * These tokens are added to MCP tool responses and consumed by the model.
 *
 * ONE-TIME costs (shown once ever, on first tool call after install):
 *   BANNER                      ~120 tokens
 *   GETTING_STARTED_GUIDE       ~250 tokens
 *   ─────────────────────────────────────
 *   Total one-time cost:        ~370 tokens  (single response, never repeated)
 *
 * RECURRING costs (once per server lifecycle, after first run):
 *   WELCOME_BACK()              ~20 tokens
 *   ─────────────────────────────────────
 *   Total recurring cost:       ~20 tokens/server-start
 *
 * NUDGE costs (each shown at most once across the user's entire journey):
 *   NUDGE_AFTER_FIRST_REGISTER  ~25 tokens
 *   NUDGE_AFTER_FIRST_PROMPT    ~20 tokens
 *   NUDGE_AFTER_MULTI_MEMBER    ~35 tokens
 *   ─────────────────────────────────────
 *   Total nudge cost (all):     ~80 tokens  (spread across multiple sessions)
 *
 * Summary:
 *   First server start ever:    ~390 tokens  (banner + guide + welcome-back skipped on first run)
 *   Subsequent server starts:   ~20 tokens   (welcome-back only)
 *   Full onboarding journey:    ~450 tokens  (one-time + all nudges, amortized over many calls)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const BANNER = `────────────────────────────────────────────────────────────────────────────────

 █████╗ ██████╗ ██████╗  █████╗     ███████╗██╗     ███████╗███████╗████████╗
██╔══██╗██╔══██╗██╔══██╗██╔══██╗    ██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝
███████║██████╔╝██████╔╝███████║    █████╗  ██║     █████╗  █████╗     ██║
██╔══██║██╔═══╝ ██╔══██╗██╔══██║    ██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║
██║  ██║██║     ██║  ██║██║  ██║    ██║     ███████╗███████╗███████╗   ██║
╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝

              ⚡ One model is a tool. A fleet is a team. ⚡

────────────────────────────────────────────────────────────────────────────────`;

export const GETTING_STARTED_GUIDE = `
┌─ Getting Started ──────────────────────────────────────────────────────────┐
│                                                                             │
│  1. Register a member                                                       │
│     • This machine:  register_member (member_type="local")                  │
│     • Remote via SSH: register_member (member_type="remote")                │
│     Isolate work per task, parallelize across machines.                     │
│                                                                             │
│  2. Run your first prompt                                                   │
│     execute_prompt — send an AI task to any member                          │
│                                                                             │
│  3. Check fleet status                                                      │
│     fleet_status — see all members, who's online, last activity             │
│                                                                             │
│  4. Scale up with the PM skill                                              │
│     Orchestrate multi-step work with doer-reviewer pairs.                   │
│     /pm init  →  /pm pair  →  /pm plan                                     │
│     Scale from solo to a coordinated team in minutes.                       │
│                                                                             │
│  Docs & help:  https://github.com/wayfaringbit/apra-fleet                  │
└─────────────────────────────────────────────────────────────────────────────┘`;

/**
 * Welcome-back message shown once per server lifecycle (not on first run).
 * @param memberCount  Total number of registered members
 * @param onlineCount  Number of members currently reachable
 * @param lastActive   Relative time string, e.g. "2h ago" or "unknown"
 */
export function WELCOME_BACK(memberCount: number, onlineCount: number, lastActive: string): string {
  if (memberCount === 0) {
    return '┌─ Apra Fleet ─────────────────────────────────┐\n│ Fleet ready. Register a member to get started. │\n└────────────────────────────────────────────────┘';
  }
  return `┌─ Apra Fleet ─────────────────────────────────────────────────┐\n│ Fleet: ${memberCount} member${memberCount !== 1 ? 's' : ''}, ${onlineCount} online. Last active: ${lastActive}. │\n└──────────────────────────────────────────────────────────────┘`;
}

/**
 * Nudge shown after the user registers their first member.
 * @param memberType "local" | "remote"
 */
export function NUDGE_AFTER_FIRST_REGISTER(memberType: string): string {
  if (memberType === 'remote') {
    return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🔑 Upgrade to key-based auth for this member:              │\n│    setup_ssh_key — no more passwords, more secure.         │\n└────────────────────────────────────────────────────────────┘`;
  }
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🚀 Member registered! Run your first AI prompt:            │\n│    execute_prompt — send a task to this member.            │\n└────────────────────────────────────────────────────────────┘`;
}

/**
 * Nudge shown after the user runs their first prompt.
 */
export function NUDGE_AFTER_FIRST_PROMPT(): string {
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 📊 Monitor your fleet anytime:                             │\n│    fleet_status — online members, last activity, sessions. │\n└────────────────────────────────────────────────────────────┘`;
}

/**
 * Nudge shown after the user registers 2+ members (introduces PM skill).
 */
export function NUDGE_AFTER_MULTI_MEMBER(): string {
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🤝 You have multiple members — try the PM skill:           │\n│    /pm init  →  /pm pair  →  /pm plan                      │\n│    Coordinate doer-reviewer pairs across your fleet.       │\n└────────────────────────────────────────────────────────────┘`;
}
