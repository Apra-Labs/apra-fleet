#!/bin/bash
# PostToolUse hook for mcp__fleet__register_agent
# Nudges the PMO to run the agent onboarding checklist after registration.
# All intelligence lives in the skill docs — this is just the trigger.
#
# Installed by install.sh into the user's ~/.claude/settings.json hook config.
# Hook input (stdin): JSON with tool_name, tool_input, session_id, etc.

cat <<'ONBOARDING'
New agent registered. Run the agent onboarding checklist:

1. Detect VCS provider (git remote -v on agent)
2. Determine agent role(s) — ask user
3. Map roles to required VCS scopes
4. Check existing auth on agent
5. Guide token setup if needed (see provider-specific docs)
6. Deploy credentials via provision_vcs_auth
7. Install required skills (see skill-matrix.md)
8. Update agent status file with Agent Profile section

See docs/agent-onboarding.md in the PMO skill for the full flow.
ONBOARDING
