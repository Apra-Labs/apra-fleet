/**
 * Workflow-package registry service (apra-fleet-iywi.3.1 / F13).
 *
 * Owns <data dir>/workflow-packages.json: the set of registered workflow
 * packages, written atomically (tmp file + rename, never an in-place
 * truncate-and-write). Also owns the health poll for each known package
 * (registered or config-declared) and the apraFleetApi semver-range
 * compatibility check run at registration time.
 *
 * Routes that expose this over HTTP are
 * src/console/routes/workflow-packages.ts (apra-fleet-iywi.3.2) -- this
 * module is I/O only, no HTTP handling here.
 *
 * VERSION CHECK -- two verified gotchas, both handled below:
 *  1. There is no semver package anywhere in this repo's dependencies or
 *     devDependencies. satisfiesVersionRange() below is a narrow, hand-rolled
 *     subset -- see SUPPORTED_RANGE_SYNTAX for exactly what it accepts -- and
 *     it REJECTS anything outside that set with a clear error rather than
 *     silently treating it as satisfied (a range check that fails open is
 *     worse than none).
 *  2. src/version.ts's serverVersion is NOT bare semver: it is `v${version}`
 *     plus, in a dev checkout with a .git dir, `_` + a 6-char commit hash
 *     (e.g. "v0.5.0_ab12cd"). normalizeServerVersion() strips the leading
 *     "v" and any "_<hash>" suffix before any range comparison.
 *
 * Health polling takes an injectable clock (`now`) and an injectable fetch
 * (`fetchImpl`) so tests are deterministic -- the offline threshold is
 * evaluated by comparing injected timestamps, never by waiting on a real
 * timer. A failing probe is swallowed inside probeOne(): it must never
 * throw into the request path, only degrade that one package's health
 * record.
 *
 * Storage reads the file fresh on every register/unregister/list call --
 * same pattern as src/services/registry.ts's loadRegistry() -- rather than
 * caching an in-memory copy, so there is no separate "loaded" state to keep
 * in sync across calls or forget to reset between tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import { serverVersion as realServerVersion } from '../version.js';
import { getWorkflowPackagesConfig, type WorkflowPackageConfigEntry } from './user-config.js';

// ---------------------------------------------------------------------------
// Version-range matching -- narrow hand-rolled subset (no semver dep in repo).
// ---------------------------------------------------------------------------

export const SUPPORTED_RANGE_SYNTAX =
  'Supported apraFleetApi range syntax: an exact version ("1.2.3"), a comparator ' +
  '(">=", "<=", ">", "<", "=") followed by MAJOR.MINOR.PATCH, or a caret/tilde range ' +
  '("^1.2.3", "~1.2.3"). Multiple comparators may be space-separated (AND-ed together). ' +
  '"*" matches any version. OR ranges ("||") and hyphen ranges ("1.0.0 - 2.0.0") are not supported.';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const RANGE_TOKEN_RE = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;

function parseVersion(raw: string): ParsedVersion {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) {
    throw new Error(`Unsupported version "${raw}": expected MAJOR.MINOR.PATCH. ${SUPPORTED_RANGE_SYNTAX}`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Upper (exclusive) bound of a caret range, standard semver caret rules:
 *  ^1.2.3 -> <2.0.0, ^0.2.3 -> <0.3.0, ^0.0.3 -> <0.0.4. */
function caretUpperBound(v: ParsedVersion): ParsedVersion {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0 };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: v.patch + 1 };
}

/** Upper (exclusive) bound of a tilde range: ~1.2.3 -> <1.3.0. */
function tildeUpperBound(v: ParsedVersion): ParsedVersion {
  return { major: v.major, minor: v.minor + 1, patch: 0 };
}

function satisfiesComparator(version: ParsedVersion, op: string | undefined, bound: ParsedVersion): boolean {
  switch (op) {
    case '^': return compareVersions(version, bound) >= 0 && compareVersions(version, caretUpperBound(bound)) < 0;
    case '~': return compareVersions(version, bound) >= 0 && compareVersions(version, tildeUpperBound(bound)) < 0;
    case '>=': return compareVersions(version, bound) >= 0;
    case '<=': return compareVersions(version, bound) <= 0;
    case '>': return compareVersions(version, bound) > 0;
    case '<': return compareVersions(version, bound) < 0;
    case '=':
    case undefined:
      return compareVersions(version, bound) === 0;
    default:
      return false;
  }
}

