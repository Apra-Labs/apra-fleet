import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../services/strategy.js';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const composePermissionsSchema = z.object({
  member_id: z.string().describe('The UUID of the target member'),
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
  // Installed: ~/.claude/skills/pm/profiles/
  const installed = path.join(os.homedir(), '.claude', 'skills', 'pm', 'profiles');
  if (fs.existsSync(installed)) return installed;
  // Dev: walk up from __dirname looking for skills/pm/profiles/
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'skills', 'pm', 'profiles');
    if (fs.existsSync(candidate)) return candidate;
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
    return JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
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

export async function composePermissions(input: ComposePermissionsInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

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

    // Read current settings.local.json from member
    const readResult = await strategy.execCommand('cat .claude/settings.local.json 2>/dev/null || echo "{}"', 5000);
    let current: any;
    try {
      current = JSON.parse(readResult.stdout.trim());
    } catch {
      current = { permissions: { allow: [] } };
    }
    const allow = new Set<string>(current?.permissions?.allow ?? []);
    for (const p of expanded) allow.add(p);
    current.permissions = { allow: [...allow] };

    // Deliver
    const json = JSON.stringify(current, null, 2);
    const writeCmd = agent.os === 'windows'
      ? `Set-Content -Path ".claude\\settings.local.json" -Value '${json.replace(/'/g, "''")}' -Encoding UTF8`
      : `cat > .claude/settings.local.json << 'FLEET_PERMS_EOF'\n${json}\nFLEET_PERMS_EOF`;
    await strategy.execCommand(writeCmd, 5000);

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

    return `✅ Granted ${[...expanded].length} permissions on "${agent.friendlyName}":\n  ${[...expanded].join('\n  ')}`;
  }

  // Proactive compose mode
  const stacks = await detectStacks(agent);

  // Update ledger stacks
  if (input.project_folder) {
    ledger.stacks = stacks;
    saveLedger(input.project_folder, ledger);
  }

  const perms = compose(profilesDir, input.role, stacks, ledger);
  const settings = { permissions: { allow: perms } };

  // Deliver via echo — avoids temp file + rename dance
  const json = JSON.stringify(settings, null, 2);
  await strategy.execCommand('mkdir -p .claude 2>/dev/null || mkdir .claude 2>nul', 5000);
  const writeCmd = agent.os === 'windows'
    ? `Set-Content -Path ".claude\\settings.local.json" -Value '${json.replace(/'/g, "''")}' -Encoding UTF8`
    : `cat > .claude/settings.local.json << 'FLEET_PERMS_EOF'\n${json}\nFLEET_PERMS_EOF`;
  await strategy.execCommand(writeCmd, 5000);

  return `✅ Permissions composed for "${agent.friendlyName}" (${input.role}):\n  Stacks: ${stacks.join(', ') || 'none detected'}\n  Permissions: ${perms.length} entries\n  Ledger grants: ${ledger.granted.length}`;
}
