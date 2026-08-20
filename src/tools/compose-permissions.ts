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
import { seedWorkspaceTrust } from '../utils/workspace-trust.js';
import type { Agent } from '../types.js';

export const composePermissionsSchema = z.object({
  ...memberIdentifier,
  role: z.enum(['doer', 'reviewer', 'deployer', 'integ-test-runner', 'regression-test-runner']).optional().describe('Role determines base profile (doer = broad build/test, reviewer = read + feedback + test); deployer, integ-test-runner and regression-test-runner select their own base-dev/base-reviewer mode plus a matching bounds-<role>.json profile. When a `grant` request carries a role, each newly requested permission is checked against the bounds-<role>.json profile for that role (skills/fleet/profiles/); with an INSTALLED host-side profiles directory an out-of-bounds permission REJECTS the whole grant unless allow_out_of_bounds is set, and with only the repo-relative dev-fallback profiles directory it degrades to informational (granted, ledger entry flagged outOfBounds:true with requestedByRole recorded for later audit). No role, or a role with no bounds file, skips the bounds check entirely. Pass the role whose runbook the requested prefixes came from -- a grant issued under an unrelated role is checked against the wrong allowlist and will be refused. Bounds never loosen the hard-rejected NEVER_AUTO_GRANT patterns, which are wildcard-matched (not exact-matched) against a normalized form of each request and cover sudo/su/doas, `bash -c`/`sh -c`/eval, env/printenv, nc/nmap, `chmod 777`, any catch-all such as Bash(*), and any payload containing a shell-chaining metacharacter (| ; && backtick $(). Provide at least one of role or tags.'),
  tags: z.array(z.string()).optional().describe('Member tags. Include "doer" or "reviewer" to set the primary mode (default doer); other tags (e.g. "gpu", "devops") load tag-<name>.json profiles and merge additively. When both role and tags are given, tags wins.'),
  project_folder: z.string().optional().describe('Local project folder containing permissions.json ledger. Omit to skip ledger merge.'),
  grant: z.array(z.string()).optional().describe('Reactive mode: additional permissions to grant (e.g. ["Bash(docker:*)", "Bash(docker-compose:*)"]). Appended to current permissions and re-delivered.'),
  grant_reason: z.string().optional().describe('Reason for the grant (stored in ledger)'),
  allow_out_of_bounds: z.boolean().optional().describe('OPERATOR ESCALATION ONLY. When a `grant` request carries a role that has a bounds-<role>.json profile, an out-of-bounds permission is REJECTED by default -- that role-gated allowlist is what bounds the worst case of the autonomous self-heal path. Set true to downgrade the check back to informational (permission granted, ledger entry flagged outOfBounds) for a deliberate one-off human grant. Autonomous callers (fleet-sprint\'s missing-permissions heal) must never set this: a member escalating its own permissions is exactly what the bounds check exists to prevent. Ignored when no role is supplied, when the role has no bounds file, or when the request contains no `grant`.'),
});

export type ComposePermissionsInput = z.infer<typeof composePermissionsSchema>;

// Stack marker files -> profile keys
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

// Never auto-grant - require user escalation.
//
// apra-fleet PR#416 review (finding 3): this was previously a seven-entry Set
// checked with exact string equality, so `Bash(sudo *)`, `Bash(sudo:*) `
// (trailing space), `Bash(bash -c *)`, `Bash(sh -c *)`, `Bash(*)` and
// `Bash(curl *|sh)` all sailed straight through -- i.e. arbitrary code
// execution was one whitespace character away from being auto-grantable.
// These are now wildcard *patterns* matched against a normalized form of the
// requested permission. A denylist can never be complete (`Bash(perl -e *)`,
// `Bash(node -e *)`, `Bash(make *)` remain arbitrary-execution in practice);
// it is the unconditional floor that applies to EVERY caller of this tool.
const NEVER_AUTO_GRANT_PATTERNS = [
  'Bash(sudo*)',
  'Bash(su *)',
  'Bash(doas*)',
  'Bash(*bash -c*)',
  'Bash(*sh -c*)',
  'Bash(*eval*)',
  'Bash(chmod 777*)',
  'Bash(env*)',
  'Bash(printenv*)',
  'Bash(nc*)',
  'Bash(nmap*)',
];

