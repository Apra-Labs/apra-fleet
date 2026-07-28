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
  }

  export function resolveFleetServerConnection(
    deps?: FleetResolutionDeps,
  ): Promise<FleetServerConnection>;

  export function checkRunningInstance(
    deps?: unknown,
  ): Promise<{ running: true; url: string; pid: number } | { running: false }>;

  export function resolveFleetServerCommand(
    deps?: FleetResolutionDeps,
  ): { command: string; args: string[] };
}
