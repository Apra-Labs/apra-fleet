## Summary

`send_files` and `receive_files` MCP tools both fail with **`No such file`** when the driver is a Linux machine and the target is a Windows member, even when the file demonstrably exists on disk. Linux↔Linux transfers appear unaffected.

## Environment

- **Driver:** kashyap@apra-linux — local Linux, apra-fleet v0.1.8.0_1ee188
- **Target:** `regenmed-dev` member — Windows on 100.84.84.20:22 (Tailscale), work_folder = `C:\Users\Kashyap\bkp\source\repos\incytes-app-30`

## Failing Cases

### Case 1 — receive_files with dotted path
```json
{
  "member_name": "regenmed-dev",
  "remote_paths": [".claude/skills/fhir-regenmed-mapper/SKILL.md"],
  "local_dest_dir": "/tmp/regenmed-skill-update"
}
```
**Result:** `❌ Failed to download 1 file(s): SKILL.md: No such file`
**File exists:** PowerShell `Get-Item` confirms 20727 bytes

### Case 2 — receive_files with non-dotted path
```json
{
  "member_name": "regenmed-dev",
  "remote_paths": ["_staging/SKILL.md"],
  "local_dest_dir": "/tmp/regenmed-skill-update"
}
```
**Result:** `❌ Failed to download 1 file(s): SKILL.md: No such file`

### Case 3 — receive_files with absolute Windows path
```json
{
  "member_name": "regenmed-dev",
  "remote_paths": ["C:\\Users\\Kashyap\\bkp\\source\\repos\\incytes-app-30\\_staging\\SKILL.md"],
  "local_dest_dir": "/tmp/regenmed-skill-update"
}
```
**Result:** `❌ Failed to download 1 file(s): SKILL.md: No such file`

### Case 4 — send_files with absolute local path
```json
{
  "member_name": "regenmed-dev",
  "local_paths": ["/tmp/regenmed-skill-update/SKILL.md"],
  "dest_subdir": "_staging"
}
```
**Result:** `❌ Failed to upload 1 file(s): SKILL.md: No such file. Destination: C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging`

### Case 5 — send_files with freshly named copy
```json
{
  "member_name": "regenmed-dev",
  "local_paths": ["/tmp/regenmed-skill-update/SKILL_v2.md"],
  "dest_subdir": "_staging"
}
```
**Result:** `❌ Failed to upload 1 file(s): SKILL_v2.md: No such file. Destination: C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging`

## Working Case (for contrast)
`send_files` from Linux driver to local Linux member (`/home/kashyap/repos/apra/apra-edge-vision`) works correctly.

## Suspected Source
**PR #97** (d0139ff) merged 2026-04-08 — explicitly renamed parameters in send_files and receive_files. This is the most recent change to the affected tools.

## Hypothesis
The rename may have touched a path-resolution code path that handles Windows-style remote paths differently from Linux-style ones, breaking either:
- Remote SFTP path resolution
- Local path validation
- Error reporting layer

The bug is P0 — it blocks all file transfer to/from Windows members; the only workaround is base64-over-execute_command.
