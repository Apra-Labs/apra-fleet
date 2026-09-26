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

/**
 * apra-fleet-iywi.2.1: only the surface src/console/server.ts consumes is
 * declared here -- see
 * packages/apra-fleet-client/src/auth/local-token.mjs for the source of
 * truth and packages/apra-fleet-client/docs/api-reference.md for the full
 * contract (readLocalToken, loadOrCreateToken, readCookie and the token/
 * private-dir constants are exported there too but unused in src/).
 */
declare module '@apralabs/apra-fleet-client/auth/local-token' {
  export function isAuthorized(
    req: { headers?: Record<string, unknown> },
    token: string,
    opts?: { cookieName?: string },
  ): boolean;

  export function cookieFor(token: string, opts?: { cookieName?: string }): string;

  export function normalizePath(urlPath: string): string | null;

  /**
   * Fixed label HMAC'd with the package id under the fleet key. Re-exported
   * from src/console/proxy.ts, which remains the documented owner of the
   * /ext hop's credential policy.
   */
  export const UPSTREAM_CREDENTIAL_LABEL: string;

  /**
   * Per-package upstream credential (hex sha256 HMAC over a length-prefixed
   * label + package id). Byte-identical to the derivation src/console/proxy.ts
   * shipped before the helper was lifted here -- pinned by a fixed vector in
   * packages/apra-fleet-client/test/local-token.test.mjs.
   */
  export function deriveUpstreamCredential(fleetKey: string, packageId: string): string;
}
