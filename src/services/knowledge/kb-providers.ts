import path from 'path';
import fs from 'fs';
import { SqliteProvider } from './sqlite-provider.js';
import { resolveProjectSlug } from './project-slug.js';
import { FLEET_DIR } from '../../paths.js';

export interface KbProviders {
  project: SqliteProvider;
  global: SqliteProvider;
  projectSlug: string;
}

export async function createKbProviders(cwd?: string): Promise<KbProviders> {
  const slug = resolveProjectSlug(cwd);
  const projectDir = path.join(FLEET_DIR, 'knowledge', slug);
  const globalDir = path.join(FLEET_DIR, 'knowledge', 'global');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  const projectProvider = new SqliteProvider(path.join(projectDir, 'kb.sqlite'));
  const globalProvider = new SqliteProvider(path.join(globalDir, 'kb.sqlite'));
  await projectProvider.init();
  await globalProvider.init();
  return { project: projectProvider, global: globalProvider, projectSlug: slug };
}

let _providers: KbProviders | null = null;

export async function getKbProviders(cwd?: string): Promise<KbProviders> {
  if (!_providers) {
    _providers = await createKbProviders(cwd);
  }
  return _providers;
}

export function resetKbProviders(): void {
  _providers = null;
}