// Shell metacharacters that turn a single approved command into an arbitrary
// command chain. A grant payload containing any of these is rejected
// structurally, regardless of which command it names.
const SHELL_CHAINING_METACHARS = ['|', ';', '&&', '`', '$('];

/** Escapes a string for literal use inside a RegExp, except '*' which callers
 *  handle separately as the wildcard token. */
function escapeRegExpExceptStar(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches `permission` against `pattern`, treating '*' in the pattern as a
 * wildcard (matches any run of characters, including none) rather than a
 * literal character. A wildcard-free pattern still matches only by exact
 * equality.
 *
 * ONE implementation, deliberately shared by both wildcard consumers in this
 * file: the NEVER_AUTO_GRANT denylist (isNeverAutoGrant) and the per-role
 * bounds allowlist (isWithinBounds). They were briefly two byte-for-byte
 * identical functions -- `matchesDenyPattern` and `matchesBoundsPattern` --
 * which is exactly how a floor and a ceiling drift apart on what `*` means.
 * `matchesBoundsPattern` is kept as the exported alias because tests and
 * callers outside this file already reference that name.
 */
export function matchesWildcardPattern(pattern: string, permission: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExpExceptStar).join('.*')}$`);
  return regex.test(permission);
}

/** Splits `Tool(payload)` into its parts; returns null for a bare tool name. */
function splitPermission(permission: string): { tool: string; payload: string } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\((.*)\)$/.exec(permission.trim());
  if (!m) return null;
  return { tool: m[1]!, payload: m[2]! };
}

/**
 * Canonical form used for denylist matching only (never for storage or
 * delivery). Trims, collapses internal whitespace, and treats the ':' that
 * separates the command token from its argument pattern as equivalent to a
 * space, so `Bash(sudo:*)` and `Bash(sudo *)` are the same request.
 */
export function normalizePermission(permission: string): string {
  const s = permission.trim().replace(/\s+/g, ' ');
  const parts = splitPermission(s);
  if (!parts) return s;
  const payload = parts.payload.replace(':', ' ').replace(/\s+/g, ' ').trim();
  return `${parts.tool}(${payload})`;
}

/**
 * True when the requested permission must never be granted without explicit
 * user escalation. Three independent rules, any of which rejects:
 *  1. catch-all: a payload that is nothing but wildcards/whitespace -- e.g.
 *     `Bash(*)` -- which is not "a wider grant", it is unrestricted execution.
 *  2. shell chaining: the payload contains |, ;, &&, a backtick, or $( .
 *  3. pattern match against NEVER_AUTO_GRANT_PATTERNS.
 */
export function isNeverAutoGrant(permission: string): boolean {
  const normalized = normalizePermission(permission);
  const parts = splitPermission(normalized);
  const payload = parts?.payload ?? '';

  // 1. Catch-all grant (Bash(*), Bash( ** ), ...).
  if (parts && payload.replace(/[*\s]/g, '') === '') return true;

  // 2. Shell chaining metacharacters anywhere in the payload.
  if (SHELL_CHAINING_METACHARS.some(meta => payload.includes(meta))) return true;

  // 3. Explicit deny patterns (wildcard-aware).
  return NEVER_AUTO_GRANT_PATTERNS.some(pattern => matchesWildcardPattern(pattern, normalized));
}

interface Ledger {
  stacks: string[];
  granted: Array<{
    permission: string;
    reason: string;
    date: string;
    /** True when this grant fell outside the requesting role's bounds profile.
     *  Informational only -- never filters the entry out of the granted list. */
    outOfBounds?: true;
    /** Role that requested this grant, recorded for out-of-bounds auditing. */
    requestedByRole?: string;
  }>;
}

/** True when the located profiles dir is the installed, host-side one rather
 *  than a repo-relative dev fallback. Only the installed path is a genuine
 *  trust boundary -- see findProfilesDir(). */
let profilesDirIsInstalled = true;

function findProfilesDir(): string {
  // Installed: ~/.claude/skills/fleet/profiles/ (new location after skill split)
  const installedFleet = path.join(os.homedir(), '.claude', 'skills', 'fleet', 'profiles');
  if (fs.existsSync(installedFleet)) { profilesDirIsInstalled = true; return installedFleet; }
  // Installed (legacy): ~/.claude/skills/pm/profiles/
  const installedPm = path.join(os.homedir(), '.claude', 'skills', 'pm', 'profiles');
  if (fs.existsSync(installedPm)) { profilesDirIsInstalled = true; return installedPm; }
  // Dev fallback: walk up from __dirname looking for skills/fleet/profiles/.
  //
  // apra-fleet PR#416 review: this fallback is NOT a trust boundary. The whole
  // premise of the enforcing bounds check below is that bounds-<role>.json is
  // host-side and outside the sprint's write reach -- but in the dogfood
  // configuration (apra-fleet building apra-fleet from a checkout) this walk
  // resolves INTO the repo, where a doer can edit the very file that is
  // supposed to bound it. It is kept because a dev checkout with no installed
  // skill still needs to compose permissions at all, but every use is flagged
  // loudly and the bounds check downgrades itself to non-blocking when it
  // fires, so nobody mistakes an in-repo profiles dir for the boundary it is
  // not.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidateFleet = path.join(dir, 'skills', 'fleet', 'profiles');
    if (fs.existsSync(candidateFleet)) { warnRepoRelativeProfiles(candidateFleet); return candidateFleet; }
    const candidatePm = path.join(dir, 'skills', 'pm', 'profiles');
    if (fs.existsSync(candidatePm)) { warnRepoRelativeProfiles(candidatePm); return candidatePm; }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find profiles directory');
}

function warnRepoRelativeProfiles(resolved: string): void {
  profilesDirIsInstalled = false;
  console.warn(
    `[fleet] compose_permissions: NO installed profiles directory found ` +
    `(${path.join(os.homedir(), '.claude', 'skills', 'fleet', 'profiles')}); ` +
    `falling back to the REPO-RELATIVE dev path "${resolved}". ` +
    `This is not a trust boundary: in a dogfood configuration that directory is ` +
    `inside the checkout a sprint can write to, so per-role bounds are treated as ` +
    `INFORMATIONAL here and cannot block an out-of-bounds auto-grant. ` +
    `Install the fleet skill to restore the enforcing bounds check.`,
  );
}

function loadProfile(profilesDir: string, name: string): any {
  const filePath = path.join(profilesDir, `${name}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Loads the per-role bounds file (bounds-<role>.json) listing Bash permission
 *  prefix patterns considered in-scope for that role. Returns a defined empty
 *  array (never undefined/deny-all) for an unknown or missing role -- callers
 *  must treat an empty result as "no bounds check", not "deny everything". */
