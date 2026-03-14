#!/bin/bash
# PostToolUse hook for mcp__fleet__register_member
# Nudges the PM to run the member onboarding checklist after registration.
# All intelligence lives in the skill docs — this is just the trigger.
#
# Installed by install.sh into the user's ~/.claude/settings.json hook config.
# Hook input (stdin): JSON with tool_name, tool_input, session_id, etc.

cat <<'ONBOARDING'
New member registered. Run the onboarding checklist:

1. For remote members setup key based authentication
2. Disable AI attribution (.claude/settings.json)
3. Detect VCS provider (git remote -v on member)
4. Determine roles — ask user
5. Setup VCS auth per auth-{provider}.md
6. Install required skills per skill-matrix.md
7. Update member status file with profile

See onboarding.md in the PM skill for the full flow.
ONBOARDING
