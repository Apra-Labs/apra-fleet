import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = os.homedir();
const APRA_BASE = path.join(home, '.apra-fleet');
const WORKSPACES_DIR = path.join(APRA_BASE, 'workspaces');
const WORKSPACES_INDEX = path.join(APRA_BASE, 'workspaces.json');
const DEFAULT_DATA_DIR = path.join(APRA_BASE, 'data');

interface WorkspaceEntry {
  name: string;
  path: string;
  created: string;
}

interface WorkspacesIndex {
  workspaces: WorkspaceEntry[];
}

function readIndex(): WorkspacesIndex {
  if (!fs.existsSync(WORKSPACES_INDEX)) return { workspaces: [] };
  try {
    return JSON.parse(fs.readFileSync(WORKSPACES_INDEX, 'utf-8'));
  } catch {
    return { workspaces: [] };
  }
}

function writeIndex(index: WorkspacesIndex): void {
  fs.mkdirSync(path.dirname(WORKSPACES_INDEX), { recursive: true });
  fs.writeFileSync(WORKSPACES_INDEX, JSON.stringify(index, null, 2) + '\n');
}

function getDefaultWorkspace(): WorkspaceEntry {
  return { name: 'default', path: DEFAULT_DATA_DIR, created: '' };
}

function allWorkspaces(index: WorkspacesIndex): WorkspaceEntry[] {
  const hasDefault = index.workspaces.some(w => w.name === 'default');
  const base: WorkspaceEntry[] = hasDefault ? [] : [getDefaultWorkspace()];
  return [...base, ...index.workspaces];
}

function activePath(): string {
  return process.env.APRA_FLEET_DATA_DIR ?? DEFAULT_DATA_DIR;
}

function memberCount(dataDir: string): number {
  const registryPath = path.join(dataDir, 'registry.json');
  if (!fs.existsSync(registryPath)) return 0;
  try {
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    return Array.isArray(reg) ? reg.length : 0;
  } catch {
    return 0;
  }
}

function statuslineAge(dataDir: string): string {
  const slPath = path.join(dataDir, 'statusline.txt');
  if (!fs.existsSync(slPath)) return '—';
  try {
    const stat = fs.statSync(slPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageSec = Math.floor(ageMs / 1000);
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    return `${Math.floor(ageSec / 3600)}h ago`;
  } catch {
    return '—';
  }
}

function isActive(ws: WorkspaceEntry): boolean {
  const current = activePath();
  const resolved = ws.path.replace(/^~/, home);
  return path.resolve(resolved) === path.resolve(current);
}

// --- Commands ---

function cmdList(): void {
  const index = readIndex();
  const workspaces = allWorkspaces(index);
  const current = activePath();

  const col1 = Math.max(4, ...workspaces.map(w => w.name.length));
  const col2 = Math.max(4, ...workspaces.map(w => w.path.length));

  const header = `${'NAME'.padEnd(col1)}  ${'PATH'.padEnd(col2)}  MEMBERS  ACTIVE`;
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const ws of workspaces) {
    const active = isActive(ws) ? '✅' : '—';
    const members = memberCount(ws.path.replace(/^~/, home));
    const resolved = ws.path.replace(/^~/, home);
    const display = resolved.startsWith(home) ? ws.path.replace(home, '~') : ws.path;
    console.log(`${ws.name.padEnd(col1)}  ${display.padEnd(col2)}  ${String(members).padStart(7)}  ${active}`);
  }
  void current;
}

function cmdAdd(args: string[]): void {
  const withInstall = args.includes('--install');
  const nameArgs = args.filter(a => !a.startsWith('--'));
  if (nameArgs.length === 0) {
    console.error('Error: workspace add requires a name. Usage: apra-fleet workspace add <name> [--install]');
    process.exit(1);
  }
  const name = nameArgs[0];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    console.error('Error: workspace name must be alphanumeric (with optional - or _), max 64 chars.');
    process.exit(1);
  }
  if (name === 'default') {
    console.error('Error: "default" is reserved. Use "apra-fleet workspace status default" to inspect it.');
    process.exit(1);
  }

  const wsPath = path.join(WORKSPACES_DIR, name);
  const index = readIndex();

  const existing = index.workspaces.findIndex(w => w.name === name);
  const entry: WorkspaceEntry = {
    name,
    path: wsPath,
    created: existing >= 0 ? index.workspaces[existing].created : new Date().toISOString(),
  };

  if (existing >= 0) {
    index.workspaces[existing] = entry;
    console.log(`Workspace "${name}" already registered — updated path.`);
  } else {
    index.workspaces.push(entry);
    console.log(`Workspace "${name}" registered at ${wsPath}`);
  }

  fs.mkdirSync(wsPath, { recursive: true });
  writeIndex(index);

  if (withInstall) {
    console.log(`\nRunning install for workspace "${name}"...`);
    import('./install.js')
      .then(m => m.runInstall(['--instance', name]))
      .catch(err => { console.error('Install failed:', err.message); process.exit(1); });
  } else {
    console.log(`\nTo install MCP registration for this workspace:\n  apra-fleet install --instance ${name}`);
    console.log(`\nTo activate in current shell:\n  export APRA_FLEET_DATA_DIR="${wsPath}"`);
  }
}

