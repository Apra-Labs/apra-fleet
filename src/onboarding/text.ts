/**
 * All user-facing onboarding text constants.
 * Logic never constructs display text directly — it always imports from here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOKEN COST ANALYSIS — onboarding UX overhead
 * ─────────────────────────────────────────────────────────────────────────────
 * Methodology: ASCII text ~4 chars/token; box-drawing & unicode ~1-2 chars/token.
 * These tokens are added to MCP tool responses and consumed by the model.
 *
 * ONE-TIME costs (shown once ever, on first tool call after install):
 *   BANNER                      678 chars  → ~380 tokens
 *   GETTING_STARTED_GUIDE      1134 chars  → ~346 tokens
 *   ─────────────────────────────────────
 *   Total one-time cost:                    ~726 tokens  (single response, never repeated)
 *
 * RECURRING costs (once per server lifecycle, after first run):
 *   WELCOME_BACK()              143–152 chars → ~75 tokens
 *   ─────────────────────────────────────
 *   Total recurring cost:                   ~75 tokens/server-start
 *
 * NUDGE costs (each shown at most once across the user's entire journey):
 *   NUDGE_AFTER_FIRST_REGISTER  252 chars  → ~114–115 tokens  (local or remote variant)
 *   NUDGE_AFTER_FIRST_PROMPT    252 chars  → ~115 tokens
 *   NUDGE_AFTER_MULTI_MEMBER    315 chars  → ~133 tokens
 *   ─────────────────────────────────────
 *   Total nudge cost (all):                 ~363 tokens  (spread across multiple sessions)
 *
 * Summary:
 *   First server start ever:    ~726 tokens  (banner + guide; welcome-back skipped on first run)
 *   Subsequent server starts:    ~75 tokens  (welcome-back only)
 *   Full onboarding journey:   ~1164 tokens  (one-time + welcome-back + all nudges)
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
│     'Send the src/ folder to my-server and run the build'          │
│                                                                    │
│  3. See what's happening                                           │
│     'Show fleet status'                                            │
│                                                                    │
│  Docs: https://github.com/Apra-Labs/apra-fleet                    │
└────────────────────────────────────────────────────────────────────┘`;

/**
 * Welcome-back message shown once per server lifecycle (not on first run).
 * @param memberCount  Total number of registered members
 * @param lastActive   Relative time string, e.g. "2h ago" or "unknown"
 */
export function WELCOME_BACK(memberCount: number, lastActive: string): string {
  if (memberCount === 0) {
    return '── Apra Fleet ──────────────────────────────────────\nFleet ready. Register a member to get started.\n────────────────────────────────────────────────────';
  }
  const plural = memberCount !== 1 ? 's' : '';
  return `── Apra Fleet ──────────────────────────────────────\nFleet: ${memberCount} member${plural} · Last active: ${lastActive}\n────────────────────────────────────────────────────`;
}

/**
 * Nudge shown after the user registers their first member.
 * @param memberType  "local" | "remote"
 * @param memberName  Registered name to show in the example (default: "my-server")
 */
export function NUDGE_AFTER_FIRST_REGISTER(memberType: string, memberName = 'my-server'): string {
  if (memberType === 'remote') {
    return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🔑 Upgrade to key-based auth for this member:              │\n│    'Set up key-based auth for this member' — more secure.  │\n└────────────────────────────────────────────────────────────┘`;
  }
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🚀 Member registered! Give it work:                        │\n│    'Ask ${memberName} to run the test suite'${' '.repeat(Math.max(1, 28 - memberName.length))}│\n└────────────────────────────────────────────────────────────┘`;
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
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🤝 You have multiple members — try the PM skill:           │\n│    /pm init  →  /pm pair  →  /pm plan                      │\n│    One member builds, another reviews — across machines.   │\n└────────────────────────────────────────────────────────────┘`;
}

/**
 * Server-level instruction injected once at `initialize` time.
 * Instructs the LLM to reproduce verbatim any text inside <apra-fleet-display> tags.
 */
export const VERBATIM_INSTRUCTIONS = `When a tool response contains text wrapped in \`<apra-fleet-display>…</apra-fleet-display>\` tags, that content is user-facing onboarding material. Reproduce it VERBATIM in your reply to the user as the very first thing you output, preserving all formatting, line breaks, and emoji. Do not paraphrase, summarize, translate, or comment on it. Do not wrap it in code fences. Strip the \`<apra-fleet-display>\` tags themselves — they are for your recognition only.`;