/**
 * Does `version` (already normalized -- see normalizeServerVersion) satisfy
 * `range`? Throws for any syntax outside SUPPORTED_RANGE_SYNTAX.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*') {
    parseVersion(version);
    return true;
  }
  if (trimmed.includes('||') || trimmed.includes(' - ')) {
    throw new Error(`Unsupported apraFleetApi range "${range}": OR/hyphen ranges are not supported. ${SUPPORTED_RANGE_SYNTAX}`);
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(`Unsupported apraFleetApi range "${range}": empty range. ${SUPPORTED_RANGE_SYNTAX}`);
  }
  const parsedVersion = parseVersion(version);
  for (const token of tokens) {
    const m = RANGE_TOKEN_RE.exec(token);
    if (!m) {
      throw new Error(`Unsupported apraFleetApi range syntax "${token}" (in "${range}"). ${SUPPORTED_RANGE_SYNTAX}`);
    }
    const bound = parseVersion(m[2]);
    if (!satisfiesComparator(parsedVersion, m[1], bound)) return false;
  }
  return true;
}

/** Strip src/version.ts's server-version wrapper down to bare semver: the
 *  leading "v" and a trailing "_<hash>" (dev-checkout suffix) both go. */
export function normalizeServerVersion(raw: string): string {
  let v = raw.trim();
  if (v.startsWith('v') || v.startsWith('V')) v = v.slice(1);
  const hashIdx = v.indexOf('_');
  if (hashIdx !== -1) v = v.slice(0, hashIdx);
  return v;
}

// ---------------------------------------------------------------------------
// Registry storage + health polling
// ---------------------------------------------------------------------------

/** A package failing its health probe for this long (simulated or real
 *  wall-clock time, via the injected clock) reports as offline. */
export const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;

const HEALTH_PATH = '/health';
const REGISTRY_VERSION = 1;

export interface RegisteredPackageInput {
  id: string;
  baseUrl: string;
  apraFleetApi: string;
}

interface StoredPackage extends RegisteredPackageInput {
  registeredAt: number;
}

interface RegistryDocument {
  version: number;
  packages: StoredPackage[];
}

export interface WorkflowPackageView {
  id: string;
  baseUrl: string;
  /** null for config-declared entries -- they carry no recorded range. */
  apraFleetApi: string | null;
  configDeclared: boolean;
  offline: boolean;
  lastCheckedAt: number | null;
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: 'incompatible'; message: string }
  | { ok: false; reason: 'invalid-range'; message: string };

export type UnregisterResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'config-declared' };

export interface WorkflowPackageServiceDeps {
  filePath?: string;
  fs?: Pick<typeof fs, 'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync'>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  getServerVersion?: () => string;
  getConfigPackages?: () => WorkflowPackageConfigEntry[];
}

interface HealthRecord {
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  /** Wall-clock (per the injected `now`) of the start of the CURRENT failure
   *  streak; null while the package is healthy (or has never been probed). */
  firstFailureAt: number | null;
}

export interface WorkflowPackageService {
  readonly filePath: string;
  register(input: RegisteredPackageInput): Promise<RegisterResult>;
  unregister(id: string): Promise<UnregisterResult>;
  /** Probe every known package (registered + config-declared) once. Never
   *  throws -- a failing probe only updates that package's health record. */
  refreshHealth(): Promise<void>;
  list(): WorkflowPackageView[];
}

function defaultFilePath(): string {
  return path.join(FLEET_DIR, 'workflow-packages.json');
}

