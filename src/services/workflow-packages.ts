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
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';
import { FLEET_DIR } from '../paths.js';
import { serverVersion as realServerVersion } from '../version.js';
import { getOrCreateKey } from './jwt.js';
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
// baseUrl scheme validation -- ONE shared check for both entry points that
// can place a baseUrl in front of the /ext proxy (apra-fleet-iywi.9):
// POST /api/workflow-packages/register (routes/workflow-packages.ts) and the
// workflowPackages config key (this file's getConfigPackages() reader,
// below). src/console/proxy.ts also refuses a non-http(s) upstream, but that
// is a separate, belt-and-braces backstop for baseUrls this validator never
// sees (e.g. a hand-edited registry file) -- it must not be treated as a
// second copy of this check.
//
// `new URL()` happily parses strings that are useless as an http.request
// target: 'ftp://host/' (protocol 'ftp:'), 'file:///x' (protocol 'file:')
// and even the scheme-less 'localhost:9000' (protocol 'localhost:', empty
// host). A WHATWG-valid URL is therefore not sufficient -- the protocol must
// be checked explicitly.
// ---------------------------------------------------------------------------

export interface BaseUrlSchemeError {
  /** The offending protocol (e.g. "ftp:"), or null when the string does not
   *  parse as a URL at all. */
  scheme: string | null;
  /** Human-readable message naming the offending scheme (or "not a valid
   *  URL") and the raw baseUrl -- safe to surface directly to the operator. */
  message: string;
}

/** Validate that `baseUrl` parses as a URL and uses the http: or https:
 *  scheme -- the only schemes the /ext proxy (src/console/proxy.ts) can
 *  hand to http.request. Returns null when valid, otherwise an error
 *  describing the offending scheme (or the parse failure). */
export function validateWorkflowPackageBaseUrlScheme(baseUrl: string): BaseUrlSchemeError | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { scheme: null, message: `baseUrl "${baseUrl}" is not a valid URL` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      scheme: parsed.protocol,
      message: `baseUrl "${baseUrl}" has unsupported scheme "${parsed.protocol}" (only http: and https: are supported)`,
    };
  }
  return null;
}

/** Loud, specific message for a config-declared entry with a bad scheme --
 *  used both for the console.error in refreshHealth() and the `configError`
 *  field in list(), so the two always agree. */
function describeConfigBaseUrlError(id: string, baseUrl: string): string | null {
  const err = validateWorkflowPackageBaseUrlScheme(baseUrl);
  if (!err) return null;
  return `workflow package "${id}" declared in config has an invalid baseUrl "${baseUrl}": ${err.message}`;
}

// ---------------------------------------------------------------------------
// Manifest validation -- ONE validator, shared by the register route (which
// turns a failure into 400 {error, field}) and by the registry-file reader
// (which drops a field it would refuse to accept today, so a hand-edited
// file can never feed the shell a path the route would have rejected).
//
// Every manifest path is a PATH ON THE PACKAGE'S OWN baseUrl. The three
// rejections below are each load-bearing:
//   - must start with '/': stops 'https://evil.example/x' and any other
//     absolute URL from being stored as a "path" and later concatenated
//     onto baseUrl or used as a nav/iframe target.
//   - no '//' prefix: '//evil.example/x' is a protocol-relative URL -- it
//     starts with '/' but resolves to a THIRD-PARTY ORIGIN in a browser.
//   - no '..' segment: stops a path from climbing out of the package's own
//     namespace on the upstream.
// ---------------------------------------------------------------------------

export interface ManifestFieldError {
  /** The offending field, e.g. 'health' or 'nav[2].path'. */
  field: string;
  /** Operator-safe description naming the field and what is wrong. */
  message: string;
}

export type ManifestParseResult =
  | { ok: true; manifest: WorkflowPackageManifest }
  | { ok: false; error: ManifestFieldError };

