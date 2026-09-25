/**
 * Point Claude Code at the local proxy via the `env` block of its user
 * settings, and undo that exactly on the way out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function read(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf-8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Never overwrite a settings file we could not parse.
    throw new Error(`Cannot parse ${claudeSettingsPath()}: ${(e as Error).message}`);
  }
}

function write(settings: Record<string, any>): void {
  const p = claudeSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.lazyfleet.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

export function currentBaseUrl(): string | undefined {
  return read().env?.ANTHROPIC_BASE_URL;
}

/** Route Claude Code through `url`. Returns the previous value, if any. */
export function setBaseUrl(url: string): string | undefined {
  const s = read();
  const previous = s.env?.ANTHROPIC_BASE_URL;
  s.env = { ...(s.env ?? {}), ANTHROPIC_BASE_URL: url };
  write(s);
  return previous;
}

/** Remove our routing, restoring `previous` if there was one before us. */
export function clearBaseUrl(ours: string, previous?: string): void {
  const s = read();
  if (!s.env || s.env.ANTHROPIC_BASE_URL !== ours) return; // someone else's now; leave it
  if (previous) s.env.ANTHROPIC_BASE_URL = previous;
  else delete s.env.ANTHROPIC_BASE_URL;
  if (Object.keys(s.env).length === 0) delete s.env;
  write(s);
}
