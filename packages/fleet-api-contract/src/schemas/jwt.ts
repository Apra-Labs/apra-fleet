import { z } from 'zod';

/**
 * JWTClaims -- the ANCHOR schema of this package.
 *
 * Every other entity/endpoint schema in this package that requires auth
 * references this schema explicitly (see e.g. `AuthenticatedRequest` below,
 * and the request schemas in `../endpoints.ts`). Do NOT redefine an ad-hoc
 * claims shape per endpoint -- import and reference `JWTClaims`/`JWTClaimsSchema`
 * instead.
 *
 * Field names follow standard JWT registered-claim conventions (RFC 7519)
 * plus the fleet-specific `ws` claim:
 *   - iss  = issuer (hub URL in production, "local" in Phase-1 offline mode)
 *   - ws   = workspace_id -- the HARD security boundary
 *            (docs/hub-spoke-master-plan.md section 3). Every workspace-scoped
 *            route MUST enforce this claim server-side.
 *   - sub  = subject -- the member's stable id (uuid)
 *   - exp  = expiry, unix seconds
 *   - role = member's role within the workspace
 *
 * Note: this is the WIRE/contract shape. It is intentionally more compact
 * than apra-fleet's internal `JwtClaims` (src/services/jwt.ts), which also
 * carries `work_folder` and an optional non-security `project_id` grouping
 * label for the local single-machine Phase-1 issuer. The hub-era contract
 * defined here is what fleet-dashboard and hub-service both compile against;
 * internal-only fields stay internal.
 */
export const RoleSchema = z.enum(['member', 'admin', 'superadmin']);
export type Role = z.infer<typeof RoleSchema>;

export const JWTClaimsSchema = z.object({
  iss: z.string().min(1).describe('Issuer -- hub URL, or "local" in Phase-1 offline mode'),
  ws: z.string().min(1).describe('workspace_id -- the hard security boundary'),
  sub: z.string().min(1).describe('Subject -- member id (uuid)'),
  exp: z.number().int().positive().describe('Expiry, unix seconds'),
  role: RoleSchema,
});
export type JWTClaims = z.infer<typeof JWTClaimsSchema>;

/**
 * Wrap any request/response schema that requires a valid workspace-scoped
 * JWT. Attaches the decoded claims under `auth` so consuming code always has
 * a single, explicit reference point back to JWTClaims -- never redefined.
 */
export function withAuth<T extends z.ZodTypeAny>(schema: T) {
  return schema.and(z.object({ auth: JWTClaimsSchema }));
}
