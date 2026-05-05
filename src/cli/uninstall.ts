import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { serverVersion } from '../version.js';
import type { LlmProvider } from '../types.js';
import { isApraFleetRunning } from './install.js';
import {
  BIN_DIR,
  HOOKS_DIR,
  SCRIPTS_DIR,
  FLEET_BASE,
  getProviderInstallConfig,
  readConfig,
  writeConfig,
  readInstallConfig,
  PROVIDER_STANDARD_MODELS,
  ProviderInstallConfig
} from './config.js';

function run(cmd: string, opts?: Record<string, unknown>): void {
  const shellOpt = process.platform === 'win32' ? { shell: 'cmd.exe' } : {};
  execSync(cmd, { stdio: 'inherit', ...shellOpt, ...opts });
}

function cleanupSettings(paths: ProviderInstallConfig, dryRun: boolean): void {
  const settings = readConfig(paths);
  let changed = false;

  // 1. MCP Servers
  if (settings.mcpServers?.['apra-fleet']) {
    console.log(`  - Removing MCP server 'apra-fleet' from settings`);
    if (!dryRun) delete settings.mcpServers['apra-fleet'];
    changed = true;
  }
  if (settings.mcp_servers?.['apra-fleet']) {
    console.log(`  - Removing MCP server 'apra-fleet' from settings (Codex format)`);
    if (!dryRun) delete settings.mcp_servers['apra-fleet'];
    changed = true;
  }

  // 2. Permissions
  if (settings.permissions?.allow) {
    const originalCount = settings.permissions.allow.length;
    const skillsDirPosix = paths.skillsDir.replace(/\\/g, '/');
    const fleetSkillsDirPosix = paths.fleetSkillsDir.replace(/\\/g, '/');
    
    const filtered = (settings.permissions.allow as string[]).filter(p => {
      // Remove specific MCP permission
      if (p === 'mcp__apra-fleet__*') return false;
      // Remove skills directory permissions
      if (p === `Read(${skillsDirPosix}/**)`) return false;
      if (p === `Read(${fleetSkillsDirPosix}/**)`) return false;
      // Remove generic Agent(*) ONLY if it was likely added by us (it's safe to keep if unsure)
      // but the plan says "filter out fleet-specific entries". 
      // Agent(*) is not fleet-specific, so we leave it to be safe.
      return true;
    });
    
    if (filtered.length !== originalCount) {
      console.log(`  - Removing ${originalCount - filtered.length} fleet permissions`);
      if (!dryRun) settings.permissions.allow = filtered;
      changed = true;
    }
  }

  // 3. Hooks
  if (settings.hooks?.PostToolUse) {
    const originalCount = settings.hooks.PostToolUse.length;
    const filtered = (settings.hooks.PostToolUse as any[]).filter(h => 
      !h.matcher?.includes('apra-fleet')
    );
    if (filtered.length !== originalCount) {
      console.log(`  - Removing ${originalCount - filtered.length} fleet hooks`);
      if (!dryRun) settings.hooks.PostToolUse = filtered;
      changed = true;
    }
  }

  // 4. StatusLine
  if (settings.statusLine?.command?.includes('fleet-statusline')) {
    console.log(`  - Removing statusLine configuration`);
    if (!dryRun) delete settings.statusLine;
    changed = true;
  }

  // 5. Default Model
  const providerKey = paths.name.toLowerCase() as LlmProvider;
  const standardModel = PROVIDER_STANDARD_MODELS[providerKey];
  if (settings.defaultModel === standardModel) {
    console.log(`  - Removing defaultModel '${standardModel}' (matches fleet standard)`);
    if (!dryRun) delete settings.defaultModel;
    changed = true;
  }

  if (changed && !dryRun) {
    writeConfig(paths, settings);
  }
}

