-- Projects schema (apra-fleet-us9.4 continuation).
-- Project deliberately has NO repository field -- real projects span many
-- repos; checkouts belong to members, each of which has a work folder
-- (packages/fleet-api-contract/src/schemas/project.ts).
-- Many-to-many project<->member via project_members, since a member can
-- work across multiple projects and a project has multiple members.

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  member_id   TEXT NOT NULL REFERENCES members(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_member ON project_members(member_id);
