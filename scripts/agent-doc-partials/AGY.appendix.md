## Non-Interactive Print Mode Keep-Alive Rule
If you are running in non-interactive print mode (such as via `agy -p` / `--print`) and are waiting for a background task or checkpoint:
- **YOU MUST CALL A TOOL ON EVERY TURN** (e.g. `run_command` checking status, reading a log file, or scheduling a timer/check).
- **NEVER** return a text-only response (a turn with no tool calls) until the entire task/sprint/phase is fully completed. A text-only response will cause the CLI manager to exit immediately, aborting the run.
