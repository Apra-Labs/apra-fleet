# Implementation Plan: Fix Windows Installer File Lock Issue

**Issue:** #96  
**Complexity:** Medium-Complex (platform-specific code, process management)

## Problem Summary

On Windows, reinstalling apra-fleet while the MCP server is running fails because the OS holds a file lock on the executing binary. The installer cannot overwrite `apra-fleet.exe` while it is in use.

## Root Cause

Windows locks executables while they are running. `apra-fleet.exe` is loaded as an MCP server by Claude Code, so it remains running in the background. Any attempt to overwrite it during installation hits a file-lock error.

## Implementation Plan

### Phase 1: Detection
- [ ] Research process detection methods on Windows
  - Process name matching (`apra-fleet.exe`)
  - PID file approach
  - Port-based detection (if MCP server listens on a port)
- [ ] Implement detection in installer scripts
  - `install.cmd` for Windows batch
  - `install.ps1` for PowerShell

### Phase 2: Graceful Shutdown
- [ ] Option 1: HTTP shutdown endpoint
  - Add `/shutdown` endpoint to MCP server
  - Installer calls endpoint before replacing binary
  - Wait for process to exit (with timeout)
- [ ] Option 2: Process termination
  - Use `taskkill /IM apra-fleet.exe` on Windows
  - Implement with fallback to `/F` flag if graceful fails
- [ ] Implement shutdown logic in installer

### Phase 3: Binary Replacement
- [ ] Verify process has stopped before copying
- [ ] Copy new binary with retry logic (handle lingering locks)
- [ ] Set appropriate permissions

### Phase 4: Restart/Notification
- [ ] Option 1: Auto-restart MCP server
  - May not work if Claude Code needs to reload config
- [ ] Option 2: Notify user to restart Claude Code
  - Print clear instructions
  - Detect Claude Code process and suggest specific restart

### Phase 5: Testing
- [ ] Test on Windows with MCP server running
- [ ] Test graceful shutdown
- [ ] Test forced shutdown
- [ ] Test when server is not running
- [ ] Test restart/notification flow

## Estimated Effort
4-6 hours

## Files Affected
- `install.cmd` (Windows batch installer)
- `install.ps1` (PowerShell installer)
- Possibly `src/index.ts` if adding shutdown endpoint
- Documentation/README with installation notes
