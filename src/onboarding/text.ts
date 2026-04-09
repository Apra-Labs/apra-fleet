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
 *   GETTING_STARTED_GUIDE       ~230 tokens
 *   ─────────────────────────────────────
 *   Total one-time cost:        ~350 tokens  (single response, never repeated)
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
 *   First server start ever:    ~370 tokens  (banner + guide + welcome-back skipped on first run)
 *   Subsequent server starts:   ~20 tokens   (welcome-back only)
 *   Full onboarding journey:    ~430 tokens  (one-time + all nudges, amortized over many calls)
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
┌─ Getting Started ─────────────────────────────────────────────────┐
│                                                                    │
│  1. Add your first member                                          │
│     'Add this machine to the fleet' (local)                        │
│     'Register my-server as a remote member' (SSH)                  │
│     Each member works in its own directory — parallel by design.   │
│                                                                    │
│  2. Give it work                                                   │
│     'Ask my-server to run the test suite'                          │
│     'Send this prompt to my-server: <task>'                        │
│                                                                    │
│  3. See what's happening                                           │
│     'Show fleet status'                                            │
│                                                                    │
│  4. Orchestrate with /pm                                           │
│     Plan, build, and review across members — like a dev team.      │
│     /pm init → /pm pair → /pm plan → /pm start                    │
│                                                                    │
│  Docs: https://github.com/Apra-Labs/apra-fleet                    │
└────────────────────────────────────────────────────────────────────┘`;

/**
 * Welcome-back message shown once per server lifecycle (not on first run).
 * @param memberCount  Total number of registered members
 * @param onlineCount  Number of members currently reachable
 * @param lastActive   Relative time string, e.g. "2h ago" or "unknown"
 */
export function WELCOME_BACK(memberCount: number, onlineCount: number, lastActive: string): string {
  if (memberCount === 0) {
    return '── Apra Fleet ──────────────────────────────────────\nFleet ready. Register a member to get started.\n────────────────────────────────────────────────────';
  }
  const plural = memberCount !== 1 ? 's' : '';
  return `── Apra Fleet ──────────────────────────────────────\nFleet: ${memberCount} member${plural}, ${onlineCount} online · Last active: ${lastActive}\n────────────────────────────────────────────────────`;
}

/**
 * Nudge shown after the user registers their first member.
 * @param memberType "local" | "remote"
 */
export function NUDGE_AFTER_FIRST_REGISTER(memberType: string): string {
  if (memberType === 'remote') {
    return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🔑 Upgrade to key-based auth for this member:              │\n│    'Set up key-based auth for this member' — more secure.  │\n└────────────────────────────────────────────────────────────┘`;
  }
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🚀 Member registered! Give it work:                        │\n│    'Ask <member> to run the test suite'                    │\n└────────────────────────────────────────────────────────────┘`;
}

/**
 * Nudge shown after the user runs their first prompt.
 */
export function NUDGE_AFTER_FIRST_PROMPT(): string {
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 📊 Monitor your fleet anytime:                             │\n│    'Show fleet status' — online members, last activity.    │\n└────────────────────────────────────────────────────────────┘`;
}

/**
 * Nudge shown after the user registers 2+ members (introduces PM skill).
 */
export function NUDGE_AFTER_MULTI_MEMBER(): string {
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🤝 You have multiple members — try the PM skill:           │\n│    /pm init  →  /pm pair  →  /pm plan                      │\n│    Coordinate doer-reviewer pairs across your fleet.       │\n└────────────────────────────────────────────────────────────┘`;
}
