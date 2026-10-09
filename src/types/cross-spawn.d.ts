// Minimal typing for cross-spawn (the spawn the MCP SDK's StdioClientTransport
// uses); only the call signature hidden-stdio-transport.ts needs.
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process';
  function crossSpawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  export default crossSpawn;
}
