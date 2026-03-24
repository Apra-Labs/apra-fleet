# Apra Fleet

## What This Repo Is
An MCP server (src/) that manages a fleet of remote/local AI coding agents via SSH. Ships with a PM skill (skills/pm/) that orchestrates long-running work across those agents.

## Key Paths
- src/ - MCP server source (TypeScript)
- skills/pm/ - PM skill definition and templates
- docs/ - documentation
- tests/ - test suite

## Terminology
- member = registered machine in the fleet
- agent = AI coding session running on a member

## Rules
- Run npm test before committing
- Run npm run build before pushing
- Never commit secrets or credentials
