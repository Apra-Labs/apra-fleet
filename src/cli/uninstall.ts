import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import * as readlinePromises from 'node:readline/promises';
import { serverVersion } from '../version.js';
import type { LlmProvider } from '../types.js';
import { isApraFleetRunning } from './install.js';
import { getServiceManager } from '../services/service-manager/index.js';
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

function cleanupSettings(paths: ProviderInstallConfig, dryRun: boolean): boolean {
  const providerKey = paths.name === 'Antigravity' ? 'agy' : (paths.name.toLowerCase() as LlmProvider);
  const settings = readConfig(paths);
  let changed = false;

  // 1. MCP Servers
  if (providerKey === 'agy') {
    const mcpConfigFile = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    if (fs.existsSync(mcpConfigFile)) {
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf-8'));
        if (mcpConfig.mcpServers?.['apra-fleet']) {
          console.log(`  - Removing MCP server 'apra-fleet' from mcp_config.json`);
          if (!dryRun) {
            delete mcpConfig.mcpServers['apra-fleet'];
            fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2) + '\n');
          }
          changed = true;
        }
      } catch {}
    }
  } else {
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
  if (providerKey === 'agy') {
    const hooksFile = path.join(os.homedir(), '.gemini', 'config', 'hooks.json');
    if (fs.existsSync(hooksFile)) {
      try {
        const hooksConfig = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
        const hooksObj = hooksConfig.hooks || {};
        let hooksChanged = false;
        
        const hookEventNames = [
          'PostToolUse', 'PreToolUse', 'UserPromptSubmit', 'Stop', 'PreCompact',
          'AfterTool', 'BeforeTool', 'BeforeAgent', 'SessionEnd', 'PreCompress'
        ];
        for (const eventName of hookEventNames) {
          if (hooksObj[eventName]) {
            const originalCount = hooksObj[eventName].length;
            const filtered = (hooksObj[eventName] as any[]).filter(h =>
              !h.matcher?.includes('apra-fleet')
            );
            if (filtered.length !== originalCount) {
              console.log(`  - Removing ${originalCount - filtered.length} fleet hooks (${eventName}) from hooks.json`);
              if (!dryRun) hooksObj[eventName] = filtered;
              hooksChanged = true;
              changed = true;
            }
          }
        }
        if (hooksChanged && !dryRun) {
          hooksConfig.hooks = hooksObj;
          fs.writeFileSync(hooksFile, JSON.stringify(hooksConfig, null, 2) + '\n');
        }
      } catch {}
    }
  } else {
    // Claude uses "PostToolUse", Gemini uses "AfterTool"
    const hookEventNames = ['PostToolUse', 'AfterTool'];
    for (const eventName of hookEventNames) {
      if (settings.hooks?.[eventName]) {
        const originalCount = settings.hooks[eventName].length;
        const filtered = (settings.hooks[eventName] as any[]).filter(h =>
          !h.matcher?.includes('apra-fleet')
        );
        if (filtered.length !== originalCount) {
          console.log(`  - Removing ${originalCount - filtered.length} fleet hooks (${eventName})`);
          if (!dryRun) settings.hooks[eventName] = filtered;
          changed = true;
        }
      }
    }
  }

  // 4. StatusLine
  if (settings.statusLine?.command?.includes('fleet-statusline')) {
    console.log(`  - Removing statusLine configuration`);
    if (!dryRun) delete settings.statusLine;
    changed = true;
  }

  // 5. Default Model
  const standardModel = PROVIDER_STANDARD_MODELS[providerKey];
  if (settings.defaultModel === standardModel) {
    console.log(`  - Removing defaultModel '${standardModel}' (matches fleet standard)`);
    if (!dryRun) delete settings.defaultModel;
    changed = true;
  }

  if (changed && !dryRun) {
    writeConfig(paths, settings);
  }
  return changed;
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
  apra-fleet uninstall --force           Stop running server automatically before uninstall
  apra-fleet uninstall --yes             Skip confirmation prompt
  apra-fleet uninstall --help            Show this help

Options:
  --llm <provider>   Specific provider to clean up: claude, gemini, codex, copilot, agy.
  --skill <mode>     Skills to remove: fleet, pm, or all (default).
  --dry-run          Preview the uninstall process without modifying anything.
  --force            Automatically stop the running server before uninstalling.
  --yes              Bypass confirmation prompt.`);
    process.exit(0);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
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

  // Reject unknown flags before any prompting
  const knownFlagPrefixes = ['--llm=', '--skill='];
  const knownFlagExact = new Set(['--llm', '--skill', '--dry-run', '--force', '--yes', '--help', '-h']);
  for (const a of args) {
    if (knownFlagExact.has(a)) continue;
    if (knownFlagPrefixes.some(p => a.startsWith(p))) continue;
    if (!a.startsWith('-')) continue; // positional value (e.g. provider name after --llm)
    console.error(`Error: Unknown option "${a}". Run 'apra-fleet uninstall --help' for usage.`);
    process.exit(1);
  }

  console.log(`\nUninstalling Apra Fleet ${serverVersion}...${dryRun ? ' (DRY RUN)' : ''}\n`);

  const svcMgr = await getServiceManager();

  if (isApraFleetRunning()) {
    if (dryRun && force) {
      console.log('  Note: apra-fleet server is currently running (would be stopped by --force).');
    } else if (force) {
      if (!dryRun) {
        try { await svcMgr.stop(); } catch {}
        console.log('  Stopped running server.');
      }
    } else {
      console.error('Error: apra-fleet server is currently running.\n\n  Run with --force to stop it automatically:\n    apra-fleet uninstall --force\n');
      process.exit(1);
      return;
    }
  }

  // Remove service unit (idempotent -- tolerates "not installed")
  if (!dryRun) {
    try { await svcMgr.unregister(); } catch {}
  }

  const installConfig = readInstallConfig();
  const recordedProviders = Object.keys(installConfig.providers) as LlmProvider[];
  const isFallback = recordedProviders.length === 0;
  const providersToClean = targetLlm === 'all' 
    ? (recordedProviders.length > 0 ? recordedProviders : (['claude', 'gemini', 'codex', 'copilot', 'agy'] as LlmProvider[]))
    : [targetLlm];

  if (isFallback && targetLlm === 'all') {
    console.log('No recorded installations found. Scanning all known provider paths...');
  }

  if (!skipConfirm && !dryRun) {
    const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Are you sure you want to uninstall Apra Fleet? (y/N): `);
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  let anythingRemoved = false;

  for (const llm of providersToClean) {
    const paths = getProviderInstallConfig(llm);
    console.log(`Cleaning up ${paths.name}...`);

    if (skillMode === 'all') {
      if (llm === 'claude') {
        console.log(`  - Removing MCP server via Claude CLI`);
        if (!dryRun) {
          try {
            run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
            anythingRemoved = true;
          } catch { /* already removed or not found */ }
        }
      }

      if (cleanupSettings(paths, dryRun)) anythingRemoved = true;
    }

    // Skill removal (Phase 2 - Task T4)
    if (skillMode === 'all' || skillMode === 'pm') {
      if (fs.existsSync(paths.skillsDir)) {
        console.log(`  - Removing PM skills: ${paths.skillsDir}`);
        if (!dryRun) fs.rmSync(paths.skillsDir, { recursive: true, force: true });
        anythingRemoved = true;
      }
    }
    if (skillMode === 'all' || skillMode === 'fleet') {
      if (fs.existsSync(paths.fleetSkillsDir)) {
        console.log(`  - Removing fleet skills: ${paths.fleetSkillsDir}`);
        if (!dryRun) fs.rmSync(paths.fleetSkillsDir, { recursive: true, force: true });
        anythingRemoved = true;
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

  if (anythingRemoved) {
    console.log('\nUninstall complete.');
    console.log('\n⚠ Note: Surgical cleanup of settings (MCP, permissions, hooks) was performed.');
    console.log('  If you manually modified these settings, some entries might remain.');
    console.log('  Please review your provider settings files if you suspect residual config.');
  } else {
    console.log('\nNothing to remove — no apra-fleet installation found for the specified scope.');
  }
}
