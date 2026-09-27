import { useCallback, useEffect, useState } from "react";
import { Members } from "./pages/Members";
import { Secrets } from "./pages/Secrets";
import { Health } from "./pages/Health";
import { Ext } from "./pages/Ext";
import { Nav, resolveScreen, screenKey, type Screen } from "./nav/Nav";
import { ErrorBoundary } from "./ErrorBoundary";
import { fetchWorkflowPackages, type WorkflowPackageView } from "./api/workflow-packages";

/** How often the registry is re-read while the tab is visible. The registry
 *  is also re-read immediately whenever the tab becomes visible again, so a
 *  backgrounded tab costs nothing and still shows fresh health on return. */
export const PACKAGE_POLL_MS = 30_000;

/**
 * Root of the shell SPA. Hash-based navigation across the three static
 * screens (S1 Members -- the default, S2 Secrets, S3 Health) plus one iframe
 * screen per registered workflow package at #/ext/<id><path> -- no router
 * dependency (apra-fleet-9h9j.3.2). The active screen resolves from
 * window.location.hash on first render, so a full page load at a deep
 * link (e.g. /ui/#/health) lands directly on that screen rather than
 * falling back to Members.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>(() => resolveScreen(window.location.hash));
  const [packages, setPackages] = useState<WorkflowPackageView[]>([]);
  const [project, setProject] = useState<string | null>(null);

  useEffect(() => {
    function onHashChange() {
      setScreen(resolveScreen(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // An absent or unreachable registry reads as "no packages": the shell
      // then renders its static nav alone rather than an error.
      const { packages: list } = await fetchWorkflowPackages();
      if (!cancelled) setPackages(list);
    }

    function loadIfVisible() {
      if (document.visibilityState === "visible") void load();
    }

    void load();
    const timer = window.setInterval(loadIfVisible, PACKAGE_POLL_MS);
    document.addEventListener("visibilitychange", loadIfVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", loadIfVisible);
    };
  }, []);

  const onContext = useCallback((next: string | null) => setProject(next), []);

  const activeView =
    screen.kind === "ext" ? packages.find((p) => p.id === screen.packageId) : undefined;

  return (
    <div>
      <Nav active={screen} packages={packages} project={project} />
      <ErrorBoundary key={screenKey(screen)}>
        {screen.kind === "members" ? <Members /> : null}
        {screen.kind === "secrets" ? <Secrets /> : null}
        {screen.kind === "health" ? <Health /> : null}
        {screen.kind === "ext" ? (
          <Ext packageId={screen.packageId} path={screen.path} view={activeView} onContext={onContext} />
        ) : null}
      </ErrorBoundary>
    </div>
  );
}
