/**
 * Bounded child environment for local Windows spawns.
 *
 * Why this exists: on a Windows fleet host, `bd dolt pull/push` repeatedly
 * failed with
 *   fork/exec C:\Program Files\Git\mingw64\bin\git.exe: Not enough memory
 *   resources are available to process this command.
 * while tens of GB of RAM were free. That text is ERROR_NOT_ENOUGH_MEMORY (8)
 * from CreateProcess. With RAM free, the known causes are an oversized
 * environment block (every spawn copies the whole block into the child, and
 * each nested hop -- fleet server -> PowerShell/bash -> bd -> dolt -> git --
 * copies it again) and desktop-heap exhaustion in a non-interactive session.
 * The first one the product controls: WindowsCommands.getCleanEnv() builds
 * Path as Machine Path + ';' + User Path with no dedupe, and the gitbash
 * variant inherits the fleet server's env wholesale. See
 * docs/troubleshooting.md ("git spawned by bd/dolt fails with Not enough
 * memory resources") for the evidence and what was and was not reproduced.
 *
 * The rule (pure, unit-tested in tests/child-env-bound.test.ts):
 *   1. PATH is deduplicated: entries compared case-insensitively with
 *      trailing slashes ignored, first occurrence kept, empty entries
 *      dropped. All PATH-named keys (Path/PATH) are merged into the first.
 *   2. If the env block is still larger than CHILD_ENV_BLOCK_CAP_CHARS, the
 *      largest NON-PROTECTED variables are dropped, largest first, until it
 *      fits. Protected variables (what bd/dolt/git and the provider CLIs need:
 *      PATH, HOME/USERPROFILE and the session vars, temp dirs, git/ssh/proxy
 *      config, and anything that looks like a credential) are never dropped.
 *   3. If protected variables alone exceed the cap, the env is returned as
 *      small as the rule can make it and `overCap` is set so the caller can
 *      say so loudly -- the rule never drops PATH or a credential to fit.
 *
 * ASCII only.
 */

/**
 * Cap on the child environment block, in UTF-16 code units (what Windows
 * stores): 32767, the classic Windows environment-block limit and the hard
 * per-variable limit. A normal Windows user env is 3-8K, so a block above
 * this is a leak (duplicated PATH, an inherited oversized variable), not a
 * legitimate need.
 */
export const CHILD_ENV_BLOCK_CAP_CHARS = 32767;

/** Variable names (case-insensitive) a bd/dolt/git/provider child needs. */
const PROTECTED_NAMES = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PUBLIC', 'ALLUSERSPROFILE', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'PSMODULEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'MSYSTEM', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
]);

/** Name prefixes (case-insensitive) a bd/dolt/git/provider child needs. */
const PROTECTED_PREFIXES = [
  'GIT_', 'GCM_', 'GH_', 'GITHUB_', 'SSH_', 'BEADS_', 'BD_', 'DOLT_',
  'APRA_', 'FLEET_', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_',
  'GEMINI_', 'GOOGLE_', 'COPILOT_', 'AWS_', 'AZURE_', 'NODE_', 'NPM_',
];

/** Anything that looks like a credential is never dropped. */
const CREDENTIAL_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|AUTH)/i;

export function isProtectedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (PROTECTED_NAMES.has(upper)) return true;
  if (PROTECTED_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return CREDENTIAL_NAME_RE.test(name);
}

/**
 * Size of an environment block as CreateProcess sees it: each variable is
 * `NAME=VALUE\0`, and the block ends with one extra `\0`. JS string length is
 * UTF-16 code units, the same unit Windows uses.
 */
export function envBlockSize(env: Record<string, string>): number {
  let size = 1;
  for (const [k, v] of Object.entries(env)) size += k.length + 1 + v.length + 1;
  return size;
}

/** Dedupe a PATH value: case-insensitive, trailing slashes ignored, first wins, empties dropped. */
export function dedupePathValue(value: string, sep: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(sep)) {
    const entry = raw.trim();
    if (!entry) continue;
    const norm = entry.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(entry);
  }
  return out.join(sep);
}

export interface BoundedEnvReport {
  sizeBefore: number;
  sizeAfter: number;
  pathEntriesBefore: number;
  pathEntriesAfter: number;
  /** Names of variables dropped to fit the cap, largest first. */
  dropped: string[];
  /** True when protected variables alone exceed the cap. */
  overCap: boolean;
}

/**
 * Apply the bounding rule (see the file header). Never mutates `env`.
 *
 * @param env  the environment the child would otherwise receive
 * @param opts.sep  PATH separator (';' on Windows, the default)
 * @param opts.capChars  block cap in UTF-16 code units
 */
export function boundChildEnv(
  env: Record<string, string | undefined>,
  opts: { sep?: string; capChars?: number } = {},
): { env: Record<string, string>; report: BoundedEnvReport } {
  const sep = opts.sep ?? ';';
  const cap = opts.capChars ?? CHILD_ENV_BLOCK_CAP_CHARS;

  const input: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) input[k] = v;
  const sizeBefore = envBlockSize(input);

  const out: Record<string, string> = {};
  let pathKey: string | null = null;
  const pathParts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k.toUpperCase() === 'PATH') {
      if (pathKey === null) { pathKey = k; out[k] = ''; }
      pathParts.push(v);
      continue;
    }
    out[k] = v;
  }
  const rawPath = pathParts.join(sep);
  const pathEntriesBefore = rawPath.split(sep).filter((e) => e.trim()).length;
  let pathEntriesAfter = 0;
  if (pathKey !== null) {
    out[pathKey] = dedupePathValue(rawPath, sep);
    pathEntriesAfter = out[pathKey] ? out[pathKey].split(sep).length : 0;
  }

  const dropped: string[] = [];
  let size = envBlockSize(out);
  if (size > cap) {
    const candidates = Object.keys(out)
      .filter((k) => !isProtectedEnvName(k))
      .sort((a, b) => (b.length + out[b].length) - (a.length + out[a].length));
    for (const k of candidates) {
      if (size <= cap) break;
      size -= k.length + 1 + out[k].length + 1;
      delete out[k];
      dropped.push(k);
    }
  }

  return {
    env: out,
    report: {
      sizeBefore,
      sizeAfter: size,
      pathEntriesBefore,
      pathEntriesAfter,
      dropped,
      overCap: size > cap,
    },
  };
}

/** One-line human summary of a report, for a warning log. */
export function describeBoundedEnv(report: BoundedEnvReport): string {
  const parts = [
    `child env block ${report.sizeBefore} -> ${report.sizeAfter} chars (cap ${CHILD_ENV_BLOCK_CAP_CHARS})`,
    `PATH entries ${report.pathEntriesBefore} -> ${report.pathEntriesAfter}`,
  ];
  if (report.dropped.length) parts.push(`dropped oversized vars: ${report.dropped.join(', ')}`);
  if (report.overCap) parts.push('STILL OVER CAP from protected vars alone (PATH/credentials) -- Windows may refuse to spawn child processes ("Not enough memory resources")');
  return parts.join('; ');
}