function cmdRemove(args: string[]): void {
  const force = args.includes('--force');
  const nameArgs = args.filter(a => !a.startsWith('--'));
  if (nameArgs.length === 0) {
    console.error('Error: workspace remove requires a name. Usage: apra-fleet workspace remove <name> [--force]');
    process.exit(1);
  }
  const name = nameArgs[0];
  if (name === 'default') {
    console.error('Error: cannot remove the default workspace.');
    process.exit(1);
  }

  const index = readIndex();
  const idx = index.workspaces.findIndex(w => w.name === name);
  if (idx < 0) {
    console.error(`Error: workspace "${name}" not found.`);
    process.exit(1);
  }

  const ws = index.workspaces[idx];
  const wsPath = ws.path.replace(/^~/, home);

  // Check for members
  const members = memberCount(wsPath);
  if (members > 0 && !force) {
    console.error(`Error: workspace "${name}" has ${members} registered member(s). Use --force to remove anyway.`);
    process.exit(1);
  }

  index.workspaces.splice(idx, 1);
  writeIndex(index);
  console.log(`Workspace "${name}" removed from index.`);
  console.log(`Data directory preserved at: ${wsPath}`);
  console.log(`To also delete the data: rm -rf "${wsPath}"`);
}

function cmdUse(args: string[]): void {
  const nameArgs = args.filter(a => !a.startsWith('--'));
  if (nameArgs.length === 0) {
    console.error('Error: workspace use requires a name. Usage: apra-fleet workspace use <name>');
    process.exit(1);
  }
  const name = nameArgs[0];

  const index = readIndex();
  const workspaces = allWorkspaces(index);
  const ws = workspaces.find(w => w.name === name);
  if (!ws) {
    console.error(`Error: workspace "${name}" not found. Run "apra-fleet workspace list" to see available workspaces.`);
    process.exit(1);
  }

  const wsPath = ws.path.replace(/^~/, home);
  console.log(`# To activate workspace "${name}", run:`);
  console.log(`export APRA_FLEET_DATA_DIR="${wsPath}"`);
  console.log(`\n# Or eval directly:`);
  console.log(`eval "$(apra-fleet workspace use ${name})"`);
}

function cmdStatus(args: string[]): void {
  const nameArgs = args.filter(a => !a.startsWith('--'));

  const index = readIndex();
  const workspaces = allWorkspaces(index);

  const targets = nameArgs.length > 0
    ? workspaces.filter(w => nameArgs.includes(w.name))
    : workspaces;

  if (targets.length === 0) {
    console.error(`Error: workspace(s) not found: ${nameArgs.join(', ')}`);
    process.exit(1);
  }

  for (const ws of targets) {
    const wsPath = ws.path.replace(/^~/, home);
    const exists = fs.existsSync(wsPath);
    const members = exists ? memberCount(wsPath) : 0;
    const age = exists ? statuslineAge(wsPath) : '—';
    const saltExists = exists && fs.existsSync(path.join(wsPath, 'salt'));
    const active = isActive(ws) ? ' [active]' : '';

    console.log(`\nWorkspace: ${ws.name}${active}`);
    console.log(`  Path:     ${wsPath}`);
    console.log(`  Exists:   ${exists ? 'yes' : 'no'}`);
    console.log(`  Members:  ${members}`);
    console.log(`  Status:   ${age}`);
    console.log(`  Salt:     ${saltExists ? 'present' : 'missing'}`);
  }
}

export async function runWorkspace(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(`apra-fleet workspace — manage isolated fleet data directories

Usage:
  apra-fleet workspace list
  apra-fleet workspace add <name> [--install]
  apra-fleet workspace remove <name> [--force]
  apra-fleet workspace use <name>
  apra-fleet workspace status [<name>]

Commands:
  list                     Show all workspaces with member count and active state
  add <name>               Create workspace ~/.apra-fleet/workspaces/<name>, register in index
    --install              Also run MCP registration (apra-fleet install --instance <name>)
  remove <name>            Remove workspace from index (data dir preserved unless deleted manually)
    --force                Remove even if members are registered
  use <name>               Print export command to activate workspace in current shell
  status [<name>]          Show health: data dir exists, member count, statusline age, salt`);
    return;
  }

  switch (subcommand) {
    case 'list': cmdList(); break;
    case 'add': cmdAdd(rest); break;
    case 'remove': cmdRemove(rest); break;
    case 'use': cmdUse(rest); break;
    case 'status': cmdStatus(rest); break;
    default:
      console.error(`Error: unknown workspace subcommand "${subcommand}". Run "apra-fleet workspace --help" for usage.`);
      process.exit(1);
  }
}
