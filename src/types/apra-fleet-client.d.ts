/**
 * Ambient types for the workspace ESM package @apralabs/apra-fleet-client.
 * The package ships plain .mjs (no build step, no .d.ts), so TypeScript callers
 * in src/ declare the subpaths they use here.
 *
 * Only the surface actually consumed by src/ is declared -- see
 * packages/apra-fleet-client/src/client/server-resolution.mjs for the source of
 * truth and docs/adr-workflow-server-resolution.md for the contract.
 */
declare module '@apralabs/apra-fleet-client/server-resolution' {
  export type FleetServerConnection =
    | { mode: 'http'; url: string; pid: number; reason: string }
    | { mode: 'stdio'; command: string; args: string[]; reason: string };

  export interface FleetResolutionDeps {
    env?: Record<string, string | undefined>;
    dirname?: string;
    exists?: (candidate: string) => boolean;
    checkRunningInstance?: (deps?: unknown) => Promise<unknown>;
    /** The apra-fleet version this client belongs to; a client inside the
     *  apra-fleet CLI passes its own (clientExpectedVersion in src/version.ts). */
    expectedVersion?: string | null;
  }

  export function resolveFleetServerConnection(
    deps?: FleetResolutionDeps,
  ): Promise<FleetServerConnection>;

  export function checkRunningInstance(
    deps?: unknown,
  ): Promise<
    | { running: true; state: 'running'; url: string; pid: number }
    | { running: false; state: 'unresponsive'; url: string; pid: number; port?: number }
    | { running: false; state: 'gone' }
  >;

  export function resolveFleetServerCommand(
    deps?: FleetResolutionDeps,
  ): { command: string; args: string[] };

  export function connectFleetMember(
    memberId: string,
    deps?: FleetResolutionDeps & { options?: Record<string, unknown>; origin?: 'engine'; kbMaintainer?: boolean },
  ): Promise<{
    transport: { stop(): void; close(): Promise<void> };
    mcpClient: {
      callTool(name: string, args: unknown): Promise<unknown>;
      listTools(): Promise<unknown>;
    };
    mode: 'http';
    url: string;
    close(): Promise<void>;
  }>;
}
