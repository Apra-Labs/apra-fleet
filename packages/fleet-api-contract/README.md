# @apralabs/fleet-api-contract

Single source of truth for the apra-fleet **hub <-> dashboard** API contract.
Lives inside the `apra-fleet` monorepo as an npm workspace package (not a
dedicated repo) so it can be built/tested/versioned alongside the code that
issues and verifies the tokens it describes.

## Anchor schema: `JWTClaims`

`JWTClaims` (`{ iss, ws, sub, exp, role }`) is the central, load-bearing
export -- not just one schema among several. `ws` (workspace_id) is the hard
security boundary (see `docs/hub-spoke-master-plan.md` section 3 in the main
repo). Every other schema/endpoint that requires auth references
`JWTClaimsSchema` explicitly; none redefine an ad-hoc claims shape.

## What's in here

- `src/schemas/` -- Zod schemas: `Workspace`, `Project`, `Member` (provider
  enum includes `'none'` per us9.14), `JWTClaims`, `UsageRecord`,
  `ActivityEvent`, `Installer`, `AdminUser`.
- `src/endpoints.ts` -- one entry per route in
  `fleet-dashboard/README.md`'s "State & API sketch", with request/response
  Zod shapes. Auth-gated entries carry `auth: JWTClaimsSchema`.
- `src/openapi.ts` -- generates an OpenAPI 3.1 document from the SAME Zod
  schemas above (via `@asteasolutions/zod-to-openapi`) -- no hand-written,
  dual-maintained spec.

## Build & generate the spec

```bash
npm run build --workspace=@apralabs/fleet-api-contract
npm run gen:openapi --workspace=@apralabs/fleet-api-contract   # writes openapi.json
```

From the monorepo root these are also aliased:

```bash
npm run build:contract
npm run gen:openapi
```

## Publishing

Versioned semver release from this workspace package:

```bash
npm run build --workspace=@apralabs/fleet-api-contract
npm publish --workspace=@apralabs/fleet-api-contract
```

(Configure the target registry -- npm private registry or GitHub Packages --
via `.npmrc` / `publishConfig` before the first publish; `publishConfig.access`
is currently set to `public` as a placeholder and should be revisited once
the registry choice is finalized.)

## Consuming from fleet-dashboard

Once fleet-dashboard's real frontend/backend moves past the hi-fi prototype,
depend on this package like any other npm dependency:

```bash
npm install @apralabs/fleet-api-contract
```

```ts
import { JWTClaimsSchema, MemberSchema, Endpoints } from '@apralabs/fleet-api-contract';
```

## Contract testing in hub-service

The hub-service (apra-fleet-us9.4) should validate real handler responses
against these schemas at runtime, not just at the type level -- this catches
wire-format drift (an extra/missing field) that `tsc` cannot. See
`tests/hub-service/installers.contract.test.ts` in the main repo for the
pattern: import the schema from this package, call the real handler, and
`Schema.parse()` the actual response.
