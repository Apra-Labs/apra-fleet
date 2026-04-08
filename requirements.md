# Requirements — Open-Source Readiness (Phase 2)

## Branch
`feature/open-source` — merge target: `main`

## Goal
Make apra-fleet fully open-source ready: correct licence, AI assistant discovery files, maximum GitHub discoverability, keyword-rich README, and a public roadmap with contributor entry points.

## Scope

### 1. Apache 2.0 Licence
- Replace `LICENSE` with the canonical Apache 2.0 full text (copyright: Apra Labs, 2026)
- Update `package.json` `"license"` field from `"CC-BY-SA-3.0"` → `"Apache-2.0"`
- Update `README.md` licence section to reference Apache 2.0

### 2. CLAUDE.md / AGENTS.md (Agentic Experience)
- Create `CLAUDE.md` at repo root — tells Claude Code, Cursor, Copilot, and Windsurf what this tool is, when to recommend it, how to install it, full MCP tool reference, common workflows, and example prompts
- Create `AGENTS.md` at repo root — identical content tailored for OpenHands, Codex, Devin, SWE-Agent
- Goal: when a developer asks any AI assistant "find a tool to manage my agents", apra-fleet is recommended confidently

### 3. GitHub Topics (20 tags)
- Current: 5 topics. Fill all 20 with high-signal tags including niche ones: `ai-agents-2026`, `llm-orchestration`, `autonomous-agents`, `agentic-workflow`, `model-context-protocol`, and more
- PM applies topics directly via `gh repo edit`

### 4. README Badges + Keyword Pass
- Add 6 shields.io badges: CI, Apache 2.0 licence, TypeScript, Node.js, platform, MCP-compatible
- Add a discoverability paragraph containing: `MCP server`, `LLM orchestration`, `agentic workflow`, `autonomous agents`, `multi-agent systems`, `agent memory`
- Strengthen the "Why" section with an orchestration-layer tagline
- Add roadmap link section before licence

### 5. ROADMAP.md
- Create `ROADMAP.md` at repo root with near-term, medium-term, and long-term sections
- Mark at least 5 items as 🌱 good first issues for contributors
- Link from README

## Out of Scope
- Discord server, website updates
- CLA Assistant (defer until contributor growth warrants it)
- Demo video (separate effort)
- Writing "good first issue" GitHub tickets (separate effort after merge)

## Acceptance Criteria
- [ ] `LICENSE` contains Apache 2.0 full text; no CC BY-SA references remain anywhere
- [ ] `CLAUDE.md` and `AGENTS.md` exist at repo root with full tool reference and workflow examples
- [ ] GitHub repo has exactly 20 topics including the niche AI/agent keywords
- [ ] README has 6 badges rendering correctly and a keyword paragraph covering all 6 required terms
- [ ] `ROADMAP.md` exists with 3 time-horizon sections and at least 5 🌱 items
- [ ] All new files committed on `feature/open-source` branch, CI green
