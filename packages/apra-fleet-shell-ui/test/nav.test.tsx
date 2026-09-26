import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import type { WorkflowPackageView } from "../src/api/workflow-packages";

// Registry-driven shell nav and the workflow-package iframe page (DQ-18 v1).
// Renders through react-dom/client + React's own act (React 18.3+), matching
// the rest of this suite -- @testing-library/react is not a repo dependency
// and this lane must not add one just to assert on markup.
//
// The package id "se" appears only in these FIXTURES: the shell itself must
// contain no package-id literal, since every package behaviour comes from the
// registry.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE_PACKAGE: WorkflowPackageView = {
  id: "se",
  baseUrl: "http://127.0.0.1:7601",
  apraFleetApi: "^0.5.0",
  configDeclared: false,
  offline: false,
  lastCheckedAt: 1_700_000_000_000,
  name: "Fleet Supervisor",
  version: "0.5.0",
  health: "/api/health",
  nav: [
    { label: "Projects", path: "/ui/projects" },
    // (apra-fleet-i9ag.5.3) Unscoped, matching the real manifest
    // (src/registration/manifest.mjs's Sprints entry, apra-fleet-i9ag.3.3):
    // the Sprints dashboard has no project-context dependency, so it must
    // render in the header with no project selected. A fixture that put
    // scope:"project" back here would silently hide the regression this
    // suite exists to catch.
    { label: "Sprints", path: "/ui/sprints" },
    { label: "KB", path: "/ui/kb", scope: "project" },
    { label: "Code", path: "/ui/code", scope: "project" }
  ],
  panels: [],
  ownerRefs: "/api/owner-refs",
  holds: "/api/members/:id/holds",
  configError: null
};

const OFFLINE_PACKAGE: WorkflowPackageView = { ...BASE_PACKAGE, offline: true };
/** A misconfigured entry: `offline` is deliberately left false so the test
 *  proves the nav greys on configError in its own right, not incidentally
 *  because the server also forces offline true. */
const MISCONFIGURED_PACKAGE: WorkflowPackageView = {
  ...BASE_PACKAGE,
  offline: false,
  configError: "baseUrl must use http or https"
};

const STATUS_FIXTURE = {
  version: "apra-fleet 0.9.0",
  summary: { total: 1, online: 1, offline: 0 }
};

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/** `registry` null means the registry route 404s (no package ever
 *  registered), which is the shell's expected "static nav only" case. */
function makeFetchMock(registry: WorkflowPackageView[] | null) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/api/workflow-packages") {
      return registry === null ? jsonResponse(404, {}) : jsonResponse(200, { packages: registry });
    }
    if (url === "/api/fleet/members") return jsonResponse(200, { members: [] });
    if (url === "/api/fleet/credential-store-list") return jsonResponse(200, { credentials: [] });
    if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
    return jsonResponse(200, {});
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  window.location.hash = "";
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

async function renderApp(registry: WorkflowPackageView[] | null, hash = "") {
  vi.stubGlobal("fetch", makeFetchMock(registry));
  window.location.hash = hash;
  await act(async () => {
    root.render(<App />);
  });
}

function navLinks(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll('nav[aria-label="Screens"] a'));
}

function navLabels(): string[] {
  // The offline chip is a child span of the anchor; strip it so a label
  // comparison stays about labels.
  return navLinks().map((a) => (a.firstChild?.textContent ?? a.textContent ?? "").trim());
}

function iframe(): HTMLIFrameElement | null {
  return container.querySelector("iframe");
}

/** Dispatches a window "message" as the hosted iframe would. Both the origin
 *  and the source window are overridable so the trust checks can be tested. */
async function postMessageToShell(
  data: unknown,
  opts: { origin?: string; source?: Window | null } = {}
) {
  const frame = iframe();
  const source = "source" in opts ? opts.source : frame?.contentWindow ?? null;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: opts.origin ?? window.location.origin,
        source: source as Window
      })
    );
  });
}

/** jsdom queues hashchange as a task rather than firing it synchronously on
 *  assignment, so tests drive it explicitly -- the same approach app.test.tsx
 *  already uses for the static screens. */
async function flushHashChange() {
  await act(async () => {
    window.dispatchEvent(new Event("hashchange"));
  });
}

