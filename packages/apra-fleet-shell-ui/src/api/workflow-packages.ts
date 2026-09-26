// Thin fetch wrapper over the workflow-package registry (GET
// /api/workflow-packages), plus the view types the shell renders from.
//
// The types below MIRROR src/services/workflow-packages.ts
// (WorkflowPackageView and friends) -- the shell-ui package has no build-time
// dependency on the server package, so the shape is restated here once and
// only here. Every other shell module imports it from this file rather than
// re-declaring it.
//
// Paths inside a manifest (nav[].path, panels[].path) are always paths on the
// package's own baseUrl, never a scheme/host: the server validates that at
// registration time, so the shell can concatenate them onto /ext/<id> without
// risking an off-origin navigation.

/** The only non-default nav scope. `scope` absent means a global nav entry;
 *  'project' means the entry only makes sense inside a project context. */
export type WorkflowPackageNavScope = "project";

export interface WorkflowPackageNavEntry {
  label: string;
  path: string;
  scope?: WorkflowPackageNavScope;
}

export interface WorkflowPackagePanelEntry {
  slot: string;
  path: string;
}

/** Mirrors WorkflowPackageView in src/services/workflow-packages.ts. The
 *  manifest fields are always PRESENT (null/[] when the package declared
 *  nothing), so no caller has to distinguish "absent key" from "declared
 *  nothing". */
export interface WorkflowPackageView {
  id: string;
  baseUrl: string;
  /** null for config-declared entries -- they carry no recorded range. */
  apraFleetApi: string | null;
  configDeclared: boolean;
  offline: boolean;
  lastCheckedAt: number | null;
  name: string | null;
  version: string | null;
  health: string | null;
  nav: WorkflowPackageNavEntry[];
  panels: WorkflowPackagePanelEntry[];
  ownerRefs: string | null;
  holds: string | null;
  /** Operator misconfiguration of a config-declared entry (e.g. a non-http
   *  baseUrl). Distinct from `offline`, which is a transient outage, though
   *  a configError forces offline true as well since the entry is unusable
   *  either way. */
  configError: string | null;
}

export interface WorkflowPackagesResult {
  packages: WorkflowPackageView[];
  /** True when the registry could not be read at all (404, non-2xx, network
   *  failure, unparseable body). Callers that render a list treat this the
   *  same as an empty registry -- see the empty-state contract on the Health
   *  page -- but it is surfaced so a caller that needs to tell "no packages"
   *  from "could not ask" can. */
  error: boolean;
}

/** A registry that is absent (404) or unreachable is the EXPECTED "no
 *  workflow packages" case, not an error to render: a fleet server with no
 *  package ever registered still answers 404 here. Hence [] plus the flag,
 *  never a throw. */
export async function fetchWorkflowPackages(): Promise<WorkflowPackagesResult> {
  let response: Response;
  try {
    response = await fetch("/api/workflow-packages");
  } catch {
    return { packages: [], error: true };
  }
  if (!response.ok) return { packages: [], error: true };
  try {
    const data = (await response.json()) as { packages?: unknown };
    if (!Array.isArray(data.packages)) return { packages: [], error: true };
    return { packages: data.packages.filter(isWorkflowPackageView), error: false };
  } catch {
    return { packages: [], error: true };
  }
}

/** Defensive narrowing at the network boundary: the registry is the server's
 *  to shape, but a shell that trusted it blindly would crash the whole nav on
 *  one malformed entry. Only `id` is load-bearing enough to require; the
 *  optional manifest fields are normalized by the reader helpers below. */
function isWorkflowPackageView(entry: unknown): entry is WorkflowPackageView {
  return typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string";
}

/** A package is unusable when its health probe has been failing past the
 *  registry's offline threshold OR when it is misconfigured outright. The
 *  shell greys both the same way -- the distinction matters to the operator
 *  reading the message, not to the nav. */
export function isPackageOffline(view: WorkflowPackageView): boolean {
  return view.offline === true || (view.configError ?? null) !== null;
}

/** Human label for a package: its manifest name when it declared one, else
 *  its registered id. */
export function packageLabel(view: WorkflowPackageView): string {
  return view.name && view.name.trim() ? view.name : view.id;
}

/** The shell-side hash for a package path, e.g. ("se", "/ui/projects") ->
 *  "#/ext/se/ui/projects". The id is encoded because it lands in a URL
 *  segment; the manifest path is already server-validated as a path. */
export function extHash(packageId: string, path: string): string {
  return `#/ext/${encodeURIComponent(packageId)}${path}`;
}

/** The same-origin iframe URL the console proxy serves for a package path.
 *  Same origin is the point: the console cookie rides along, so the package
 *  UI is authenticated without a second credential. */
export function extSrc(packageId: string, path: string): string {
  return `/ext/${encodeURIComponent(packageId)}${path}`;
}