function validateManifestPath(value: unknown, field: string): ManifestFieldError | null {
  if (typeof value !== 'string' || value === '') {
    return { field, message: `${field} must be a non-empty string` };
  }
  if (!value.startsWith('/')) {
    return { field, message: `${field} must be a path starting with "/" (got "${value}")` };
  }
  if (value.startsWith('//')) {
    return { field, message: `${field} must not start with "//" (protocol-relative URLs resolve to another origin): "${value}"` };
  }
  if (value.includes('://')) {
    return { field, message: `${field} must be a path, not a URL with a scheme (got "${value}")` };
  }
  if (value.split('/').includes('..')) {
    return { field, message: `${field} must not contain a ".." segment (got "${value}")` };
  }
  return null;
}

function validateManifestLabel(value: unknown, field: string): ManifestFieldError | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return { field, message: `${field} must be a non-empty string` };
  }
  return null;
}

function validateManifestString(value: unknown, field: string): ManifestFieldError | null {
  if (typeof value !== 'string' || value === '') {
    return { field, message: `${field} must be a non-empty string` };
  }
  return null;
}

/**
 * Validate and extract the optional manifest fields from a raw body. Returns
 * the FIRST offending field rather than a list -- the register route answers
 * one `field` and the caller fixes them one at a time.
 *
 * Only known fields are carried through: an unknown key in the body is
 * ignored, never persisted.
 */
export function parseWorkflowPackageManifest(body: Record<string, unknown>): ManifestParseResult {
  const manifest: WorkflowPackageManifest = {};

  for (const field of ['name', 'process', 'version'] as const) {
    if (body[field] === undefined) continue;
    const err = validateManifestString(body[field], field);
    if (err) return { ok: false, error: err };
    manifest[field] = body[field] as string;
  }

  for (const field of ['health', 'ownerRefs'] as const) {
    if (body[field] === undefined) continue;
    const err = validateManifestPath(body[field], field);
    if (err) return { ok: false, error: err };
    manifest[field] = body[field] as string;
  }

  if (body.holds !== undefined) {
    const err = validateManifestPath(body.holds, 'holds');
    if (err) return { ok: false, error: err };
    const holds = body.holds as string;
    if (!holds.includes(HOLDS_ID_PLACEHOLDER)) {
      return {
        ok: false,
        error: { field: 'holds', message: `holds must contain the "${HOLDS_ID_PLACEHOLDER}" placeholder (got "${holds}")` },
      };
    }
    manifest.holds = holds;
  }

  if (body.nav !== undefined) {
    if (!Array.isArray(body.nav)) return { ok: false, error: { field: 'nav', message: 'nav must be an array' } };
    if (body.nav.length > MAX_MANIFEST_ARRAY_ENTRIES) {
      return { ok: false, error: { field: 'nav', message: `nav must have at most ${MAX_MANIFEST_ARRAY_ENTRIES} entries (got ${body.nav.length})` } };
    }
    const nav: WorkflowPackageNavEntry[] = [];
    for (let i = 0; i < body.nav.length; i += 1) {
      const raw = body.nav[i] as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { field: `nav[${i}]`, message: `nav[${i}] must be an object` } };
      }
      const labelErr = validateManifestLabel(raw.label, `nav[${i}].label`);
      if (labelErr) return { ok: false, error: labelErr };
      const pathErr = validateManifestPath(raw.path, `nav[${i}].path`);
      if (pathErr) return { ok: false, error: pathErr };
      const entry: WorkflowPackageNavEntry = { label: raw.label as string, path: raw.path as string };
      if (raw.scope !== undefined) {
        if (raw.scope !== 'project') {
          return {
            ok: false,
            error: { field: `nav[${i}].scope`, message: `nav[${i}].scope must be absent or "project" (got ${JSON.stringify(raw.scope)})` },
          };
        }
        entry.scope = 'project';
      }
      nav.push(entry);
    }
    manifest.nav = nav;
  }

  if (body.panels !== undefined) {
    if (!Array.isArray(body.panels)) return { ok: false, error: { field: 'panels', message: 'panels must be an array' } };
    if (body.panels.length > MAX_MANIFEST_ARRAY_ENTRIES) {
      return { ok: false, error: { field: 'panels', message: `panels must have at most ${MAX_MANIFEST_ARRAY_ENTRIES} entries (got ${body.panels.length})` } };
    }
    const panels: WorkflowPackagePanelEntry[] = [];
    for (let i = 0; i < body.panels.length; i += 1) {
      const raw = body.panels[i] as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { field: `panels[${i}]`, message: `panels[${i}] must be an object` } };
      }
      const slotErr = validateManifestLabel(raw.slot, `panels[${i}].slot`);
      if (slotErr) return { ok: false, error: slotErr };
      const pathErr = validateManifestPath(raw.path, `panels[${i}].path`);
      if (pathErr) return { ok: false, error: pathErr };
      panels.push({ slot: raw.slot as string, path: raw.path as string });
    }
    manifest.panels = panels;
  }

  return { ok: true, manifest };
}