describe("Registry-driven nav (DQ-18)", () => {
  it("case 1: renders the static screens plus a package nav entry from the registry", async () => {
    await renderApp([BASE_PACKAGE]);

    // (apra-fleet-i9ag.5.3) `project` is still null here (renderApp posts no
    // context message) -- an unscoped Sprints entry must render anyway. Today's
    // fixture declaring scope:'project' is exactly the case that hid it.
    expect(navLabels()).toEqual(["Members", "Secrets", "Health", "Projects", "Sprints"]);

    const projects = navLinks().find((a) => a.textContent?.includes("Projects"));
    expect(projects?.getAttribute("href")).toBe("#/ext/se/ui/projects");

    const sprints = navLinks().find((a) => a.textContent === "Sprints");
    expect(sprints?.getAttribute("href")).toBe("#/ext/se/ui/sprints");
  });

  it("case 2: hides project-scoped entries until a context message arrives, and again on project null", async () => {
    await renderApp([BASE_PACKAGE], "#/ext/se/ui/projects");

    // No project context yet -- the unscoped package entries (Projects,
    // Sprints) show; the project-scoped ones (KB, Code) do not.
    expect(navLabels()).toEqual(["Members", "Secrets", "Health", "Projects", "Sprints"]);

    await postMessageToShell({ type: "apra-fleet:context", project: "p1" });
    expect(navLabels()).toEqual(["Members", "Secrets", "Health", "Projects", "Sprints", "KB", "Code"]);
    const kb = navLinks().find((a) => a.textContent === "KB");
    expect(kb?.getAttribute("href")).toBe("#/ext/se/ui/kb");

    await postMessageToShell({ type: "apra-fleet:context", project: null });
    expect(navLabels()).toEqual(["Members", "Secrets", "Health", "Projects", "Sprints"]);
  });

  it("case 3: an offline package renders greyed, disabled entries with an offline chip", async () => {
    await renderApp([OFFLINE_PACKAGE]);

    const projects = navLinks().find((a) => a.textContent?.includes("Projects"));
    expect(projects).toBeDefined();
    expect(projects!.hasAttribute("href")).toBe(false);
    expect(projects!.getAttribute("aria-disabled")).toBe("true");
    expect(projects!.textContent).toContain("offline");
    // Greyed, not merely labelled: the anchor carries an explicit colour.
    expect(projects!.style.color).not.toBe("");
  });

  it("case 3b: a configError package is treated exactly like an offline one", async () => {
    await renderApp([MISCONFIGURED_PACKAGE]);

    const projects = navLinks().find((a) => a.textContent?.includes("Projects"));
    expect(projects).toBeDefined();
    expect(projects!.hasAttribute("href")).toBe(false);
    expect(projects!.getAttribute("aria-disabled")).toBe("true");
    expect(projects!.textContent).toContain("offline");
    expect(projects!.getAttribute("title")).toBe("baseUrl must use http or https");
  });

  it("case 4: a package hash renders the same-origin iframe; an offline package shows the banner instead", async () => {
    await renderApp([BASE_PACKAGE], "#/ext/se/ui/projects");

    expect(iframe()?.getAttribute("src")).toBe("/ext/se/ui/projects");
    expect(container.textContent ?? "").not.toContain("package offline");

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderApp([OFFLINE_PACKAGE], "#/ext/se/ui/projects");

    expect(iframe()).toBeNull();
    expect(container.textContent ?? "").toContain("package offline");
  });

  it("case 5: deep links mirror both ways -- iframe navigation does not reload the frame", async () => {
    await renderApp([BASE_PACKAGE], "#/ext/se/ui/projects");

    const original = iframe();
    expect(original?.getAttribute("src")).toBe("/ext/se/ui/projects");

    // iframe -> shell: the package navigated itself, so the shell updates its
    // hash but must NOT push the path back into src (that would reload it).
    await postMessageToShell({ type: "apra-fleet:navigate", path: "/ui/projects/p1" });
    await flushHashChange();

    expect(window.location.hash).toBe("#/ext/se/ui/projects/p1");
    expect(iframe()).toBe(original);
    expect(iframe()?.getAttribute("src")).toBe("/ext/se/ui/projects");

    // shell -> iframe: a hash change the shell originated does set src, on the
    // very same frame element (no remount).
    window.location.hash = "#/ext/se/ui/sprints";
    await flushHashChange();

    expect(iframe()).toBe(original);
    expect(iframe()?.getAttribute("src")).toBe("/ext/se/ui/sprints");
  });

  it("case 6: messages from a foreign origin or a different window are ignored", async () => {
    await renderApp([BASE_PACKAGE], "#/ext/se/ui/projects");

    await postMessageToShell(
      { type: "apra-fleet:navigate", path: "/ui/evil" },
      { origin: "https://attacker.example" }
    );
    await flushHashChange();
    expect(window.location.hash).toBe("#/ext/se/ui/projects");

    // Same origin, but posted by a window that is not this iframe.
    await postMessageToShell({ type: "apra-fleet:navigate", path: "/ui/evil" }, { source: window });
    await flushHashChange();
    expect(window.location.hash).toBe("#/ext/se/ui/projects");

    // A foreign-origin context message must not move project-scoped entries
    // into view either.
    await postMessageToShell(
      { type: "apra-fleet:context", project: "p1" },
      { origin: "https://attacker.example" }
    );
    expect(navLabels()).toEqual(["Members", "Secrets", "Health", "Projects", "Sprints"]);
  });

  it("case 7: a 404 registry renders the static nav only, without crashing", async () => {
    await renderApp(null);

    expect(navLabels()).toEqual(["Members", "Secrets", "Health"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
