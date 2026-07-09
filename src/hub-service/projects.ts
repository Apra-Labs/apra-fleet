/**
 * Project CRUD (apra-fleet-us9.4 continuation), data-layer only. Scoped by
 * workspace_id throughout. Many-to-many with members via project_members
 * (a member can work across multiple projects).
 *
 * Honesty contract (matching member-view.ts / the usage-ledger convention
 * elsewhere in this codebase): `lastActivity` has no real activity source
 * to draw from yet (GET /ws/:id/activity itself is unbuilt -- it needs its
 * own event model, a separate piece of work). Rather than fabricate a
 * number, this uses time-since-creation as an honest, clearly-labeled
 * proxy: it will read as "created N seconds ago" for a project with no
 * activity yet, not as a false claim of recent real activity.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';
import { getMember } from './members.js';

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: 'active' | 'paused';
  created_at: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  memberIds?: string[];
}

async function addMembers(projectId: string, memberIds: string[], pool: Pool): Promise<void> {
  for (const memberId of memberIds) {
    await pool.query(
      `INSERT INTO project_members (project_id, member_id) VALUES ($1, $2)
       ON CONFLICT (project_id, member_id) DO NOTHING`,
      [projectId, memberId],
    );
  }
}

export async function createProject(
  id: string,
  workspaceId: string,
  input: CreateProjectInput,
  pool: Pool = getPool(),
): Promise<ProjectRow> {
  const result = await pool.query<ProjectRow>(
    `INSERT INTO projects (id, workspace_id, name, description) VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, workspaceId, input.name, input.description ?? ''],
  );
  if (input.memberIds?.length) {
    // Same workspace-boundary check as addProjectMember: silently skip any
    // memberId that doesn't belong to this workspace, rather than let a
    // foreign member's row-level FK let it slip in.
    const validated: string[] = [];
    for (const memberId of input.memberIds) {
      if (await getMember(workspaceId, memberId, pool)) validated.push(memberId);
    }
    await addMembers(id, validated, pool);
  }
  return result.rows[0];
}

export async function listProjects(workspaceId: string, pool: Pool = getPool()): Promise<ProjectRow[]> {
  const result = await pool.query<ProjectRow>(
    `SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  return result.rows;
}

export async function getProject(
  workspaceId: string,
  id: string,
  pool: Pool = getPool(),
): Promise<ProjectRow | null> {
  const result = await pool.query<ProjectRow>(
    `SELECT * FROM projects WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return result.rows[0] ?? null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: 'active' | 'paused';
}

export async function updateProject(
  workspaceId: string,
  id: string,
  input: UpdateProjectInput,
  pool: Pool = getPool(),
): Promise<ProjectRow | null> {
  const existing = await getProject(workspaceId, id, pool);
  if (!existing) return null;

  const result = await pool.query<ProjectRow>(
    `UPDATE projects SET name = $3, description = $4, status = $5
     WHERE workspace_id = $1 AND id = $2
     RETURNING *`,
    [
      workspaceId,
      id,
      input.name ?? existing.name,
      input.description ?? existing.description,
      input.status ?? existing.status,
    ],
  );
  return result.rows[0];
}

export async function deleteProject(
  workspaceId: string,
  id: string,
  pool: Pool = getPool(),
): Promise<boolean> {
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [id]);
  const result = await pool.query(
    `DELETE FROM projects WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Both the project AND the member must belong to workspaceId -- without
 * the member check, a member's own row-level FK (members.id exists
 * anywhere) would let a member from a DIFFERENT workspace be attached to
 * this project, leaking across the tenant boundary the rest of this
 * codebase treats as inviolable.
 */
export async function addProjectMember(
  workspaceId: string,
  projectId: string,
  memberId: string,
  pool: Pool = getPool(),
): Promise<boolean> {
  const project = await getProject(workspaceId, projectId, pool);
  if (!project) return false;
  const member = await getMember(workspaceId, memberId, pool);
  if (!member) return false;
  await addMembers(projectId, [memberId], pool);
  return true;
}

export async function removeProjectMember(
  workspaceId: string,
  projectId: string,
  memberId: string,
  pool: Pool = getPool(),
): Promise<boolean> {
  const project = await getProject(workspaceId, projectId, pool);
  if (!project) return false;
  await pool.query(
    `DELETE FROM project_members WHERE project_id = $1 AND member_id = $2`,
    [projectId, memberId],
  );
  return true;
}

export async function listProjectMemberIds(projectId: string, pool: Pool = getPool()): Promise<string[]> {
  const result = await pool.query<{ member_id: string }>(
    `SELECT member_id FROM project_members WHERE project_id = $1 ORDER BY added_at`,
    [projectId],
  );
  return result.rows.map(r => r.member_id);
}
