#!/bin/bash
# PostToolUse hook for mcp__fleet__register_agent
# Nudges the PM to run the member onboarding checklist after registration.
# All intelligence lives in the skill docs — this is just the trigger.
#
# Installed by install.sh into the user's ~/.claude/settings.json hook config.
# Hook input (stdin): JSON with tool_name, tool_input, session_id, etc.

cat <<'ONBOARDING'
New member registered. Run the onboarding checklist:

1. Detect VCS provider (git remote -v on member)
2. Determine roles — ask user
3. Setup VCS auth per auth-{provider}.md
4. Install required skills per skill-matrix.md
5. Update member status file with profile

See onboarding.md in the PM skill for the full flow.
ONBOARDING