export function loadBounds(profilesDir: string, role: string | undefined): string[] {
  if (!role) return [];
  const bounds = loadProfile(profilesDir, `bounds-${role}`);
  if (!Array.isArray(bounds)) return [];
  return bounds;
}

/** Matches a single bounds entry against a granted permission string. Bounds
 *  files hold prefix patterns like "Bash(npm run build*)" or
 *  "Bash(*apra-fleet* run *)", not verbatim permission strings, so exact
 *  equality was never the right check (apra-fleet-ivxi.2). Thin alias over the
 *  file's single wildcard matcher -- see matchesWildcardPattern. */
export const matchesBoundsPattern = matchesWildcardPattern;

/** True when `permission` is covered by at least one entry in `bounds`
 *  (wildcard-aware, see matchesBoundsPattern). */
export function isWithinBounds(bounds: string[], permission: string): boolean {
  return bounds.some(pattern => matchesBoundsPattern(pattern, permission));
}

export function loadLedger(projectFolder: string): Ledger {
  const ledgerPath = path.join(projectFolder, 'permissions.json');
  if (fs.existsSync(ledgerPath)) {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    return { stacks: raw.stacks ?? [], granted: raw.granted ?? [] };
  }
  return { stacks: [], granted: [] };
}

export function saveLedger(projectFolder: string, ledger: Ledger): void {
  const ledgerPath = path.join(projectFolder, 'permissions.json');
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
}

