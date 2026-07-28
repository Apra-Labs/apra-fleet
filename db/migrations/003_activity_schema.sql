-- Activity feed schema (apra-fleet-us9.4 continuation).
-- Deliberately separate from audit_log: audit_log is for admin/security
-- mutations (member.create, token.revoke, etc.); activity_log is the
-- real-time task feed (cmd/prompt/file/commit events from actual work),
-- matching packages/fleet-api-contract's ActivityEventSchema. Conflating
-- the two would blur an admin audit trail with a noisy work-activity
-- stream that has very different volume/retention characteristics.

CREATE TABLE IF NOT EXISTS activity_log (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  project_id    TEXT NOT NULL,
  member_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('cmd', 'prompt', 'file', 'commit')),
  text          TEXT NOT NULL,
  exit_code     INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_workspace_time ON activity_log(workspace_id, created_at);