export async function runUninstall(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`apra-fleet uninstall

Uninstall apra-fleet binary, hooks, MCP registration, and skills.

Usage:
  apra-fleet uninstall                   Full uninstall (all recorded providers)
  apra-fleet uninstall --llm <provider>  Uninstall for specific provider only
  apra-fleet uninstall --skill <mode>    Uninstall specific skills (fleet|pm|all)
  apra-fleet uninstall --dry-run         Log actions without modifying files
  apra-fleet uninstall --yes             Skip confirmation prompt
  apra-fleet uninstall --help            Show this help

Options:
  --llm <provider>   Specific provider to clean up: claude, gemini, codex, copilot.
  --skill <mode>     Skills to remove: fleet, pm, or all (default).
  --dry-run          Preview the uninstall process.
  --yes              Bypass confirmation prompt.`);
    process.exit(0);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const skipConfirm = args.includes('--yes');

  // Parse --llm
  let targetLlm: LlmProvider | 'all' = 'all';
  const llmArg = args.find(a => a.startsWith('--llm='));
  if (llmArg) {
    targetLlm = llmArg.split('=')[1] as LlmProvider;
  } else {
    const idx = args.indexOf('--llm');
    if (idx >= 0 && idx < args.length - 1) {
      targetLlm = args[idx + 1] as LlmProvider;
    }
  }

  // Parse --skill
  type SkillMode = 'fleet' | 'pm' | 'all';
  let skillMode: SkillMode = 'all';
  const skillArg = args.find(a => a.startsWith('--skill='));
  if (skillArg) {
    const val = skillArg.split('=')[1];
    if (val === 'fleet' || val === 'pm' || val === 'all') skillMode = val;
  } else {
    const idx = args.indexOf('--skill');
    if (idx >= 0 && idx < args.length - 1) {
      const val = args[idx + 1];
      if (val === 'fleet' || val === 'pm' || val === 'all') skillMode = val;
    }
  }

  console.log(`\nUninstalling Apra Fleet ${serverVersion}...${dryRun ? ' (DRY RUN)' : ''}\n`);

  if (isApraFleetRunning()) {
    console.error('Error: apra-fleet server is currently running. Stop it first (`apra-fleet stop`) then retry uninstall.');
    process.exit(1);
    return;
  }

  const installConfig = readInstallConfig();
  const recordedProviders = Object.keys(installConfig.providers) as LlmProvider[];
  const isFallback = recordedProviders.length === 0;
  const providersToClean = targetLlm === 'all' 
    ? (recordedProviders.length > 0 ? recordedProviders : (['claude', 'gemini', 'codex', 'copilot'] as LlmProvider[]))
    : [targetLlm];

  if (isFallback && targetLlm === 'all') {
    console.log('No recorded installations found. Scanning all known provider paths...');
  }

  if (!skipConfirm && !dryRun) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Are you sure you want to uninstall Apra Fleet? (y/N): `);
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  for (const llm of providersToClean) {
    const paths = getProviderInstallConfig(llm);
    console.log(`Cleaning up ${paths.name}...`);
    
    if (llm === 'claude') {
      console.log(`  - Removing MCP server via Claude CLI`);
      if (!dryRun) {
        try {
          run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
        } catch { /* already removed or not found */ }
      }
    }
    
    cleanupSettings(paths, dryRun);

    // Skill removal (Phase 2 - Task T4)
    if (skillMode === 'all' || skillMode === 'pm') {
      if (fs.existsSync(paths.skillsDir)) {
        console.log(`  - Removing PM skills: ${paths.skillsDir}`);
        if (!dryRun) fs.rmSync(paths.skillsDir, { recursive: true, force: true });
      }
    }
    if (skillMode === 'all' || skillMode === 'fleet') {
      if (fs.existsSync(paths.fleetSkillsDir)) {
        console.log(`  - Removing fleet skills: ${paths.fleetSkillsDir}`);
        if (!dryRun) fs.rmSync(paths.fleetSkillsDir, { recursive: true, force: true });
      }
    }
  }

  if (!dryRun && targetLlm === 'all' && skillMode === 'all') {
    console.log('\nCleaning up global fleet files...');
    if (fs.existsSync(BIN_DIR)) {
      console.log(`  - Removing binary dir: ${BIN_DIR}`);
      fs.rmSync(BIN_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(HOOKS_DIR)) {
      console.log(`  - Removing hooks dir: ${HOOKS_DIR}`);
      fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(SCRIPTS_DIR)) {
      console.log(`  - Removing scripts dir: ${SCRIPTS_DIR}`);
      fs.rmSync(SCRIPTS_DIR, { recursive: true, force: true });
    }
    // Note: we don't remove FLEET_BASE/data to preserve logs/registry if user reinstalls.
    // But we should remove the install-config.json if it was a full uninstall.
    const configPath = path.join(FLEET_BASE, 'data', 'install-config.json');
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  }

  console.log('\nUninstall complete.');
  console.log('\n⚠ Note: Surgical cleanup of settings (MCP, permissions, hooks) was performed.');
  console.log('  If you manually modified these settings, some entries might remain.');
  console.log('  Please review your provider settings files if you suspect residual config.');
}
