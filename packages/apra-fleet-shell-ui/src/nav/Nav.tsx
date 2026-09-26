import {
  extHash,
  isPackageOffline,
  type WorkflowPackageNavEntry,
  type WorkflowPackageView
} from "../api/workflow-packages";

export type StaticScreen = "members" | "secrets" | "health";

/** The active screen. The three static screens carry no parameters; an
 *  `ext` screen names the workflow package and the path INSIDE that package
 *  (e.g. packageId "se", path "/ui/projects"). */
export type Screen =
  | { kind: StaticScreen }
  | { kind: "ext"; packageId: string; path: string };

export interface NavItem {
  screen: StaticScreen;
  label: string;
  hash: string;
}

export const NAV_ITEMS: NavItem[] = [
  { screen: "members", label: "Members", hash: "#/members" },
  { screen: "secrets", label: "Secrets", hash: "#/secrets" },
  { screen: "health", label: "Health", hash: "#/health" }
];

const SCREEN_FROM_HASH: Record<string, StaticScreen> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.hash, item.screen])
) as Record<string, StaticScreen>;

/** "#/ext/<id>" optionally followed by the in-package path. The id segment
 *  stops at the first "/", so every remaining character (including further
 *  slashes and a query string) belongs to the package path. */
const EXT_HASH_RE = /^#\/ext\/([^/]+)(\/.*)?$/;

/** Members is the shell's default screen -- an empty, unknown, or missing
 *  hash (including a bare "/ui" load) resolves to it. A "#/ext/<id><path>"
 *  hash resolves to that package's iframe page. */
export function resolveScreen(hash: string): Screen {
  const ext = EXT_HASH_RE.exec(hash);
  if (ext) {
    const packageId = safeDecode(ext[1]);
    if (packageId) return { kind: "ext", packageId, path: ext[2] ?? "" };
  }
  return { kind: SCREEN_FROM_HASH[hash] ?? "members" };
}

/** A malformed percent-escape must not throw out of routing -- an unknown
 *  hash falls back to Members like any other. */
function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Remount key for the screen's error boundary. Deliberately does NOT include
 *  an ext screen's path: remounting on every deep-link change would reload
 *  the package iframe on each in-package navigation, which is exactly what
 *  the postMessage mirroring exists to avoid. */
export function screenKey(screen: Screen): string {
  return screen.kind === "ext" ? `ext:${screen.packageId}` : screen.kind;
}

interface NavProps {
  active: Screen;
  /** Registered packages, already fetched by the shell. Defaults to none so
   *  the static nav renders unchanged when the registry is absent. */
  packages?: WorkflowPackageView[];
  /** Current project context, as reported by a package iframe. Null means no
   *  project is known, which hides every project-scoped entry. */
  project?: string | null;
}

const LINK_STYLE = { display: "inline-flex", alignItems: "center", gap: "6px" } as const;
const OFFLINE_STYLE = { ...LINK_STYLE, color: "#888", cursor: "not-allowed" } as const;
const CHIP_STYLE = {
  fontSize: "11px",
  textTransform: "uppercase",
  border: "1px solid currentColor",
  borderRadius: "999px",
  padding: "0 6px"
} as const;

/** Hash-only navigation: plain anchors, no router dependency. A full page
 *  load at e.g. /ui/#/health resolves directly to Health via
 *  resolveScreen(window.location.hash) in App's initial state -- the
 *  server always answers /ui/* with the same index.html regardless of the
 *  fragment, so this never depends on server-side routing.
 *
 *  After the three static screens come the registry-driven entries: one per
 *  nav item each registered package declared in its manifest. */
export function Nav({ active, packages = [], project = null }: NavProps) {
  const packageEntries = visibleNavEntries(packages, project);

  return (
    <nav aria-label="Screens" style={{ display: "flex", gap: "16px", padding: "12px 24px", flexWrap: "wrap" }}>
      {NAV_ITEMS.map((item) => (
        <a
          key={item.screen}
          href={item.hash}
          aria-current={active.kind === item.screen ? "page" : undefined}
        >
          {item.label}
        </a>
      ))}

      {packageEntries.map(({ view, entry, offline }) => {
        const hash = extHash(view.id, entry.path);
        const key = `${view.id}:${entry.path}`;
        if (offline) {
          // No href at all: a disabled entry must not be activatable by
          // click, by keyboard, or by middle-click "open in new tab".
          return (
            <a key={key} aria-disabled="true" title={view.configError ?? "package offline"} style={OFFLINE_STYLE}>
              {entry.label}
              <span style={CHIP_STYLE}>offline</span>
            </a>
          );
        }
        return (
          <a
            key={key}
            href={hash}
            aria-current={
              active.kind === "ext" && active.packageId === view.id && active.path === entry.path ? "page" : undefined
            }
            style={LINK_STYLE}
          >
            {entry.label}
          </a>
        );
      })}
    </nav>
  );
}

interface ResolvedNavEntry {
  view: WorkflowPackageView;
  entry: WorkflowPackageNavEntry;
  offline: boolean;
}

/** Flattens the registry into renderable nav entries, dropping project-scoped
 *  entries while no project context is known. Exported for the nav tests and
 *  for any future consumer that needs the same visibility rule. */
export function visibleNavEntries(
  packages: WorkflowPackageView[],
  project: string | null
): ResolvedNavEntry[] {
  const out: ResolvedNavEntry[] = [];
  for (const view of packages) {
    const offline = isPackageOffline(view);
    for (const entry of view.nav ?? []) {
      if (entry.scope === "project" && !project) continue;
      out.push({ view, entry, offline });
    }
  }
  return out;
}
