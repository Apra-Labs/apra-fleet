export type Screen = "members" | "secrets" | "health";

export interface NavItem {
  screen: Screen;
  label: string;
  hash: string;
}

export const NAV_ITEMS: NavItem[] = [
  { screen: "members", label: "Members", hash: "#/members" },
  { screen: "secrets", label: "Secrets", hash: "#/secrets" },
  { screen: "health", label: "Health", hash: "#/health" }
];

const SCREEN_FROM_HASH: Record<string, Screen> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.hash, item.screen])
) as Record<string, Screen>;

/** Members is the shell's default screen -- an empty, unknown, or missing
 *  hash (including a bare "/ui" load) resolves to it. */
export function resolveScreen(hash: string): Screen {
  return SCREEN_FROM_HASH[hash] ?? "members";
}

interface NavProps {
  active: Screen;
}

/** Hash-only navigation: plain anchors, no router dependency. A full page
 *  load at e.g. /ui/#/health resolves directly to Health via
 *  resolveScreen(window.location.hash) in App's initial state -- the
 *  server always answers /ui/* with the same index.html regardless of the
 *  fragment, so this never depends on server-side routing. */
export function Nav({ active }: NavProps) {
  return (
    <nav aria-label="Screens" style={{ display: "flex", gap: "16px", padding: "12px 24px" }}>
      {NAV_ITEMS.map((item) => (
        <a key={item.screen} href={item.hash} aria-current={active === item.screen ? "page" : undefined}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
