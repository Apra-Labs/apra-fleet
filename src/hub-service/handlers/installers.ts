/**
 * Minimal hub-service handler stub for GET /installers (see
 * fleet-dashboard/README.md "State & API sketch"). This is the seed of
 * apra-fleet-us9.4 (Hub service MVP) -- unauthenticated, no workspace
 * scoping needed for this route, so it doesn't reference JWTClaims.
 *
 * The response shape here MUST validate against the published
 * `@apralabs/fleet-api-contract` `InstallerSchema` -- see
 * tests/hub-service/installers.contract.test.ts, which runs this handler's
 * real output through the schema at runtime, not just at the type level.
 */
import type { Installer } from '@apralabs/fleet-api-contract';

export function getInstallersHandler(): Installer[] {
  return [
    { os: 'macOS', arch: 'arm64 · x64', file: 'apra-fleet-0.3.5.pkg', cmd: 'brew install apra-labs/tap/apra-fleet' },
    { os: 'Windows', arch: 'x64', file: 'apra-fleet-0.3.5-setup.exe', cmd: 'winget install ApraLabs.Fleet' },
    { os: 'Linux', arch: 'x64 · arm64', file: 'apra-fleet-0.3.5.deb', cmd: 'curl -fsSL get.apralabs.com | sh' },
  ];
}