// ---------------------------------------------------------------------------
// Registry storage + health polling
// ---------------------------------------------------------------------------

/** A package failing its health probe for this long (simulated or real
 *  wall-clock time, via the injected clock) reports as offline. */
export const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;

/** Health path used when a package's manifest declares none. */
export const DEFAULT_HEALTH_PATH = '/health';

/** Per-entry cap on every manifest array (nav, panels). A manifest is a
 *  navigation hint, not a bulk data channel -- an unbounded array would let
 *  one register call inflate the registry file (and the shell's nav) without
 *  limit. */
export const MAX_MANIFEST_ARRAY_ENTRIES = 32;

/** Short timeout for a holds/owner-ref consult. These run inside request
 *  paths that must answer promptly, so a wedged package degrades to an
 *  `error` entry rather than hanging the caller. */
export const CONSULT_TIMEOUT_MS = 3000;

/** Placeholder a `holds` path must contain; replaced with the URL-encoded
 *  member id at consult time. */
export const HOLDS_ID_PLACEHOLDER = ':id';

/**
 * Reserved workflow-package id (apra-fleet-g6ap.8). The fleet's own
 * built-in `reservedBy` hold reports itself in a `member_owner`/
 * `remove_member` `heldBy` entry's `package` field using this exact
 * sentinel (src/tools/member-owner.ts imports and re-exports this
 * constant as FLEET_RESERVATION_PACKAGE so both modules share one
 * literal). register() below rejects any REGISTERED package trying to
 * claim this id (reason `reserved-id`, surfaced as HTTP 400 by
 * src/console/routes/workflow-packages.ts), so a `heldBy` entry naming
 * this package is unambiguously the built-in reservation, never a
 * workflow package's own report.
 *
 * Before this fix, nothing enforced that: a package registering with id
 * "fleet" would produce a `heldBy` entry indistinguishable BY PACKAGE from
 * the built-in reservation -- only the free-form `reason` field told them
 * apart (`'reservation'` for the sentinel vs. whatever text the package
 * itself reported), which a consumer keying off `package` alone could
 * mis-attribute. The impact was cosmetic mis-attribution only (the refusal
 * itself always happened either way), but the OLD doc comment here claimed
 * the collision "can never" happen -- untrue, since workflow-package ids
 * are validated only as non-empty strings at registration (never against
 * OWNER_PACKAGE_PATTERN, despite what that comment also claimed; that
 * pattern governs member_owner's own `package` field, a separate
 * validation path this module never called).
 *
 * Config-declared packages (getConfigPackages(), never routed through
 * register()) are NOT checked here -- an operator hand-editing config to
 * declare "fleet" is a misconfiguration outside this HTTP-registration
 * guard's reach, same as every other config-declared validation gap in
 * this file. */
export const FLEET_RESERVATION_PACKAGE = 'fleet';

const REGISTRY_VERSION = 1;

/** The only non-default nav scope. `scope` absent means a global nav entry;
 *  'project' means the entry belongs under a project. */
export type WorkflowPackageNavScope = 'project';

export interface WorkflowPackageNavEntry {
  label: string;
  path: string;
  scope?: WorkflowPackageNavScope;
}

export interface WorkflowPackagePanelEntry {
  slot: string;
  path: string;
}

/**
 * The OPTIONAL manifest a package may present at registration on top of the
 * required id/baseUrl/apraFleetApi triple. Every path here is a path on the
 * package's own baseUrl -- never a scheme/host -- so nothing in a manifest can
 * redirect the console at a third-party origin.
 */
