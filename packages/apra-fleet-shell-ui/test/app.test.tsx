import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";

// apra-fleet-v6t7.1.4: end-to-end coverage for the Members page (src/pages/
// Members.tsx) -- two-member render, the Name/Type-Provider/Status column
// headers, and the error state (both a rejected fetch and a non-2xx
// response). Renders through react-dom/client + React's own act (React
// 18.3+), not @testing-library/react, since that package is not a repo
// dependency and this suite must not add a new one just to assert on
// rendered markup.

// React's act() only suppresses its "not wrapped in act" warnings when this
// global is set (see https://react.dev/warnings/react-dom-test-utils) --
// jsdom via vitest does not set it for us.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TWO_MEMBERS = {
  members: [
    {
      id: "member-1",
      name: "alpha",
      type: "worker",
      llmProvider: "anthropic",
      llm_auth: "ok"
    },
    {
      id: "member-2",
      name: "beta",
      type: "orchestrator",
      llmProvider: "openai",
      llm_auth: "expired"
    }
  ]
};

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

async function renderApp() {
  await act(async () => {
    root.render(<App />);
  });
}

describe("Members page (apra-fleet-v6t7.1.4)", () => {
  it("renders both member rows and the expected column headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => TWO_MEMBERS
      })
    );

    await renderApp();

    const headers = Array.from(container.querySelectorAll("th")).map(
      (th) => th.textContent
    );
    expect(headers).toEqual(["Name", "Type / Provider", "Status"]);

    const rowText = container.textContent ?? "";
    expect(rowText).toContain("alpha");
    expect(rowText).toContain("worker / anthropic");
    expect(rowText).toContain("ok");
    expect(rowText).toContain("beta");
    expect(rowText).toContain("orchestrator / openai");
    expect(rowText).toContain("expired");
  });

  it("renders the error state when the fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );

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