async function detectStacks(agent: Agent, projectSubdir?: string): Promise<string[]> {
  const strategy = getStrategy(agent);
  const markers = Object.keys(STACK_MAP).join(' ');
  // Resolve the directory to check on the member: prefer <workFolder>/<projectSubdir>,
  // fall back to workFolder root. Using an absolute cd ensures remote (SSH) members
  // check the right directory instead of defaulting to their home directory.
  const checkDir = projectSubdir
    ? `${agent.workFolder}/${projectSubdir}`.replace(/\\/g, '/')
    : agent.workFolder.replace(/\\/g, '/');
  // TODO: unbranched POSIX && / || / 2>/dev/null -- same defect class as
  // orphan-recovery.ts's pid-alive/file-read commands (apra-fleet review,
  // fix/cross-shell-home-var). Not yet OS-branched for Windows members.
  const result = await strategy.execCommand(`cd "${checkDir}" 2>/dev/null && ls ${markers} 2>/dev/null || true`, 10000);
  const found = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const file = line.trim();
    if (STACK_MAP[file]) found.add(STACK_MAP[file]);
  }
  // .sln/.csproj need glob - check separately
  // TODO: same unbranched-POSIX defect class as above -- not yet OS-branched.
  const dotnetCheck = await strategy.execCommand(`cd "${checkDir}" 2>/dev/null && ls *.sln *.csproj 2>/dev/null || true`, 5000);
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

/** Determine the primary permission mode from tags and/or role.
 *  Precedence: first of 'doer'/'reviewer' appearing in tags wins (tags beats role);
 *  otherwise fall back to role; default to 'doer'. */
function resolvePrimaryMode(role: string | undefined, tags: string[] | undefined): 'doer' | 'reviewer' {
  if (tags?.length) {
    for (const tag of tags) {
      if (tag === 'doer' || tag === 'reviewer') return tag;
    }
  }
  if (role === 'doer' || role === 'reviewer') return role;
  return 'doer';
}

/** Tag-aware composition. Loads the base profile for the primary mode, merges stack
 *  profiles keyed by mode, then merges tag-<name>.json for every non-mode tag, plus
 *  ledger grants. Additive (Set-based) merge -- order-independent, deduplicated. */
function composeFromTags(profilesDir: string, mode: 'doer' | 'reviewer', tags: string[], stacks: string[], ledger: Ledger): string[] {
  const baseName = mode === 'doer' ? 'base-dev' : 'base-reviewer';
  const base = loadProfile(profilesDir, baseName);
  const perms = new Set<string>(base?.permissions?.allow ?? []);

  const profileKey = mode === 'doer' ? 'dev' : 'reviewer';

  // Stack profiles (detected from the project), keyed by mode
  for (const stack of stacks) {
    const profile = loadProfile(profilesDir, stack);
    if (profile?.[profileKey]) {
      for (const p of profile[profileKey]) perms.add(p);
    }
  }

  // Custom tag profiles: tag-<name>.json for each non-mode tag. Unknown tags
  // (no matching profile file) are silently ignored.
  for (const tag of tags) {
    if (tag === 'doer' || tag === 'reviewer') continue;
    const profile = loadProfile(profilesDir, `tag-${tag}`);
    if (profile?.[profileKey]) {
      for (const p of profile[profileKey]) perms.add(p);
    }
  }

  // Merge ledger grants
  for (const entry of ledger.granted) {
    perms.add(entry.permission);
  }

  return [...perms];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively merges `source` into `target`: nested plain objects merge key
 *  by key (union of both sides); everything else (arrays, scalars) from
 *  `source` overwrites the same key in `target`. This is what lets
 *  compose_permissions rewrite `permissions`/`mcpServers.apra-fleet` while
 *  preserving unrelated entries register_member already wrote to the same
 *  file (e.g. `mcpServers['apra-fleet-member']`, which carries the member's
 *  live JWT and was previously destroyed by a wholesale overwrite). */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Raised by deliverConfigFile when a config write does not verifiably land on
 *  the member (nonzero mkdir/write exit, or a read-back that does not match the
 *  intended content). Carries the target path so the caller can surface exactly
 *  which delivery failed. See apra-fleet-k4sc: the previous code discarded the
 *  exit code and never read the file back, so a failed write was reported as a
 *  successful grant (a silent no-op). */
export class ConfigDeliveryError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(message);
    this.name = 'ConfigDeliveryError';
  }
}

