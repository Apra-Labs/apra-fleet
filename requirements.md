# Requirements — Onboarding & User Engagement

## Base Branch
`main` — branch to fork from and merge back to

## Goal
Add a first-run onboarding experience and progressive user engagement system to Apra Fleet. When a user installs and first interacts with the MCP server, they should see a branded welcome (ASCII banner + tagline), a concise getting-started guide, and then receive contextual nudges throughout their journey that introduce features at the right moment.

## Scope

### 1. One-Time ASCII Banner
- Display the following banner exactly once — on the first meaningful interaction after install:
```
────────────────────────────────────────────────────────────────────────────────

 █████╗ ██████╗ ██████╗  █████╗     ███████╗██╗     ███████╗███████╗████████╗
██╔══██╗██╔══██╗██╔══██╗██╔══██╗    ██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝
███████║██████╔╝██████╔╝███████║    █████╗  ██║     █████╗  █████╗     ██║   
██╔══██║██╔═══╝ ██╔══██╗██╔══██║    ██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║   
██║  ██║██║     ██║  ██║██║  ██║    ██║     ███████╗███████╗███████╗   ██║   
╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝   

              ⚡ One model is a tool. A fleet is a team. ⚡

────────────────────────────────────────────────────────────────────────────────
```
- Must never show again after first display
- Track state with a persistent flag (e.g., `~/.apra-fleet/data/onboarding.json`)

### 2. Getting Started Guide
After the banner, present a concise guide covering:
- How to register the first member (local or remote) and why ("isolate work, parallelize tasks")
- How to run the first prompt on a member
- How to check fleet status
- Brief intro to the PM skill — what it does ("orchestrate multi-step work with doer-reviewer pairs"), why to use it ("scale from solo to coordinated team"), how to start (`/pm init`, `/pm pair`, `/pm plan`)
- Where to find docs / help

### 3. Progressive Contextual Nudges
Guide the user through their journey with one-time hints at the RIGHT moment:
- After registering first member → suggest SSH key setup (remote) or running first prompt (local)
- After first prompt execution → introduce fleet_status for monitoring
- After registering 2+ members → introduce the PM skill and doer-reviewer pairing
- After first review cycle complete → celebrate the milestone
- Keep each nudge short (1-3 lines), show each at most once

### 4. Welcome-Back Messages
On subsequent server startups (not first run), show a subtle one-liner with fleet state:
- Example: "Fleet: 3 members, 2 online. Last active: 2h ago."
- Not on every tool call — just once per server lifecycle

### 5. UI/UX for Inline Systems
All output goes through MCP tool response text — no GUI, no browser. Design for:
- Monospace terminal rendering
- Scannable formatting (box-drawing chars, indentation, sparse emoji)
- Progressive disclosure — don't dump everything at once
- Respect user attention — nudges should feel helpful, not nagging

## Out of Scope
- Interactive prompts or input collection during onboarding (MCP is output-only)
- Onboarding for the PM skill itself (that's the PM skill's responsibility)
- Telemetry or usage analytics
- Multi-language / i18n support

## Constraints
- No new production dependencies
- Must work in SEA binary mode (embedded assets) and dev mode
- State file must respect `APRA_FLEET_DATA_DIR` override
- Must not break existing tool response formats — onboarding text is prepended, not replacing
- All text constants in a separate module (easy to update without touching logic)

## Acceptance Criteria
- [ ] First tool call after fresh install shows ASCII banner + getting started guide
- [ ] Banner never appears again on subsequent calls
- [ ] Contextual nudges appear after the correct trigger events, each at most once
- [ ] Welcome-back message appears once per server lifecycle (not first run)
- [ ] All onboarding state persists across server restarts
- [ ] Re-install / upgrade preserves onboarding state (doesn't re-trigger banner for existing users)
- [ ] All existing tests pass, new tests cover onboarding logic
- [ ] Works in both dev mode and SEA binary mode
