#!/bin/bash
# PostToolUse hook for mcp__apra-fleet__register_member
# Self-contained onboarding nudge — works with or without the PM skill.
#
# Installed by install.sh into the user's ~/.claude/settings.json hook config.
# Hook input (stdin): JSON with tool_name, tool_input, session_id, etc.

cat <<'EOF'
{"decision":"block","reason":"New member registered. Run onboarding before dispatching work.","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Onboarding checklist:\n1. Remote members: migrate to SSH key auth via setup_ssh_key (skip for local members)\n2. Check member_detail to confirm connectivity and auth status\n3. Detect VCS provider: execute_command → git remote -v on the member\n4. Provision VCS auth if needed via provision_vcs_auth\n5. Disable AI attribution: execute_command → write {\"attribution\":{\"commit\":\"\",\"pr\":\"\"}} to .claude/settings.json on the member\n6. Ask user for member roles (development, review, testing, devops)\n7. If PM skill is installed, update the project status file with member profile"}}
EOF
