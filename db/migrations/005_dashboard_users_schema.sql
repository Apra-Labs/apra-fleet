-- Dashboard human-user auth schema (apra-fleet-us9.16), per
-- docs/dashboard-oauth-rbac-design.md. Distinct from member/machine auth
-- (workspaces/machines/members tables) -- this is the RBAC system for
-- HUMANS signing into the dashboard via OAuth.

-- Re-checked against the actual contract while implementing (not just the
-- design doc's own initial assumption): AdminUserSchema.workspaces is a
-- bare `string[]` (no per-workspace role breakdown), and there is exactly
-- one PUT /admin/users/:id/role endpoint (no per-workspace variant). The
-- real contract's model is ONE uniform role per user, not a role that
-- varies per assigned workspace -- role lives on `users`, and
-- user_workspace_roles is a plain membership table (default-deny: no row
-- here means no access to that workspace, full stop).
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  oauth_provider      TEXT NOT NULL CHECK (oauth_provider IN ('google', 'microsoft')),
  oauth_subject       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  -- NULL until approved. CHECK is written NULL-tolerant explicitly (real
  -- Postgres already treats a NULL CHECK expression as passing per SQL
  -- semantics, but this is spelled out rather than relying on that,
  -- since pg-mem was observed to reject a NULL role against a bare
  -- `role IN (...)` check during this feature's own test development).
  role                TEXT CHECK (role IS NULL OR role IN ('member', 'admin', 'superadmin')),
  -- Platform-level admin: can approve/reject/change-role for ANY user and
  -- see the full user list (GET/PUT/DELETE /admin/users/*). Deliberately
  -- separate from `role` above -- the design doc flagged this as an
  -- ambiguity ("superadmin" in RoleSchema reads as workspace-scoped, not
  -- necessarily platform-wide) and resolves it as its own boolean rather
  -- than overloading a workspace role to also mean platform authority.
  is_platform_admin   BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ,
  UNIQUE (oauth_provider, oauth_subject)
);

-- Plain (user, workspace) membership -- default deny: a user with no row
-- here for a given workspace has NO access to it.
CREATE TABLE IF NOT EXISTS user_workspace_roles (
  user_id       TEXT NOT NULL REFERENCES users(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_user_workspace_roles_workspace ON user_workspace_roles(workspace_id);
