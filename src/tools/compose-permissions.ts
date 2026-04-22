import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { getStrategy } from '../services/strategy.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { getProvider } from '../providers/index.js';
import type { Agent } from '../types.js';

export const composePermissionsSchema = z.object({
  ...memberIdentifier,
  role: z.enum(['doer', 'reviewer']).describe('Role determines base profile (doer = broad build/test, reviewer = read + feedback + test)'),
  project_folder: z.string().optional().describe('Local project folder containing permissions.json ledger. Omit to skip ledger merge.'),
  grant: z.array(z.string()).optional().describe('Reactive mode: additional permissions to grant (e.g. ["Bash(docker:*)", "Bash(docker-compose:*)"]). Appended to current permissions and re-delivered.'),
  grant_reason: z.string().optional().describe('Reason for the grant (stored in ledger)'),
});

export type ComposePermissionsInput = z.infer<typeof composePermissionsSchema>;

// Stack marker files → profile keys
const STACK_MAP: Record<string, string> = {
  'package.json': 'node',
  'Cargo.toml': 'rust',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'go.mod': 'go',
  'build.gradle': 'jvm',
  'pom.xml': 'jvm',
  'Makefile': 'cpp',
  'CMakeLists.txt': 'cpp',
  'composer.json': 'php',
};

// Co-occurrence: granting one tool often means needing related tools
const CO_OCCURRENCE: Record<string, string[]> = {
  'Bash(docker:*)': ['Bash(docker-compose:*)', 'Bash(docker buildx:*)'],
  'Bash(kubectl:*)': ['Bash(helm:*)'],
  'Bash(terraform:*)': ['Bash(terragrunt:*)'],
  'Bash(pip:*)': ['Bash(pip3:*)'],
  'Bash(python:*)': ['Bash(python3:*)'],
};

// Never auto-grant — require user escalation
const NEVER_AUTO_GRANT = new Set([
  'Bash(sudo:*)', 'Bash(su:*)', 'Bash(env:*)', 'Bash(printenv:*)',
  'Bash(nc:*)', 'Bash(nmap:*)', 'Bash(chmod 777:*)',
]);

interface Ledger {
  stacks: string[];
  granted: Array<{ permission: string; reason: string; date: string }>;
}

function findProfilesDir(): string {
  // Installed: ~/.claude/skills/fleet/profiles/ (new location after skill split)
  const installedFleet = path.join(os.homedir(), '.claude', 'skills', 'fleet', 'profiles');
  if (fs.existsSync(installedFleet)) return installedFleet;
  // Installed (legacy): ~/.claude/skills/pm/profiles/
  const installedPm = path.join(os.homedir(), '.claude', 'skills', 'pm', 'profiles');
  if (fs.existsSync(installedPm)) return installedPm;
  // Dev: walk up from __dirname looking for skills/fleet/profiles/
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidateFleet = path.join(dir, 'skills', 'fleet', 'profiles');
    if (fs.existsSync(candidateFleet)) return candidateFleet;
    const candidatePm = path.join(dir, 'skills', 'pm', 'profiles');
    if (fs.existsSync(candidatePm)) return candidatePm;
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find profiles directory');
}

