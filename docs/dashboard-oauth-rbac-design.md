<!-- llm-context: Design proposal (not yet implemented) for apra-fleet-us9.16 --
     Dashboard OAuth + RBAC + admin provisioning, the human-user auth system for
     fleet.apralabs.com. Distinct from member/workspace_id auth (docs/hub-spoke-master-plan.md
     section 3, packages/fleet-api-contract/src/schemas/jwt.ts). Read this before
     implementing us9.16 -- it exists specifically because that issue is flagged
     Opus/security-sensitive (privilege-escalation risk in role/workspace-assignment
     edge cases) and deserves a reviewed design before code, not a quick pass. -->
<!-- keywords: OAuth, RBAC, dashboard auth, human user, pending approval, superadmin,
     privilege escalation, apra-fleet-us9.16 -->

# Dashboard OAuth + RBAC Design Proposal (apra-fleet-us9.16)

Status: design proposal, not implemented. Written because this issue is explicitly
flagged Opus/high-risk ("a real RBAC state machine... easy to get subtly wrong, e.g.
privilege escalation via role/workspace-assignment edge cases") -- the appropriate
next step is a reviewed design, not code written under time pressure. This document
exists to make that design review possible without guessing at an external reference
(`apra-lic-mgr`) this repo can't inspect.

## 1. A genuine ambiguity in the existing contract, surfaced by trying to implement this

`packages/fleet-api-contract`'s `JWTClaimsSchema` (`ws`, `sub`, `role`, `exp`, `iss`)
carries exactly ONE `workspace_id` + ONE `role`. But `GET /workspaces`'s own summary is
"User's workspaces + role" -- plural, with a *per-workspace* role, since
`AdminUserSchema.workspaces` and `ApproveUserRequestSchema.workspaces` are both arrays
(a human user can be assigned to multiple workspaces, potentially with different
roles in each). Yet `Endpoints['GET /workspaces'].request` types its `auth` field as
`JWTClaimsSchema` -- a single `ws`/`role` pair.

**This is a real gap, not just an implementation detail**: a single-workspace JWT
cannot answer "what are ALL my workspaces + roles" -- that query has to be keyed on
user identity alone, before any workspace is selected.

**Proposed resolution** (two-tier auth, not touching the existing single-workspace
`JWTClaimsSchema` -- it stays exactly as-is for member/workspace-scoped routes):

1. **OAuth session** (identity only, no workspace): after Google/Microsoft OAuth
   completes, mint a *session* JWT carrying only `{ sub: userId, exp }` -- no `ws`,
   no `role`. This is what authenticates `GET /workspaces` (list every workspace this
   `sub` is assigned to, with its role, from `user_workspace_roles` below) and
   `GET/PUT /admin/users/*` (superadmin-only, checked against the row in `users`, not
   the token).
2. **Workspace-scoped JWT** (matches `JWTClaimsSchema` exactly): minted when the
   dashboard user selects a specific workspace to work in. This is what authenticates
   every `/ws/:id/...` route already built (members, projects, cost, activity) --
   unchanged from today.

This means `Endpoints['GET /workspaces'].request`'s `auth: JWTClaimsSchema` typing is
itself slightly wrong and should become a distinct, narrower session-claims schema
(`{ sub, exp }`) once this is built -- flagging that here rather than silently
resolving it by picking an interpretation and shipping code against it.

## 2. Schema additions (new tables, additive to db/migrations/)

```sql
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  oauth_provider    TEXT NOT NULL CHECK (oauth_provider IN ('google', 'microsoft')),
  oauth_subject     TEXT NOT NULL,           -- provider's own user id, for re-login matching
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ,
  UNIQUE (oauth_provider, oauth_subject)
);

-- Per-(user, workspace) role -- the actual RBAC join table. A user with no
-- row here for a given workspace has NO access to it, full stop (default deny).
CREATE TABLE user_workspace_roles (
  user_id       TEXT NOT NULL REFERENCES users(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  role          TEXT NOT NULL CHECK (role IN ('member', 'admin', 'superadmin')),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);
```

Note `superadmin` here is scoped to it appearing in `RoleSchema` for a workspace's
role, per the existing contract -- but `GET/PUT /admin/users/*`'s "superadmin"
gate (who can approve/reject/change-role for OTHER users) is almost certainly meant
to be a **platform-level** superadmin, not merely "has role=superadmin in some
workspace". These may need to be two distinct concepts (a `users.is_platform_admin`
boolean, separate from any per-workspace role) -- another ambiguity worth resolving
explicitly before implementation, not by assumption.

