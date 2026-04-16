# Implementation Plan: Slack Notifications for Fleet State Changes

**Issue:** #77  
**Complexity:** Complex (new feature, watcher process, Slack integration)  
**Priority:** Future / Backlog

## Problem Summary

A standalone watcher process that reads `statusline-state.json` periodically and POSTs to a Slack webhook when member state changes.

**Target events:** member hits verify checkpoint, member becomes blocked, member goes offline unexpectedly.

## Implementation Plan

### Phase 1: Design
- [ ] Review `statusline-state.json` format
- [ ] Define notification triggers:
  - Member hits verify checkpoint
  - Member becomes blocked
  - Member goes offline unexpectedly
- [ ] Design configuration:
  - Slack webhook URL per fleet
  - Enabled/disabled flag
  - Notification filtering options

### Phase 2: Watcher Process Implementation
- [ ] Create watcher service:
  - Periodic polling of statusline-state.json
  - State change detection logic
  - Debouncing to avoid notification spam
- [ ] Implement Slack integration:
  - POST to webhook URL
  - Format notification messages
  - Include relevant context (member name, state, timestamp)
  - Handle webhook errors gracefully

### Phase 3: Configuration
- [ ] Add Slack settings to fleet configuration:
  - Webhook URL
  - Enabled flag
  - Polling interval
  - Notification filters
- [ ] Add CLI command or tool to configure Slack:
  - Test webhook connection
  - Enable/disable notifications

### Phase 4: Testing
- [ ] Unit tests for state change detection
- [ ] Integration tests with mock Slack webhook
- [ ] Manual testing with real Slack workspace
- [ ] Test error handling (webhook down, network issues)
- [ ] Test performance impact of polling

### Phase 5: Documentation
- [ ] Setup guide for Slack integration
- [ ] Webhook configuration instructions
- [ ] Notification format examples
- [ ] Troubleshooting guide

## Estimated Effort
8-12 hours (full feature)

## Files Affected
- New watcher service file(s)
- Configuration schema
- CLI or tool for Slack setup
- Documentation
- Tests

## Design Notes

- Watcher reads `statusline-state.json` (already written by the statusline service)
- Configurable webhook URL per fleet
- Subsumes the inter-session attention mechanism (#14) for teams using Slack
- Should be opt-in, not required

## Status

Backlog item #18 from docs/MCP-BACKLOG.md. Future implementation.