/** Short, single-line excerpt of a command's stderr for error messages. */
function stderrExcerpt(stderr: string | undefined): string {
  const s = (stderr ?? '').replace(/\s+/g, ' ').trim();
  return s ? `: ${s.slice(0, 300)}` : '';
}

/** Order-independent structural serialization used to compare a read-back JSON
 *  document against the intended merged content (keys sorted recursively). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deliver a single config file to the member.
 *  Creates parent directory and writes the content (JSON object or TOML string).
 *  JSON object content is deep-merged into whatever the file already
 *  contains remotely, rather than overwriting it wholesale -- other tools
 *  (e.g. register_member's mcpServers entry) may share the same file.
 *
 *  Every remote step is verified so a failed write can never be reported as a
 *  successful grant (apra-fleet-k4sc):
 *   1. mkdir and write exit codes are inspected; a nonzero code throws a
 *      ConfigDeliveryError carrying the command's exit code and stderr excerpt.
 *   2. After writing, the file is read back (cat on POSIX, Get-Content -Raw on
 *      Windows) and the intended content is confirmed to have landed -- for JSON
 *      the parsed document must structurally match the merged content; for a
 *      TOML/string payload the expected text must be present. A mismatch (empty
 *      file, wrong path, quoting fault, etc.) throws a ConfigDeliveryError. */
/** Join a work-folder-relative config path onto the member's absolute work
 *  folder, OS-appropriately. `strategy.execCommand` issues a raw shell/SSH
 *  exec with no cwd guarantee (LocalStrategy spawns with cwd=workFolder, but
 *  RemoteStrategy's ssh2 client.exec() defaults to the SSH user's home
 *  directory, not workFolder) -- so every command deliverConfigFile issues
 *  must use an absolute path, never a bare relative one. See apra-fleet
 *  incident: compose_permissions reported a verified grant while writing to
 *  ~/.claude/settings.local.json on a remote member instead of
 *  <workFolder>/.claude/settings.local.json -- the read-back verification
 *  passed because it re-read the same (wrong) relative path it had just
 *  written, so the mismatch was invisible to that check alone. */