export interface WorkflowPackageManifest {
  name?: string;
  process?: string;
  version?: string;
  /** Health-probe path; DEFAULT_HEALTH_PATH when absent. */
  health?: string;
  nav?: WorkflowPackageNavEntry[];
  panels?: WorkflowPackagePanelEntry[];
  /** Path answering `{ refs: [{ id, name }] }`. */
  ownerRefs?: string;
  /** Path containing HOLDS_ID_PLACEHOLDER, answering `{ held, reason? }`. */
  holds?: string;
}

export interface RegisteredPackageInput extends WorkflowPackageManifest {
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
  // --- manifest fields -------------------------------------------------
  // Always PRESENT, null/[] when the package declared nothing, so a caller
  // never has to distinguish "absent key" from "declared nothing". A
  // config-declared entry carries no manifest at all and is therefore
  // always null/[] here.
  name: string | null;
  version: string | null;
  /** The DECLARED health path, or null. The probe's effective path falls
   *  back to DEFAULT_HEALTH_PATH -- this field reports what was declared,
   *  not what was probed. */
  health: string | null;
  nav: WorkflowPackageNavEntry[];
  panels: WorkflowPackagePanelEntry[];
  ownerRefs: string | null;
  holds: string | null;
  /** Non-null only for a config-declared entry whose baseUrl fails the
   *  http(s) scheme check -- an operator misconfiguration, not a transient
   *  outage. Deliberately distinct from `offline` (which this also forces
   *  true, since the entry is unusable either way) so the two cases never
   *  read the same to a caller: a genuinely unreachable http:// package
   *  always has `configError: null`. A registered package can never carry a
   *  non-null configError -- the register route rejects a bad scheme before
   *  the entry is ever persisted. */
  configError: string | null;
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: 'incompatible'; message: string }
  | { ok: false; reason: 'invalid-range'; message: string }
  | { ok: false; reason: 'reserved-id'; message: string };

export type UnregisterResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'config-declared' };

/** One package's answer to "do you hold this member?". Exactly one of a
 *  successful verdict (`held`, optional `reason`) or `error` is meaningful:
 *  `error` set means the package could not be consulted at all, and `held`
 *  is false only because nothing is known -- NEVER read a false `held`
 *  alongside an `error` as "this package does not hold the member". */
export interface HoldConsultResult {
  packageId: string;
  held: boolean;
  reason?: string;
  error?: string;
}

export type OwnerRefCheckResult = { known: boolean } | { error: string };

export interface WorkflowPackageServiceDeps {
  filePath?: string;
  fs?: Pick<typeof fs, 'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync'>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  getServerVersion?: () => string;
  getConfigPackages?: () => WorkflowPackageConfigEntry[];
  /** Source of the shared fleet key the per-package credential is derived
   *  from. Injected so tests never mint or read the real fleet.key. */
  getFleetKey?: () => string;
  /** Overrides CONSULT_TIMEOUT_MS for holds/owner-ref consults. */
  consultTimeoutMs?: number;
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
  /**
   * Ask every non-offline package that declares a `holds` path whether it
   * holds `memberId`. Packages that declare no `holds`, and packages already
   * known offline, are SKIPPED (absent from the result) rather than reported
   * as "not held" -- silence from a package that was never asked must never
   * read as consent. Never throws: a network/HTTP failure comes back as an
   * `error` entry for that package.
   */
  consultHolds(memberId: string): Promise<HoldConsultResult[]>;
  /**
   * Ask one package whether `ref` is a known owner reference. Never throws:
   * an unknown package, a package declaring no `ownerRefs` path, and a
   * network/HTTP failure all come back as `{ error }` -- never as
   * `{ known: false }`, which would wrongly read as a definitive answer.
   */
  checkOwnerRef(packageId: string, ref: string): Promise<OwnerRefCheckResult>;
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
  const getFleetKey = deps.getFleetKey ?? getOrCreateKey;
  const consultTimeoutMs = deps.consultTimeoutMs ?? CONSULT_TIMEOUT_MS;

