import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Health } from "../src/pages/Health";
import type { WorkflowPackageView } from "../src/api/workflow-packages";

// apra-fleet-9h9j.3.3: Health screen (S3, apra-fleet-9h9j.3.1) against a
// mocked fetch -- version/data dir/update-available/status summary, and the
// workflow-packages empty-state-on-404-or-network-failure contract.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const STATUS_FIXTURE = {
  version: "apra-fleet 0.9.0",
  summary: { total: 3, online: 2, offline: 1 },
  updateAvailable: { latest: "v0.10.0", installed: "v0.9.0" },
  logFile: "/home/fleet/.apra-fleet/data/logs/fleet-4242.log"
};

/** The registry answers with WorkflowPackageView OBJECTS, not the bare
 *  strings this suite used to feed -- api/health.ts filtered for string[] and
 *  therefore showed "no packages" against every real registry. The package
 *  ids here are fixtures; the shell holds no package-id literal itself. */
function packageFixture(id: string, over: Partial<WorkflowPackageView> = {}): WorkflowPackageView {
  return {
    id,
    baseUrl: `http://127.0.0.1:7601/${id}`,
    apraFleetApi: "^0.5.0",
    configDeclared: false,
    offline: false,
    lastCheckedAt: 1_700_000_000_000,
    name: null,
    version: null,
    health: "/api/health",
    nav: [],
    panels: [],
    ownerRefs: null,
    holds: null,
    configError: null,
    ...over
  };
}

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function renderHealth() {
  await act(async () => {
    root.render(<Health />);
  });
}

describe("Health screen (apra-fleet-9h9j.3.3)", () => {
  it("renders version, data dir, update-available and the status summary from a fixture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const text = container.textContent ?? "";
    expect(text).toContain("apra-fleet 0.9.0");
    expect(text).toContain("/home/fleet/.apra-fleet/data");
    expect(text).toContain("v0.10.0");
    expect(text).toContain("v0.9.0");
    expect(text).toContain("3 member(s)");
    expect(text).toContain("2 online");
    expect(text).toContain("1 offline");
  });

  it("renders exactly the empty-state text with no error state when workflow-packages 404s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    expect(container.textContent ?? "").toContain("no workflow packages registered");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders the same empty state when the workflow-packages request fails at the network level", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
        if (url === "/api/workflow-packages") throw new Error("network down");
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    expect(container.textContent ?? "").toContain("no workflow packages registered");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("lists the registered package ids when the registry returns a populated object fixture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
        if (url === "/api/workflow-packages") {
          return jsonResponse(200, {
            packages: [
              packageFixture("build"),
              packageFixture("deploy", { name: "Deployer", version: "1.2.3" })
            ]
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const items = Array.from(container.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(2);
    // The id is what the registry keys on, so it is always shown; a declared
    // manifest name and version decorate it rather than replacing it.
    expect(items[0]).toBe("build");
    expect(items[1]).toContain("deploy");
    expect(items[1]).toContain("Deployer");
    expect(items[1]).toContain("1.2.3");
    expect(container.textContent ?? "").not.toContain("no workflow packages registered");
  });
});