function resolveRemotePath(workFolder: string, relPath: string, isWindows: boolean): string {
  if (isWindows) {
    const base = workFolder.replace(/[\\/]+$/, '').replace(/\//g, '\\');
    return `${base}\\${relPath.replace(/\//g, '\\')}`;
  }
  const base = workFolder.replace(/\/+$/, '');
  return `${base}/${relPath}`;
}

async function deliverConfigFile(
  strategy: Awaited<ReturnType<typeof getStrategy>>,
  agentOs: string,
  workFolder: string,
  filePath: string,
  content: Record<string, unknown> | string,
): Promise<void> {
  const isWindows = agentOs === 'windows';
  const absPath = resolveRemotePath(workFolder, filePath, isWindows);
  const winPath = absPath.replace(/\//g, '\\');
  const dir = isWindows
    ? winPath.split('\\').slice(0, -1).join('\\')
    : absPath.split('/').slice(0, -1).join('/');
  const mkdirCmd = isWindows
    ? `New-Item -ItemType Directory -Force "${dir}"`
    : `mkdir -p "${dir}"`;
  const mkdirResult = await strategy.execCommand(mkdirCmd, 5000);
  if (mkdirResult.code !== 0) {
    throw new ConfigDeliveryError(
      absPath,
      `could not create parent directory "${dir}" (exit ${mkdirResult.code})${stderrExcerpt(mkdirResult.stderr)}`,
    );
  }

  const readCmd = isWindows
    ? `Get-Content -Raw "${winPath}" -ErrorAction SilentlyContinue`
    : `cat "${absPath}" 2>/dev/null || true`;

  let mergedContent: Record<string, unknown> | string = content;
  if (isPlainObject(content)) {
    const readResult = await strategy.execCommand(readCmd, 5000);
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readResult.stdout.trim());
      if (isPlainObject(parsed)) existing = parsed;
    } catch {
      // file missing, empty, or not JSON -- start from an empty object
    }
    mergedContent = deepMerge(existing, content);
  }

  const contentStr = typeof mergedContent === 'string'
    ? mergedContent
    : JSON.stringify(mergedContent, null, 2);

  const writeCmd = isWindows
    ? `[System.IO.File]::WriteAllText("${winPath}", '${contentStr.replace(/'/g, "''")}', (New-Object System.Text.UTF8Encoding($false)))`
    : `cat > "${absPath}" << 'FLEET_PERMS_EOF'\n${contentStr}\nFLEET_PERMS_EOF`;
  const writeResult = await strategy.execCommand(writeCmd, 5000);
  if (writeResult.code !== 0) {
    throw new ConfigDeliveryError(
      absPath,
      `write command failed (exit ${writeResult.code})${stderrExcerpt(writeResult.stderr)}`,
    );
  }

  // Read the file back and confirm the intended content actually landed. This
  // catches the silent no-op class of failure that a nonzero exit code alone
  // would miss (e.g. a write that "succeeds" but resolves to the wrong path, or
  // a PowerShell quoting fault that writes nothing).
  const verifyResult = await strategy.execCommand(readCmd, 5000);
  const readBack = verifyResult.stdout.trim();
  if (!readBack) {
    throw new ConfigDeliveryError(
      absPath,
      `read-back verification failed: file is empty or missing after a write that reported success`,
    );
  }
  if (typeof mergedContent === 'string') {
    if (!readBack.includes(contentStr.trim())) {
      throw new ConfigDeliveryError(
        absPath,
        `read-back verification failed: expected content is not present on disk`,
      );
    }
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readBack);
    } catch {
      throw new ConfigDeliveryError(
        absPath,
        `read-back verification failed: file on disk is not valid JSON`,
      );
    }
    if (stableStringify(parsed) !== stableStringify(mergedContent)) {
      throw new ConfigDeliveryError(
        absPath,
        `read-back verification failed: merged permissions did not land on disk`,
      );
    }
  }
}