  /** Request init for any call this service makes TO a package: the derived,
   *  per-package credential (never the raw fleet key) plus a short timeout so
   *  a wedged upstream cannot hold a request path open. Resolved lazily --
   *  the fleet key is read only when a call is actually made. */
  function upstreamRequestInit(id: string): RequestInit {
    return {
      headers: { authorization: `Bearer ${deriveUpstreamCredential(getFleetKey(), id)}` },
      signal: AbortSignal.timeout(consultTimeoutMs),
    };
  }

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
            // BACKWARD COMPATIBILITY: a registry file written before the
            // manifest fields existed has none of them, and parses to an
            // empty manifest -- the entry still loads and still lists.
            //
            // Re-validating on READ (not just on write) means a hand-edited
            // or downgraded-then-upgraded file can never feed the shell a
            // path the register route would reject today. A file whose
            // manifest does not validate loses its manifest, not its entry:
            // the package stays registered and reachable, it just declares
            // nothing until it re-registers (which the supervisor does on
            // every start).
            const parsedManifest = parseWorkflowPackageManifest(p as unknown as Record<string, unknown>);
            next.set(p.id, {
              id: p.id,
              baseUrl: p.baseUrl,
              apraFleetApi: p.apraFleetApi,
              registeredAt: typeof p.registeredAt === 'number' ? p.registeredAt : now(),
              ...(parsedManifest.ok ? parsedManifest.manifest : {}),
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
    // apra-fleet-g6ap.8: reject before anything else so a reserved id is
    // never persisted, even transiently, ahead of the version-range check.
    if (input.id === FLEET_RESERVATION_PACKAGE) {
      return {
        ok: false,
        reason: 'reserved-id',
        message: `Package id "${FLEET_RESERVATION_PACKAGE}" is reserved for the fleet's own built-in reservedBy hold and cannot be registered.`,
      };
    }

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
    // Re-registering the same id REPLACES the record outright (the
    // supervisor re-registers on every start) -- never a merge, so a field
    // dropped from the manifest actually disappears instead of lingering
    // from the previous registration.
    const { id, baseUrl, apraFleetApi, ...manifest } = input;
    map.set(id, { id, baseUrl, apraFleetApi, ...manifest, registeredAt: now() });
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

  async function probeOne(id: string, baseUrl: string, healthPath: string): Promise<void> {
    const rec = healthRecordFor(id);
    const checkedAt = now();
    try {
      // The probe carries the package's derived credential, so a package
      // whose health route is GUARDED answers 200 instead of 401. A 401 is
      // therefore a genuine probe FAILURE (wrong/missing credential), not a
      // "the package is up but shy" success -- it falls into the !res.ok
      // branch below like any other non-2xx.
      const res = await fetchFn(`${baseUrl}${healthPath}`, upstreamRequestInit(id));
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
    // Config-declared entries carry no manifest, so they always probe
    // DEFAULT_HEALTH_PATH; a registered package probes whatever its manifest
    // declared, falling back to the same default.
    const targets = new Map<string, { baseUrl: string; healthPath: string }>();
    for (const c of getConfigPackages()) targets.set(c.id, { baseUrl: c.baseUrl, healthPath: DEFAULT_HEALTH_PATH });
    for (const p of map.values()) {
      if (!targets.has(p.id)) targets.set(p.id, { baseUrl: p.baseUrl, healthPath: p.health ?? DEFAULT_HEALTH_PATH });
    }

    const probes: Promise<void>[] = [];
    for (const [id, target] of targets) {
      const { baseUrl, healthPath } = target;
      // A misconfigured scheme is an operator error, not a transient
      // outage -- log it loudly and never hand it to probeOne. Letting it
      // reach fetch() would just fail (differently across platforms) and
      // age into the same "offline after 10 minutes" bucket as a real
      // outage, which is exactly the silent-misconfiguration-looks-like-a-
      // blip shape this task exists to remove.
      const configError = describeConfigBaseUrlError(id, baseUrl);
      if (configError) {
        console.error(`[fleet] ${configError}`);
        continue;
      }
      probes.push(probeOne(id, baseUrl, healthPath));
    }
    await Promise.all(probes);
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
      const configError = describeConfigBaseUrlError(c.id, c.baseUrl);
      out.push({
        id: c.id,
        baseUrl: c.baseUrl,
        apraFleetApi: null,
        configDeclared: true,
        // A scheme error makes the package unusable regardless of what (if
        // anything) the health poll recorded for it -- never let a probe
        // that happened to run before this call's config changed leave a
        // stale `offline: false` for an entry that can never be reached.
        offline: configError !== null ? true : isOffline(c.id),
        lastCheckedAt: rec?.lastCheckedAt ?? null,
        configError,
        // A config-declared entry is just an id + baseUrl in config.json --
        // it never presents a manifest, so every manifest field is empty.
        name: null,
        version: null,
        health: null,
        nav: [],
        panels: [],
        ownerRefs: null,
        holds: null,
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
        configError: null,
        // Normalised to null/[] so a caller never distinguishes an absent
        // key (legacy registry file) from a declared-nothing manifest.
        name: p.name ?? null,
        version: p.version ?? null,
        health: p.health ?? null,
        nav: p.nav ?? [],
        panels: p.panels ?? [],
        ownerRefs: p.ownerRefs ?? null,
        holds: p.holds ?? null,
      });
    }
    return out;
  }

  /** Parse a JSON body defensively: a package answering non-JSON (an HTML
   *  error page, say) must read as a consult failure, never as a verdict. */
  async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') throw new Error('response body was not a JSON object');
    return body as Record<string, unknown>;
  }

  function describeConsultError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  async function consultHolds(memberId: string): Promise<HoldConsultResult[]> {
    const targets = list().filter((p) => !p.offline && typeof p.holds === 'string' && p.holds !== '');
    return Promise.all(
      targets.map(async (pkg): Promise<HoldConsultResult> => {
        try {
          // URL-encode the member id into the ':id' placeholder -- an id
          // containing '/' or '?' would otherwise change the path shape or
          // inject a query string onto the package's own URL. This stays
          // INSIDE the try: encodeURIComponent throws URIError on a lone
          // surrogate (JSON.parse('"\\ud800"') yields exactly that), and a
          // malformed id must degrade to this package's error entry like any
          // other failure -- consultHolds must never reject.
          const holdsPath = (pkg.holds as string).split(HOLDS_ID_PLACEHOLDER).join(encodeURIComponent(memberId));
          const res = await fetchFn(`${pkg.baseUrl}${holdsPath}`, upstreamRequestInit(pkg.id));
          if (!res || !res.ok) {
            throw new Error(`non-ok holds response (${res ? res.status : 'no response'})`);
          }
          const body = await readJsonBody(res);
          return {
            packageId: pkg.id,
            held: body.held === true,
            ...(typeof body.reason === 'string' && body.reason !== '' ? { reason: body.reason } : {}),
          };
        } catch (err) {
          // Fail-soft, but NEVER fail-silent: held stays false only because
          // nothing is known, and `error` is what says so.
          return { packageId: pkg.id, held: false, error: describeConsultError(err) };
        }
      }),
    );
  }

  async function checkOwnerRef(packageId: string, ref: string): Promise<OwnerRefCheckResult> {
    const pkg = list().find((p) => p.id === packageId);
    if (!pkg) return { error: `workflow package "${packageId}" is not registered` };
    if (typeof pkg.ownerRefs !== 'string' || pkg.ownerRefs === '') {
      return { error: `workflow package "${packageId}" declares no ownerRefs path` };
    }
    try {
      const res = await fetchFn(`${pkg.baseUrl}${pkg.ownerRefs}`, upstreamRequestInit(pkg.id));
      if (!res || !res.ok) {
        throw new Error(`non-ok ownerRefs response (${res ? res.status : 'no response'})`);
      }
      const body = await readJsonBody(res);
      if (!Array.isArray(body.refs)) throw new Error('ownerRefs response did not carry a refs array');
      const known = body.refs.some((entry) => Boolean(entry) && typeof entry === 'object' && (entry as { id?: unknown }).id === ref);
      return { known };
    } catch (err) {
      return { error: describeConsultError(err) };
    }
  }

  return { filePath, register, unregister, refreshHealth, list, consultHolds, checkOwnerRef };
}

/** Process-wide singleton used by the console routes (apra-fleet-iywi.3.2). */
export const workflowPackageService: WorkflowPackageService = createWorkflowPackageService();
