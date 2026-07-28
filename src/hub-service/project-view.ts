/**
 * Dashboard-facing Project view-model assembly (apra-fleet-us9.4
 * continuation), joining the raw CRUD row (projects.ts) with its member
 * list (project_members) into the shape @apralabs/fleet-api-contract's
 * ProjectSchema requires. See projects.ts for the lastActivity honesty-
 * contract note.
 */
import { getProject, listProjects, listProjectMemberIds, type ProjectRow } from './projects.js';
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface ProjectView {
  id: string;
  name: string;
  desc: string;
  status: 'active' | 'paused';
  members: string[];
  lastActivity: number;
}

function secondsSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

async function assembleView(project: ProjectRow, pool: Pool): Promise<ProjectView> {
  const members = await listProjectMemberIds(project.id, pool);
  return {
    id: project.id,
    name: project.name,
    desc: project.description,
    status: project.status,
    members,
    lastActivity: secondsSince(project.created_at),
  };
}

export async function getProjectView(
  workspaceId: string,
  projectId: string,
  pool: Pool = getPool(),
): Promise<ProjectView | null> {
  const project = await getProject(workspaceId, projectId, pool);
  if (!project) return null;
  return assembleView(project, pool);
}

export async function listProjectViews(workspaceId: string, pool: Pool = getPool()): Promise<ProjectView[]> {
  const projects = await listProjects(workspaceId, pool);
  return Promise.all(projects.map(p => assembleView(p, pool)));
}
