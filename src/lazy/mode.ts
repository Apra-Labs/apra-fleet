/**
 * Hooks the core reads to behave the lazyfleet way. Kept dependency-free
 * (fs only) so importing it from core modules costs nothing when lazyfleet
 * is not installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, type LazyConfig } from './config.js';

/** lazyfleet has been installed on this machine. */
export function isLazyMode(): boolean {
  return fs.existsSync(configPath());
}

function readConfig(): Partial<LazyConfig> | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return null;
  }
}

/** Idle-helper cleanup window from the settings page, if set. */
export function lazyIdleMinutes(): number | undefined {
  const m = readConfig()?.helpers?.idleMinutes;
  return Number.isInteger(m) && m! > 0 ? m : undefined;
}

/**
 * In lazyfleet every helper on this machine is Claude's to manage, so local
 * helpers are always marked for automatic cleanup, whether or not the model
 * remembered the tag.
 */
export function withAutoTag(tags: string[] | undefined, isLocal: boolean): string[] | undefined {
  if (!isLocal || !isLazyMode()) return tags;
  return tags?.includes('auto') ? tags : [...(tags ?? []), 'auto'];
}

export function helperSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(dir, 'skills', 'fleet', 'local-settings.md');
}

/**
 * Mirror the settings page into the skill Claude reads, so limits changed in
 * the UI apply to the next decision without a reinstall.
 */
export function writeHelperSettings(cfg: LazyConfig): void {
  const p = helperSettingsPath();
  if (!fs.existsSync(path.dirname(p))) return; // skill not installed yet
  const remote = cfg.helpers.askBeforeRemote
    ? 'Ask first, phrased in money/time/risk, as `autonomy.md` describes.'
    : 'The user allowed this without asking. Still say what it will cost before starting anything billable.';
  const body = `# Local Settings

Written by the lazyfleet settings page. These override the defaults in
\`autonomy.md\`. Do not edit by hand - the user changes them in the page.

| Setting | Value |
|---|---|
| Most parallel workers without asking | ${cfg.helpers.maxParallel} |
| Idle auto workers are cleaned up after | ${cfg.helpers.idleMinutes} minutes |
| Remote or billable work | ${remote} |

The user never manages workers. Create, use and clean them up yourself, and
report what you did in plain words.
`;
  fs.writeFileSync(p, body);
}
