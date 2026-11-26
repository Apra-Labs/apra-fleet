import { isPosixShell } from '../utils/agent-helpers.js';
import type { OsCommands, MemberShell } from '../os/os-commands.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { RemoteOS } from '../utils/platform.js';

/**
 * Resolve-and-verify helpers for update_llm_cli. A member can carry several
 * installs of one CLI (an npm-global one and a native-installer one). Dispatch
 * runs whichever the member's non-interactive PATH resolves first, so an update
 * is only real if it changed THAT binary.
 */

/** npm package names for providers whose native updater differs from npm. */
const NPM_PACKAGE: Partial<Record<string, string>> = {
  claude: '@anthropic-ai/claude-code',
};

export interface ProbeResult {
  /** Path the member's PATH resolves the CLI to (undefined if not reported). */
  resolvedPath?: string;
  /** Output of `<bin> --version`. */
  version: string;
}

export function cliBinaryName(provider: ProviderAdapter): string {
  return provider.versionCommand().trim().split(/\s+/)[0];
}

/** The environment prefix agentVersion() puts before the provider command. */
function prefixOf(full: string, providerCmd: string): string | undefined {
  return full.endsWith(providerCmd) ? full.slice(0, full.length - providerCmd.length) : undefined;
}

/**
 * Single member-bound command that prints the resolved binary path on the
 * first line and `--version` output after it, under the same PATH prefix
 * dispatch uses. POSIX uses `command -v`; PowerShell uses `Get-Command`.
 * Returns undefined when the prefix cannot be derived (caller falls back to
 * the plain version command).
 */
export function buildProbeCommand(
  cmds: OsCommands, provider: ProviderAdapter, os: RemoteOS, shell?: MemberShell,
): string | undefined {
  const prefix = prefixOf(cmds.agentVersion(provider), provider.versionCommand());
  if (prefix === undefined) return undefined;
  const bin = cliBinaryName(provider);
  const resolve = isPosixShell(os, shell)
    ? `command -v ${bin}`
    : `(Get-Command ${bin} -ErrorAction SilentlyContinue).Source`;
  return `${prefix}${resolve}; ${provider.versionCommand()}`;
}

export function parseProbe(stdout: string): ProbeResult {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const looksLikePath = (l: string) => /^(\/|[A-Za-z]:[\\/]|~)/.test(l) && !/\s--?\w/.test(l);
  if (lines.length >= 2 && looksLikePath(lines[0])) {
    return { resolvedPath: lines[0], version: lines.slice(1).join('\n') };
  }
  return { version: lines.join('\n') };
}

export function isNativeInstall(resolvedPath: string): boolean {
  return /[\\/]\.local[\\/]bin[\\/]/.test(resolvedPath);
}

export interface UpdatePlan {
  command: string;
  /** Human-readable name of the installation the command updates. */
  updatedPath: string;
  /** True when the command targets the installation at resolvedPath. */
  targetsResolved: boolean;
  /**
   * Member command printing the version the update installs (npm plans only).
   * npm prints 'changed 1 package' even when that version is already installed,
   * so an unchanged binary is "already up to date" only if it equals this.
   */
  targetVersionCommand?: string;
}

/**
 * Pick the update that targets the resolved installation: npm-global when the
 * resolved binary is not the native one and the provider has an npm package;
 * otherwise the provider's own update command (native updater).
 */
export function buildUpdatePlan(
  cmds: OsCommands, provider: ProviderAdapter, resolvedPath: string | undefined,
): UpdatePlan {
  const bin = cliBinaryName(provider);
  const defaultCmd = cmds.updateAgent(provider);
  const pkg = NPM_PACKAGE[provider.name];
  const nativeNominal = `~/.local/bin/${bin}`;
  if (!resolvedPath) return { command: defaultCmd, updatedPath: nativeNominal, targetsResolved: false };
  if (pkg && !isNativeInstall(resolvedPath)) {
    const prefix = prefixOf(defaultCmd, provider.updateCommand()) ?? '';
    return {
      command: `${prefix}npm install -g ${pkg}@latest 2>&1`,
      updatedPath: `${resolvedPath} (npm global ${pkg})`,
      targetsResolved: true,
      targetVersionCommand: `${prefix}npm view ${pkg}@latest version`,
    };
  }
  return { command: defaultCmd, updatedPath: nativeNominal, targetsResolved: isNativeInstall(resolvedPath) };
}

/** First semver-like token in a version string ('2.1.286 (Claude Code)' -> '2.1.286'). */
export function versionToken(s: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(s)?.[0];
}

export const UP_TO_DATE_RE = /up[ -]to[ -]date|already (the )?(latest|installed)/i;
