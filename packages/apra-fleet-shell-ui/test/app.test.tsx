import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";

// apra-fleet-v6t7.1.4 (Members render/error states) extended by
// apra-fleet-9h9j.3.2 (shell navigation and routing across Members/
// Secrets/Health). Renders through react-dom/client + React's own act
// (React 18.3+), not @testing-library/react, since that package is not a
// repo dependency and this suite must not add a new one just to assert on
// rendered markup.

// React's act() only suppresses its "not wrapped in act" warnings when this
// global is set (see https://react.dev/warnings/react-dom-test-utils) --
// jsdom via vitest does not set it for us.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// apra-fleet-9h9j.2.1 (lane s4-members) extended the Members table to the
// full W1 column set (name/OS/shell/provider/auth state/tags/reserved-by/
// owner) -- these fixtures and header assertions were updated in this
// commit to match that shape; they previously pinned the earlier minimal
// 3-column table.
const TWO_MEMBERS = {
  members: [
    {
      id: "member-1",
      name: "alpha",
      type: "worker",
      os: "linux",
      llmProvider: "anthropic",
      llm_auth: "ok"
    },
    {
      id: "member-2",
      name: "beta",
      type: "orchestrator",
      os: "windows",
      llmProvider: "openai",
      llm_auth: "expired"
    }
  ]
};

const NO_CREDENTIALS = { credentials: [] };
const STATUS_FIXTURE = {
  version: "apra-fleet 0.9.0",
  summary: { total: 2, online: 1, offline: 1 }
};

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

/** Routes every page's fetch to its own fixture, keyed by pathname --
 *  App only ever mounts the active screen's component, so only that
 *  screen's route needs a real answer at any one time. */
function makeFetchMock() {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/fleet/members" && method === "GET") return jsonResponse(200, TWO_MEMBERS);
    if (url === "/api/fleet/credential-store-list") return jsonResponse(200, NO_CREDENTIALS);
    if (url === "/api/fleet/status") return jsonResponse(200, STATUS_FIXTURE);
    if (url === "/api/workflow-packages") return jsonResponse(404, {});
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

async function renderApp() {
  await act(async () => {
    root.render(<App />);
  });
}

function headerTexts(): string[] {
  return Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
}

describe("Members page (apra-fleet-v6t7.1.4)", () => {
  it("renders both member rows and the expected W1 column headers by default", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    await renderApp();

    expect(headerTexts()).toEqual([
      "Name",
      "OS",
      "Shell",
      "Provider",
      "Auth state",
      "Tags",
      "Reserved by",
      "Owner"
    ]);

    const rowText = container.textContent ?? "";
    expect(rowText).toContain("alpha");
    expect(rowText).toContain("anthropic");
    expect(rowText).toContain("ok");
    expect(rowText).toContain("beta");
    expect(rowText).toContain("openai");
    expect(rowText).toContain("expired");
  });

  it("renders the error state when the fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await renderApp();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Failed to load members");
    expect(alert?.textContent).toContain("network down");
  });

  it("renders the error state when the response is non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ members: [] })
      })
    );

    await renderApp();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Failed to load members");
    expect(alert?.textContent).toContain("500");
  });
});

describe("Shell navigation (apra-fleet-9h9j.3.2)", () => {
  it("defaults to the Members screen with no hash", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    await renderApp();

    expect(headerTexts().length).toBe(8);
    expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe("Members");
  });

  it("activating the Secrets and Health nav links renders each screen's component", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    await renderApp();

    const secretsLink = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Secrets");
    expect(secretsLink).toBeDefined();
    await act(async () => {
      secretsLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      window.location.hash = "#/secrets";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(container.textContent ?? "").toContain("Stored credentials");

    const healthLink = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Health");
    await act(async () => {
      window.location.hash = "#/health";
      window.dispatchEvent(new Event("hashchange"));
    });
    void healthLink;
    expect(container.textContent ?? "").toContain("Server version, data dir and fleet status");

    await act(async () => {
      window.location.hash = "#/members";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(headerTexts().length).toBe(8);
  });

  it("loading the app at a deep link for Secrets renders Secrets directly", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    window.location.hash = "#/secrets";

    await renderApp();

    expect(container.textContent ?? "").toContain("Stored credentials");
    expect(headerTexts()).not.toContain("Owner");
  });

  it("loading the app at a deep link for Health renders Health directly", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    window.location.hash = "#/health";

    await renderApp();

    expect(container.textContent ?? "").toContain("Server version, data dir and fleet status");
    expect(container.textContent ?? "").toContain("apra-fleet 0.9.0");
  });
});