function loadProfile(profilesDir: string, name: string): any {
  const filePath = path.join(profilesDir, `${name}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadLedger(projectFolder: string): Ledger {
  const ledgerPath = path.join(projectFolder, 'permissions.json');
  if (fs.existsSync(ledgerPath)) {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    return { stacks: raw.stacks ?? [], granted: raw.granted ?? [] };
  }
  return { stacks: [], granted: [] };
}

function saveLedger(projectFolder: string, ledger: Ledger): void {
  const ledgerPath = path.join(projectFolder, 'permissions.json');
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
}

async function detectStacks(agent: Agent): Promise<string[]> {
  const strategy = getStrategy(agent);
  const markers = Object.keys(STACK_MAP).join(' ');
  const result = await strategy.execCommand(`ls ${markers} 2>/dev/null || true`, 10000);
  const found = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const file = line.trim();
    if (STACK_MAP[file]) found.add(STACK_MAP[file]);
  }
  // .sln/.csproj need glob — check separately
  const dotnetCheck = await strategy.execCommand('ls *.sln *.csproj 2>/dev/null || true', 5000);
  if (dotnetCheck.stdout.trim()) found.add('dotnet');
  return [...found];
}

function compose(profilesDir: string, role: string, stacks: string[], ledger: Ledger): string[] {
  const baseName = role === 'doer' ? 'base-dev' : 'base-reviewer';
  const base = loadProfile(profilesDir, baseName);
  const perms = new Set<string>(base?.permissions?.allow ?? []);

  const roleKey = role === 'doer' ? 'dev' : 'reviewer';
  for (const stack of stacks) {
    const profile = loadProfile(profilesDir, stack);
    if (profile?.[roleKey]) {
      for (const p of profile[roleKey]) perms.add(p);
    }
  }

  // Merge ledger grants
  for (const entry of ledger.granted) {
    perms.add(entry.permission);
  }

  return [...perms];
}

/** Deliver a single config file to the member.
 *  Creates parent directory and writes the content (JSON object or TOML string). */
async function deliverConfigFile(
  strategy: Awaited<ReturnType<typeof getStrategy>>,
  agentOs: string,
  filePath: string,
  content: Record<string, unknown> | string,
): Promise<void> {
  const dir = filePath.split('/').slice(0, -1).join('/');
  const mkdirCmd = agentOs === 'windows'
    ? `New-Item -ItemType Directory -Force "${dir.replace(/\//g, '\\')}"`
    : `mkdir -p ${dir}`;
  await strategy.execCommand(mkdirCmd, 5000);

  const contentStr = typeof content === 'string'
    ? content
    : JSON.stringify(content, null, 2);

  const writeCmd = agentOs === 'windows'
    ? `Set-Content -Path "${filePath.replace(/\//g, '\\')}" -Value '${contentStr.replace(/'/g, "''")}' -Encoding UTF8`
    : `cat > ${filePath} << 'FLEET_PERMS_EOF'\n${contentStr}\nFLEET_PERMS_EOF`;
  await strategy.execCommand(writeCmd, 5000);
}

export async function composePermissions(input: ComposePermissionsInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const provider = getProvider(agent.llmProvider);
  const strategy = getStrategy(agent);
  const profilesDir = findProfilesDir();
  const ledger = input.project_folder ? loadLedger(input.project_folder) : { stacks: [], granted: [] };

  // Reactive grant mode
  if (input.grant?.length) {
    const blocked = input.grant.filter(p => NEVER_AUTO_GRANT.has(p));
    if (blocked.length) {
      return `❌ Cannot auto-grant dangerous permissions: ${blocked.join(', ')}. Escalate to user.`;
    }

    // Expand co-occurrences
    const expanded = new Set(input.grant);
    for (const p of input.grant) {
      for (const co of CO_OCCURRENCE[p] ?? []) expanded.add(co);
    }

    let allow: string[];

    if (provider.name === 'claude') {
      // Claude: read existing allow list and merge
      const readResult = await strategy.execCommand('cat .claude/settings.local.json 2>/dev/null || echo "{}"', 5000);
      let current: any;
      try {
        current = JSON.parse(readResult.stdout.trim());
      } catch {
        current = { permissions: { allow: [] } };
      }
      const existingAllow = new Set<string>(current?.permissions?.allow ?? []);
      for (const p of expanded) existingAllow.add(p);
      allow = [...existingAllow];
    } else {
      // Non-Claude: pass grants directly; provider incorporates into role-based config
      allow = [...expanded];
    }

    const configs = provider.composePermissionConfig(input.role, allow);
    const paths = provider.permissionConfigPaths();
    for (let i = 0; i < paths.length; i++) {
      await deliverConfigFile(strategy, agent.os ?? 'linux', paths[i], configs[i]);
    }

    // Update ledger
    if (input.project_folder) {
      const reason = input.grant_reason ?? 'granted mid-sprint';
      const date = new Date().toISOString().slice(0, 10);
      for (const p of expanded) {
        if (!ledger.granted.some(e => e.permission === p)) {
          ledger.granted.push({ permission: p, reason, date });
        }
      }
      saveLedger(input.project_folder, ledger);
    }

    return `✅ Granted ${[...expanded].length} permissions on "${agent.friendlyName}" (${provider.name}):\n  ${[...expanded].join('\n  ')}`;
  }

  // Proactive compose mode
  const stacks = await detectStacks(agent);

  // Update ledger stacks
  if (input.project_folder) {
    ledger.stacks = stacks;
    saveLedger(input.project_folder, ledger);
  }

  const allow = compose(profilesDir, input.role, stacks, ledger);
  const configs = provider.composePermissionConfig(input.role, allow);
  const paths = provider.permissionConfigPaths();

  for (let i = 0; i < paths.length; i++) {
    await deliverConfigFile(strategy, agent.os ?? 'linux', paths[i], configs[i]);
  }

  return `✅ Permissions composed for "${agent.friendlyName}" (${input.role}, ${provider.name}):\n  Stacks: ${stacks.join(', ') || 'none detected'}\n  Config: ${paths.join(', ')}\n  Ledger grants: ${ledger.granted.length}`;
}
