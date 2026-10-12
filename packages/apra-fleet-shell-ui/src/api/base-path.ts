// Single source of the console mount prefix every shell API/ext URL is
// resolved against. The shell is served at "<prefix>/ui/"; the console's
// /api/ and /ext/ routes live at "<prefix>/api/" and "<prefix>/ext/". The
// prefix is empty at the site root (shell at /ui) and e.g. "/fleet" when a
// reverse proxy mounts the console under /fleet/.

/** The path prefix before the "/ui" segment of the page the shell is served
 *  from ("" at the site root). Derived at call time from window.location so
 *  the same bundle works at any mount point. */
export function consoleBasePath(): string {
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const match = /^(.*?)\/ui(?:\/|$)/.exec(pathname);
  return match ? match[1] : "";
}

/** Resolve a console-relative path ("/api/..." or "/ext/...") against the
 *  mount prefix. Every fetch in the shell goes through this. */
export function apiUrl(path: string): string {
  return `${consoleBasePath()}${path}`;
}
