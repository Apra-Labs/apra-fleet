import { useEffect, useState } from "react";
import { Members } from "./pages/Members";
import { Secrets } from "./pages/Secrets";
import { Health } from "./pages/Health";
import { Nav, resolveScreen, type Screen } from "./nav/Nav";

/**
 * Root of the shell SPA. Hash-based navigation across the three screens
 * (S1 Members -- the default, S2 Secrets, S3 Health) -- no router
 * dependency (apra-fleet-9h9j.3.2). The active screen resolves from
 * window.location.hash on first render, so a full page load at a deep
 * link (e.g. /ui/#/health) lands directly on that screen rather than
 * falling back to Members.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>(() => resolveScreen(window.location.hash));

  useEffect(() => {
    function onHashChange() {
      setScreen(resolveScreen(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div>
      <Nav active={screen} />
      {screen === "members" ? <Members /> : null}
      {screen === "secrets" ? <Secrets /> : null}
      {screen === "health" ? <Health /> : null}
    </div>
  );
}