export async function composePermissions(input: ComposePermissionsInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  if (!input.role && !(input.tags && input.tags.length)) {
    return 'Provide at least one of role or tags to compose permissions.';
  }

  // Primary mode drives the base profile and the provider config. When both role
  // and tags are supplied, tags win (a doer/reviewer tag overrides role).
  const mode = resolvePrimaryMode(input.role, input.tags);

  const provider = getProvider(agent.llmProvider);
  const strategy = getStrategy(agent);
  const profilesDir = findProfilesDir();
  const ledger = input.project_folder ? loadLedger(input.project_folder) : { stacks: [], granted: [] };

  // Reactive grant mode
  if (input.grant?.length) {
    const blocked = input.grant.filter(p => isNeverAutoGrant(p));
    if (blocked.length) {
      return `❌ Cannot auto-grant dangerous permissions: ${blocked.join(', ')}. Escalate to user.`;
    }

    // apra-fleet PR#416 review, finding 3 (option 3B): the per-role bounds
    // allowlist is ENFORCING on the autonomous grant path.
    //
    // The denylist above is an unconditional floor, but a denylist can never
    // be complete. Bounds are the ceiling: when a request carries a role that
    // has a bounds-<role>.json profile, an auto-grant can only ever produce a
    // prefix a human put in a host-side product profile. That makes the worst
    // case BOUNDED rather than enumerated.
    //
    // PR #416's original design argued against blocking -- it "would convert
    // an audit signal into a new failure mode for a role whose bounds file
    // happens to be slightly stale". That is real, and it resolves the same
    // way the base-branch runbook read does: fail closed and surface it. A
    // stale bounds file is a five-second human fix; an unbounded auto-grant
    // is not.
    //
    // Three deliberate carve-outs keep this from breaking legitimate use:
    //   1. No role, or a role with no bounds file -> no check at all (today's
    //      behavior, unchanged). Manual/operator grants keep the denylist as
    //      their only gate, which is why finding 3A had to land as well.
    //   2. `allow_out_of_bounds: true` -> explicit operator escalation,
    //      downgrades to the informational ledger flag. Autonomous callers
    //      never set it.
    //   3. A repo-relative (dev fallback) profiles dir is NOT a trust
    //      boundary in the dogfood configuration -- a sprint could edit the
    //      bounds file that is supposed to bound it -- so blocking there
    //      would be security theatre. Downgrade to informational and say so.
    const bounds = loadBounds(profilesDir, input.role);
    const boundsEnforcing = bounds.length > 0 && !input.allow_out_of_bounds && profilesDirIsInstalled;
    if (boundsEnforcing) {
      const outOfBounds = input.grant.filter(p => !isWithinBounds(bounds, p));
      if (outOfBounds.length) {
        return `❌ Out of bounds for role "${input.role}": ${outOfBounds.join(', ')}. ` +
          `That role's allowlist (skills/fleet/profiles/bounds-${input.role}.json) does not cover ` +
          `${outOfBounds.length === 1 ? 'it' : 'them'}, so this grant is refused rather than flagged. ` +
          `If the permission is genuinely in scope for the role, add it to the bounds profile in a ` +
          `reviewed repo change; for a deliberate one-off human grant, re-issue with ` +
          `allow_out_of_bounds: true.`;
      }
    }

    // Expand co-occurrences. These are added by this tool, not requested by
    // the caller, so an out-of-bounds expansion is DROPPED rather than made to
    // fail the whole request -- the caller asked for something legitimate and
    // should get it.
    const expanded = new Set(input.grant);
    const droppedCoOccurrences: string[] = [];
    for (const p of input.grant) {
      for (const co of CO_OCCURRENCE[p] ?? []) {
        if (boundsEnforcing && !isWithinBounds(bounds, co)) {
          droppedCoOccurrences.push(co);
          continue;
        }
        expanded.add(co);
      }
    }

    let allow: string[];

    if (provider.name === 'claude') {
      // Claude: read existing allow list and merge. Must read the SAME absolute
      // path deliverConfigFile will write below -- deepMerge overwrites arrays
      // wholesale (see deepMerge doc comment), so an `allow` computed from the
      // wrong file here would silently discard every pre-existing grant in the
      // real settings.local.json once the write lands at the correct path.
      const isWindowsAgent = (agent.os ?? 'linux') === 'windows';
      const absSettingsPath = resolveRemotePath(agent.workFolder, '.claude/settings.local.json', isWindowsAgent);
      // TODO: unbranched POSIX `2>/dev/null || echo` -- same defect class as
      // orphan-recovery.ts's pid-alive/file-read commands. Not yet OS-branched.
      const readResult = isWindowsAgent
        ? await strategy.execCommand(`Get-Content -Raw "${absSettingsPath.replace(/\//g, '\\')}" -ErrorAction SilentlyContinue`, 5000)
        : await strategy.execCommand(`cat "${absSettingsPath}" 2>/dev/null || echo "{}"`, 5000);
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

    const configs = provider.composePermissionConfig(mode, allow);
    const paths = provider.permissionConfigPaths();
    try {
      for (let i = 0; i < paths.length; i++) {
        await deliverConfigFile(strategy, agent.os ?? 'linux', agent.workFolder, paths[i], configs[i]);
      }
    } catch (e) {
      if (e instanceof ConfigDeliveryError) {
        // Delivery did not verifiably land -- surface the failure and do NOT
        // touch the ledger or report a successful grant (apra-fleet-k4sc).
        return `❌ Failed to persist permissions to ${e.filePath} on "${agent.friendlyName}" (${provider.name}): ${e.message}`;
      }
      throw e;
    }

    // Update ledger (only reached when every config file verifiably landed)
    if (input.project_folder) {
      const reason = input.grant_reason ?? 'granted mid-sprint';
      const date = new Date().toISOString().slice(0, 10);
      // apra-fleet-ivxi.1.3: when the request carries a role, flag any grant
      // outside that role's bounds profile for later audit. A defined-empty
      // bounds result (no role supplied, or an unknown/missing role -- see
      // loadBounds) means "no bounds check".
      //
      // Reaching this point with an out-of-bounds permission now means the
      // check was NON-enforcing for one of the three reasons documented at
      // the enforcement site above (no bounds file, an explicit
      // allow_out_of_bounds operator escalation, or a repo-relative dev
      // profiles dir). The ledger flag is what makes that visible afterwards.
      for (const p of expanded) {
        if (!ledger.granted.some(e => e.permission === p)) {
          const entry: Ledger['granted'][number] = { permission: p, reason, date };
          if (bounds.length > 0 && !isWithinBounds(bounds, p)) {
            entry.outOfBounds = true;
            entry.requestedByRole = input.role;
          }
          ledger.granted.push(entry);
        }
      }
      saveLedger(input.project_folder, ledger);
    }

    // apra-fleet-eft.40.2: self-healing -- repair workspace trust on EVERY
    // compose_permissions run (a member registered before this fix, or one whose
    // trust was never seeded, gets fixed the next time permissions are composed).
    await seedWorkspaceTrust(agent, strategy, 'compose_permissions');

    const droppedLine = droppedCoOccurrences.length
      ? `\n  (dropped ${droppedCoOccurrences.length} co-occurrence expansion(s) outside role "${input.role}"'s bounds: ${droppedCoOccurrences.join(', ')})`
      : '';
    return `✅ Granted ${[...expanded].length} permissions on "${agent.friendlyName}" (${provider.name}):\n  ${[...expanded].join('\n  ')}${droppedLine}`;
  }

  // Proactive compose mode
  const projectSubdir = input.project_folder ? path.basename(input.project_folder) : undefined;
  const stacks = await detectStacks(agent, projectSubdir);

  const allow = input.tags?.length
    ? composeFromTags(profilesDir, mode, input.tags, stacks, ledger)
    : compose(profilesDir, mode, stacks, ledger);
  const configs = provider.composePermissionConfig(mode, allow);
  const paths = provider.permissionConfigPaths();

  try {
    for (let i = 0; i < paths.length; i++) {
      await deliverConfigFile(strategy, agent.os ?? 'linux', agent.workFolder, paths[i], configs[i]);
    }
  } catch (e) {
    if (e instanceof ConfigDeliveryError) {
      // Delivery did not verifiably land -- surface the failure and do NOT
      // update the ledger stacks or report success (apra-fleet-k4sc).
      return `❌ Failed to persist permissions to ${e.filePath} on "${agent.friendlyName}" (${provider.name}): ${e.message}`;
    }
    throw e;
  }

  // Update ledger stacks (only reached when every config file verifiably landed)
  if (input.project_folder) {
    ledger.stacks = stacks;
    saveLedger(input.project_folder, ledger);
  }

  // apra-fleet-eft.40.2: self-healing -- repair workspace trust on EVERY
  // compose_permissions run (a member registered before this fix, or one whose
  // trust was never seeded, gets fixed the next time permissions are composed).
  await seedWorkspaceTrust(agent, strategy, 'compose_permissions');

  const customTags = (input.tags ?? []).filter(t => t !== 'doer' && t !== 'reviewer');
  const tagsLine = customTags.length ? `\n  Tags: ${customTags.join(', ')}` : '';
  return `✅ Permissions composed for "${agent.friendlyName}" (${mode}, ${provider.name}):\n  Stacks: ${stacks.join(', ') || 'none detected'}${tagsLine}\n  Config: ${paths.join(', ')}\n  Ledger grants: ${ledger.granted.length}`;
}
