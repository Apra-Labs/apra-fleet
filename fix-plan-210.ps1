$f = 'C:/akhil/git/apra-fleet-2/PLAN.md'
$c = [System.IO.File]::ReadAllText($f)

# Fix 1: Task 3 — add export inFlightAgents and writeStatusline import instructions
$old3 = '- **Change:** When `stop_prompt` is called and `pid=none` (PID was never captured because the process crashed before emitting `FLEET_PID:`), the member may appear busy because `inFlightAgents` still holds the ID. Add an explicit `inFlightAgents.delete(agent.id)` and `writeStatusline()` call in `stop_prompt` so that calling it is always sufficient to unblock the member regardless of PID state.'
$new3 = '- **Change:** When `stop_prompt` is called and `pid=none` (PID was never captured), the member may appear busy because `inFlightAgents` still holds the ID. First, export `inFlightAgents` and `writeStatusline` from `execute-prompt.ts` (change `const inFlightAgents` to `export const inFlightAgents`; ensure `writeStatusline` is already exported from `src/utils/statusline.ts` — import it in stop-prompt.ts). Then add `inFlightAgents.delete(agent.id)` and `writeStatusline()` in `stop_prompt` so it unconditionally clears busy state regardless of PID.'
$c = $c.Replace($old3, $new3)

# Fix 2: Task 3 files — add execute-prompt.ts to files list
$old3f = '- **Files:** `src/tools/stop-prompt.ts`'
$new3f = '- **Files:** `src/tools/execute-prompt.ts` (export inFlightAgents), `src/tools/stop-prompt.ts` (import and use)'
$c = $c.Replace($old3f, $new3f)

# Fix 3: Task 4 — clarify that inFlightAgents is now exported (from Task 3)
$old4 = '- **Change:** After `stop_prompt` kills the process, there is a brief window where the `execCommand` promise resolves and the `finally` block races with the next `execute_prompt` call trying to add to `inFlightAgents`. Add a short cooldown: in `stop_prompt`, after killing the PID, wait for `inFlightAgents.has(agent.id)` to become false (poll with 50ms interval, max 2s) before returning. This ensures the `finally` from the killed session has run before the next call can proceed.'
$new4 = '- **Change:** After `stop_prompt` kills the process, there is a brief window where the `execCommand` promise resolves and the `finally` block races with the next `execute_prompt` call. Using the exported `inFlightAgents` from Task 3, add a poll in `stop_prompt`: after killing the PID, spin with 50ms intervals (max 2s) until `!inFlightAgents.has(agent.id)` before returning. This ensures the `finally` from the killed session has run before the next call proceeds.'
$c = $c.Replace($old4, $new4)

# Fix 4: Task 2 — make offline distinction concrete
$old2 = 'The catch block currently calls `writeStatusline(offline)` — change this to only set offline for genuine connection failures (where `err.message` indicates SSH/network failure), not for normal cancellations. For cancellations, finally''s `writeStatusline()` clears to idle.'
$new2 = 'The catch block currently calls `writeStatusline(offline)` — change this to only set offline for genuine connection failures. Specifically: set offline only when `err` is an SSH/connection error (check `err.message` for patterns like "Connection refused", "ECONNREFUSED", "ssh", "SFTP", "channel"). For `AbortError`, `TimeoutError`, or any error thrown by `AbortController.abort()`, skip the offline marker and let the finally block call `writeStatusline()` to clear to idle.'
$c = $c.Replace($old2, $new2)

[System.IO.File]::WriteAllText($f, $c, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Fixed."
