import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Health } from "../src/pages/Health";

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

  it("lists the packages when the registry returns a populated fixture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
        if (url === "/api/workflow-packages") return jsonResponse(200, { packages: ["build", "deploy"] });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    await renderHealth();

    const text = container.textContent ?? "";
    expect(text).toContain("build");
    expect(text).toContain("deploy");
    expect(text).not.toContain("no workflow packages registered");
  });
});