## 3. Flow

1. `POST /auth/oauth/:provider` -- OAuth callback. Find-or-create a `users` row
   keyed on `(oauth_provider, oauth_subject)`. New users land `status = 'pending'`
   with ZERO `user_workspace_roles` rows -- no access to anything, by construction,
   until a platform admin approves them (`PUT /admin/users/:id/approve`, which per
   `ApproveUserRequestSchema` sets an initial role + initial workspace assignments
   in one call). A `pending` or `rejected` user's session JWT should still be
   issuable (so the dashboard can show "your account is pending approval"), but
   every workspace-scoped and admin route must check `status === 'approved'`
   in addition to whatever role/assignment check applies -- a pending user must
   never be able to reach a real route just because a session token exists.
2. `GET /workspaces` -- session JWT only (`sub`, no `ws`). Query
   `user_workspace_roles WHERE user_id = sub`, join `workspaces`, return each with
   its own `role`. Empty array for an unapproved/unassigned user -- not an error,
   since "you have zero workspaces" is a legitimate, non-error state.
3. Dashboard selects a workspace -> mint a `JWTClaimsSchema`-shaped token
   (`ws = <selected>`, `role = <that workspace's role from user_workspace_roles>`,
   `sub = userId`) -- from here on, identical to every already-built `/ws/:id/...`
   route's auth story.
4. `GET/PUT/DELETE /admin/users/*` -- gated on the PLATFORM-superadmin concept from
   section 2, checked against the `users` row via the session JWT's `sub`, not
   against any workspace-scoped claim (there is no `:id` workspace in these routes).

## 4. Privilege-escalation risks to design tests against (not exhaustive -- the point
   of Opus-level review is finding the ones this list misses)

- A `member`-role user must not be able to call `PUT /admin/users/:id/role` at all
  (route-level platform-admin gate, independent of any workspace role).
- Approving/changing a user's role must never let that user grant themselves a
  HIGHER role than the platform-admin doing the approving already holds (no
  self-service escalation via a race between two admin actions either).
- Removing a `user_workspace_roles` row for a currently-active session should
  revoke any already-issued workspace-scoped JWT for that (user, workspace) pair
  -- reuse the exact `jwt-revocation.ts` pattern already built and tested
  (`src/hub-service/jwt-revocation.ts`), don't invent a second revocation
  mechanism.
- A `rejected` user re-attempting OAuth login must not silently flip back to
  `pending` (re-review) without an explicit, audited admin action -- log every
  status transition to `audit_log` (already built, `src/hub-service/audit-log.ts`),
  consistent with how member/project mutations should already be recorded there.
- `GET /admin/users` must never leak a user's `email`/`oauth_subject` to a
  non-platform-admin caller, including a superadmin of just one workspace.

## 5. What's explicitly NOT designed here (deliberately out of scope for a design doc)

- The actual Google/Microsoft OAuth token-exchange implementation (library choice,
  redirect URI handling, CSRF/state parameter). This is well-trodden ground with
  existing libraries; the RBAC/approval state machine above is the genuinely novel,
  risk-bearing part of this issue.
- Session cookie transport details (httpOnly/secure/sameSite flags, refresh).
- UI/UX for the pending-approval and admin-provisioning screens.
