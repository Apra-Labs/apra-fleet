/**
 * All user-facing onboarding text constants.
 * Logic never constructs display text directly — it always imports from here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOKEN COST ANALYSIS — onboarding UX overhead (notification-hybrid delivery)
 * ─────────────────────────────────────────────────────────────────────────────
 * Methodology: ASCII text ~4 chars/token; box-drawing & unicode ~1-2 chars/token.
 * Run `node count_tokens.mjs` to reproduce. All numbers below are LLM-context
 * tokens (input + output) — NOT wire bytes.
 *
 * Delivery model:
 *   • Banner/welcome-back/nudges are returned as tool-result content blocks
 *     wrapped in <apra-fleet-display>…</apra-fleet-display> markers, plus a
 *     one-time server `instructions` field telling the LLM to reproduce them
 *     verbatim. The same text is also emitted via MCP `sendLoggingMessage`.
 *   • sendLoggingMessage payloads are OUT-OF-BAND: they cost wire bytes but
 *     NOT LLM-context tokens (they are not added to the conversation).
 *
 * PER-CONNECTION cost (paid once at `initialize`, into the system prompt):
 *   VERBATIM_INSTRUCTIONS       457 chars  → ~115 tokens
 *   ─────────────────────────────────────
 *   Cost per MCP server start:              ~115 tokens
 *
 * ONE-TIME banner cost (shown once ever, on first active tool call):
 *   BANNER                      678 chars  → ~380 tokens
 *   GETTING_STARTED_GUIDE      1134 chars  → ~346 tokens
 *   Marker wrapper overhead                → ~11 tokens
 *   ─────────────────────────────────────
 *   Banner+Guide wrapped:                   ~737 tokens  (single response, never repeated)
 *
 * RECURRING welcome-back (once per server lifecycle after first run):
 *   WELCOME_BACK()              143–152 chars → ~75 tokens
 *   Marker wrapper overhead                → ~10 tokens
 *   ─────────────────────────────────────
 *   WELCOME_BACK wrapped:                   ~85 tokens/server-start
 *
 * NUDGE costs (each shown at most once across the user's entire journey):
 *   NUDGE_AFTER_FIRST_REGISTER  252 chars  → ~114–115 tokens  +wrap → ~125 tokens
 *   NUDGE_AFTER_FIRST_PROMPT    252 chars  → ~115 tokens       +wrap → ~126 tokens
 *   NUDGE_AFTER_MULTI_MEMBER    315 chars  → ~133 tokens       +wrap → ~143 tokens
 *   ─────────────────────────────────────
 *   All nudges wrapped (sum):               ~395 tokens  (spread across sessions)
 *
 * Lifecycle totals:
 *   Fresh-install, first server start:  ~852 tokens  (115 init + 737 bannerWrapped)
 *   Fresh-install, full journey:       ~1247 tokens  (115 init + 737 banner + 395 nudges)
 *   Returning user per server start:    ~200 tokens  (115 init + 85 WB)
 *
 * Delta vs. pre-notification implementation:
 *   Per-connection:  +115 tokens  (new VERBATIM_INSTRUCTIONS — paid every server start)
 *   Per message:      +10-11 tokens/section (marker wrapping)
 *   Full journey:    ~+83 tokens  over baseline ~1164
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
  const displayName = memberName.length > 20 ? memberName.slice(0, 20) + '…' : memberName;
  if (memberType === 'remote') {
    return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🔑 Upgrade to key-based auth for this member:              │\n│    'Set up key-based auth for this member' — more secure.  │\n└────────────────────────────────────────────────────────────┘`;
  }
  return `\n┌─ Tip ──────────────────────────────────────────────────────┐\n│ 🚀 Member registered! Give it work:                        │\n│    'Ask ${displayName} to run the test suite'${' '.repeat(Math.max(1, 28 - displayName.length))}│\n└────────────────────────────────────────────────────────────┘`;
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
