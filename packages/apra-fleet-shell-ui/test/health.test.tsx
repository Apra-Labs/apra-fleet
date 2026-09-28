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

  // apra-fleet-i9ag.14.6: the server now sends an authoritative `dataDir`
  // field (i9ag.14.4); the Health page must prefer it over the legacy
  // logFile-derivation fallback, which stays only for an older server whose
  // payload has no dataDir at all.
  it("renders payload.dataDir directly when present with no logFile (the fresh-install case)", async () => {
    const fixture = {
      version: "apra-fleet 0.9.0",
      summary: { total: 0, online: 0, offline: 0 },
      dataDir: "/home/fleet/.apra-fleet/data"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, fixture);
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const text = container.textContent ?? "";
    expect(text).toContain("/home/fleet/.apra-fleet/data");
    expect(text).not.toContain("Data dir-");
  });

  it("still derives the data dir from logFile for a legacy payload with no dataDir field", async () => {
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

    expect(container.textContent ?? "").toContain("/home/fleet/.apra-fleet/data");
  });

  it("renders '-' when the payload has neither dataDir nor logFile", async () => {
    const fixture = {
      version: "apra-fleet 0.9.0",
      summary: { total: 0, online: 0, offline: 0 }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, fixture);
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const dd = container.querySelectorAll("dd");
    // Version, Data dir, Update available, Fleet status -- Data dir is index 1.
    expect(dd[1]?.textContent).toBe("-");
  });

  it("prefers dataDir over logFile when both are present", async () => {
    const fixture = {
      version: "apra-fleet 0.9.0",
      summary: { total: 0, online: 0, offline: 0 },
      dataDir: "/authoritative/data/dir",
      logFile: "/legacy/derived/logs/fleet-1.log"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, fixture);
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const dd = container.querySelectorAll("dd");
    expect(dd[1]?.textContent).toBe("/authoritative/data/dir");
    expect(container.textContent ?? "").not.toContain("/legacy/derived");
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

  // apra-fleet-i9ag.12.9: the server pre-renders this text from
  // src/cli/fleet-se-prereqs.ts's summarizeFleetSePrereqs() -- the Health
  // screen must render it VERBATIM (it cannot import that module itself; see
  // FleetStatusPayload.fleetSePrereqs's doc comment in api/health.ts). When
  // the field is absent, see the sibling case below (apra-fleet-i9ag.13.9):
  // an explicit "unknown" fleet-se row is shown instead of hiding the row.
  it("renders the server-provided fleet-se prerequisite summary verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") {
          return jsonResponse(200, {
            ...STATUS_FIXTURE,
            fleetSePrereqs: "NOT INSTALLED (npm: NOT INSTALLED) -- fleet-se requires Node.js 22.16+ and npm: install them and re-run, or use --workflows none for the core console only"
          });
        }
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const text = container.textContent ?? "";
    expect(text).toContain("fleet-se");
    expect(text).toContain(
      "NOT INSTALLED (npm: NOT INSTALLED) -- fleet-se requires Node.js 22.16+ and npm: install them and re-run, or use --workflows none for the core console only"
    );
  });

  // apra-fleet-i9ag.13.9: an operator must be able to tell "prerequisites
  // fine" apart from "not reported" -- hiding the row entirely (the old
  // behaviour this case used to pin) collapses those two states into one.
  // The row is now always rendered, with an explicit unknown value when the
  // server omits the field.
  //
  // REVERT CHECK (apra-fleet-i9ag.13.10 criterion 8): reverting Health.tsx's
  // unknown branch back to the old status.payload.fleetSePrereqs ? ... : null
  // guard makes this canary case -- "shows an explicit unknown fleet-se row
  // when the server omits the field (older server / probe failed)" (below) --
  // FAIL, because the fixture omits the field so no fleet-se dt would render.
  // Verified via git stash and restored.
  it("shows an explicit unknown fleet-se row when the server omits the field (older server / probe failed)", async () => {
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

    const dts = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(dts).toContain("fleet-se");
    const text = container.textContent ?? "";
    expect(text).toContain("unknown");
    expect(text).toContain("Version");
    expect(text).toContain("Data dir");
    expect(text).toContain("Update available");
    expect(text).toContain("Fleet status");
    expect(text).toContain("Workflow packages");
  });

  // apra-fleet-i9ag.12.11: none of the cases above drive the status-fetch
  // failure branch (Health.tsx:70). The always-render change from
  // apra-fleet-i9ag.13.9 makes the loaded-vs-error distinction load-bearing --
  // the fleet-se row must appear in the loaded state and must NEVER leak
  // into the error state, since the whole <dl> (including the fleet-se dt)
  // only renders when status.kind === "loaded".
  it("shows the alert and no fleet-se row when the status fetch rejects at the network level", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") throw new Error("network down");
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent ?? "").toContain("Failed to load status");
    const dts = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(dts).not.toContain("fleet-se");
  });

  it("shows the alert and no fleet-se row when the status fetch resolves non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(500, { error: "boom" });
        if (url === "/api/workflow-packages") return jsonResponse(404, {});
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent ?? "").toContain("Failed to load status");
    const dts = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(dts).not.toContain("fleet-se");
  });

  // apra-fleet-i9ag.17.3.2: the supervisor project-folder row, reached
  // through the console's /ext/se/* proxy to the supervisor's own GET
  // /api/health (apra-fleet-i9ag.17.3.1). These four cases pin the three
  // distinguishable states (configured / not-configured / unknown) plus the
  // isolation guarantee that a supervisor outage can never take the rest of
  // the page down.
  //
  // REVERT CHECK: reverting Health.tsx's project-folder row (and its
  // supervisor-health fetch) back to the pre-change page makes every one of
  // these five cases fail -- there is no "Project folder" <dt> at all, so
  // `dts` never contains it and the text assertions below never match.
  // Verified via `git stash` of src/pages/Health.tsx and
  // src/api/supervisor-health.ts, observed the failure (no "Project folder"
  // dt, TS import error for supervisor-health), then restored.
  describe("supervisor project-folder row (apra-fleet-i9ag.17.3.2)", () => {
    it("configured: renders both the resolved project folder and the source that won", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
          if (url === "/api/workflow-packages") return jsonResponse(404, {});
          if (url === "/ext/se/api/health") {
            return jsonResponse(200, {
              status: "ok",
              projectDir: "/home/fleet/project-a",
              projectDirSource: "config"
            });
          }
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

      await renderHealth();

      const dts = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);
      expect(dts).toContain("Project folder");
      const text = container.textContent ?? "";
      expect(text).toContain("/home/fleet/project-a");
      expect(text).toContain("config");
    });

    it("not configured: renders the explicit not-configured text naming the fix, never an empty value", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
          if (url === "/api/workflow-packages") return jsonResponse(404, {});
          if (url === "/ext/se/api/health") {
            return jsonResponse(200, { status: "ok", projectDir: null, projectDirSource: null });
          }
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

      await renderHealth();

      const text = container.textContent ?? "";
      expect(text).toContain("not configured");
      expect(text).toContain("--beads-dir");
      expect(text).not.toContain("unknown (supervisor unreachable");
    });

    it("unknown: renders the explicit unknown text when the supervisor is unreachable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
          if (url === "/api/workflow-packages") return jsonResponse(404, {});
          if (url === "/ext/se/api/health") throw new Error("network down");
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

      await renderHealth();

      const text = container.textContent ?? "";
      expect(text).toContain("unknown (supervisor unreachable");
      expect(text).not.toContain("not configured");
    });

    it("unknown: renders the explicit unknown text when the payload predates the field (older supervisor)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
          if (url === "/api/workflow-packages") return jsonResponse(404, {});
          // No projectDir key at all -- the older-supervisor payload shape.
          if (url === "/ext/se/api/health") return jsonResponse(200, { status: "ok" });
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

      await renderHealth();

      const text = container.textContent ?? "";
      expect(text).toContain("unknown (supervisor unreachable");
      expect(text).not.toContain("not configured");
    });

    it("isolation: an unreachable supervisor degrades only its own row -- the other five rows and the workflow-packages list still render", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
          if (url === "/api/workflow-packages") {
            return jsonResponse(200, { packages: [packageFixture("build")] });
          }
          if (url === "/ext/se/api/health") throw new Error("network down");
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

      await renderHealth();

      expect(container.querySelector('[role="alert"]')).toBeNull();
      const dts = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);
      expect(dts).toEqual(["Version", "Data dir", "Update available", "Fleet status", "fleet-se", "Project folder"]);
      const text = container.textContent ?? "";
      expect(text).toContain("apra-fleet 0.9.0");
      expect(text).toContain("3 member(s)");
      expect(text).toContain("unknown (supervisor unreachable");
      const items = Array.from(container.querySelectorAll("li")).map((li) => li.textContent ?? "");
      expect(items).toEqual(["build"]);
    });
  });
});