export function createWorkflowPackageService(deps: WorkflowPackageServiceDeps = {}): WorkflowPackageService {
  const filePath = deps.filePath ?? defaultFilePath();
  const tmpPath = `${filePath}.tmp`;
  const fsImpl = deps.fs ?? fs;
  const now = deps.now ?? (() => Date.now());
  const fetchFn = deps.fetchImpl ?? fetch;
  const getServerVersion = deps.getServerVersion ?? (() => realServerVersion);
  const getConfigPackages = deps.getConfigPackages ?? getWorkflowPackagesConfig;

  const health = new Map<string, HealthRecord>();

  /** Read the registry fresh from disk. Missing file (fresh install) or
   *  corrupted contents both resolve to an empty map rather than throwing --
   *  the next register/unregister call overwrites the file with a fresh,
   *  valid document. */
  function readPackages(): Map<string, StoredPackage> {
    let raw: string;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf-8') as string;
    } catch {
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw) as RegistryDocument;
      const next = new Map<string, StoredPackage>();
      if (parsed && Array.isArray(parsed.packages)) {
        for (const p of parsed.packages) {
          if (p && typeof p.id === 'string' && typeof p.baseUrl === 'string' && typeof p.apraFleetApi === 'string') {
            next.set(p.id, {
              id: p.id,
              baseUrl: p.baseUrl,
              apraFleetApi: p.apraFleetApi,
              registeredAt: typeof p.registeredAt === 'number' ? p.registeredAt : now(),
            });
          }
        }
      }
      return next;
    } catch {
      return new Map();
    }
  }

  /** Atomic write: tmp file + rename, never an in-place truncate. */
  function writePackages(map: Map<string, StoredPackage>): void {
    const doc: RegistryDocument = { version: REGISTRY_VERSION, packages: [...map.values()] };
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(tmpPath, JSON.stringify(doc, null, 2), 'utf-8');
    fsImpl.renameSync(tmpPath, filePath);
  }

  function isConfigDeclared(id: string): boolean {
    return getConfigPackages().some((c) => c.id === id);
  }

  async function register(input: RegisteredPackageInput): Promise<RegisterResult> {
    const normalizedServerVersion = normalizeServerVersion(getServerVersion());
    let compatible: boolean;
    try {
      compatible = satisfiesVersionRange(normalizedServerVersion, input.apraFleetApi);
    } catch (err) {
      return { ok: false, reason: 'invalid-range', message: err instanceof Error ? err.message : String(err) };
    }
    if (!compatible) {
      return {
        ok: false,
        reason: 'incompatible',
        message: `apraFleetApi range "${input.apraFleetApi}" does not match server version ${normalizedServerVersion}`,
      };
    }

    const map = readPackages();
    map.set(input.id, { id: input.id, baseUrl: input.baseUrl, apraFleetApi: input.apraFleetApi, registeredAt: now() });
    writePackages(map);
    return { ok: true };
  }

  async function unregister(id: string): Promise<UnregisterResult> {
    if (isConfigDeclared(id)) return { ok: false, reason: 'config-declared' };
    const map = readPackages();
    if (!map.has(id)) return { ok: false, reason: 'not-found' };
    map.delete(id);
    writePackages(map);
    health.delete(id);
    return { ok: true };
  }

  function healthRecordFor(id: string): HealthRecord {
    let rec = health.get(id);
    if (!rec) {
      rec = { lastCheckedAt: null, lastSuccessAt: null, firstFailureAt: null };
      health.set(id, rec);
    }
    return rec;
  }

  async function probeOne(id: string, baseUrl: string): Promise<void> {
    const rec = healthRecordFor(id);
    const checkedAt = now();
    try {
      const res = await fetchFn(`${baseUrl}${HEALTH_PATH}`);
      if (!res || !res.ok) {
        throw new Error(`non-ok health response (${res ? res.status : 'no response'})`);
      }
      rec.lastCheckedAt = checkedAt;
      rec.lastSuccessAt = checkedAt;
      rec.firstFailureAt = null;
    } catch {
      // The poll must never throw into the request path -- swallow here and
      // only record the failure on this package's own health record.
      rec.lastCheckedAt = checkedAt;
      if (rec.firstFailureAt === null) rec.firstFailureAt = checkedAt;
    }
  }

  async function refreshHealth(): Promise<void> {
    const map = readPackages();
    const targets = new Map<string, string>();
    for (const c of getConfigPackages()) targets.set(c.id, c.baseUrl);
    for (const p of map.values()) if (!targets.has(p.id)) targets.set(p.id, p.baseUrl);
    await Promise.all([...targets.entries()].map(([id, baseUrl]) => probeOne(id, baseUrl)));
  }

  function isOffline(id: string): boolean {
    const rec = health.get(id);
    if (!rec || rec.firstFailureAt === null) return false;
    return now() - rec.firstFailureAt >= OFFLINE_THRESHOLD_MS;
  }

  function list(): WorkflowPackageView[] {
    const seen = new Set<string>();
    const out: WorkflowPackageView[] = [];
    // Config-declared entries first and always present -- they are static
    // and win any id collision against a registered package (documented
    // behavior: a config-declared id can never be shadowed or removed).
    for (const c of getConfigPackages()) {
      seen.add(c.id);
      const rec = health.get(c.id);
      out.push({
        id: c.id,
        baseUrl: c.baseUrl,
        apraFleetApi: null,
        configDeclared: true,
        offline: isOffline(c.id),
        lastCheckedAt: rec?.lastCheckedAt ?? null,
      });
    }
    for (const p of readPackages().values()) {
      if (seen.has(p.id)) continue;
      const rec = health.get(p.id);
      out.push({
        id: p.id,
        baseUrl: p.baseUrl,
        apraFleetApi: p.apraFleetApi,
        configDeclared: false,
        offline: isOffline(p.id),
        lastCheckedAt: rec?.lastCheckedAt ?? null,
      });
    }
    return out;
  }

  return { filePath, register, unregister, refreshHealth, list };
}

/** Process-wide singleton used by the console routes (apra-fleet-iywi.3.2). */
export const workflowPackageService: WorkflowPackageService = createWorkflowPackageService();
