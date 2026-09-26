import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Members } from "../src/pages/Members";
import { MEMBERS_A, MEMBERS_B } from "./member-fixtures";
import { type FetchCall, findButton, jsonResponse, makeFetchMock } from "./harness";

// apra-fleet-9h9j.2.3: end-to-end coverage for the Members screen (W1 table,
// drawer actions, background refresh, apra-fleet-9h9j.2.1) against a mocked
// fetch. Renders through react-dom/client + React's own act (React 18.3+),
// matching the existing test/app.test.tsx pattern (no @testing-library/react
// dependency).

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.useRealTimers();
});

async function renderMembers(refreshIntervalMs?: number) {
  await act(async () => {
    root.render(<Members refreshIntervalMs={refreshIntervalMs} />);
  });
}

function headerTexts(): string[] {
  return Array.from(container.querySelectorAll("th")).map((th) => th.textContent ?? "");
}

describe("Members screen (apra-fleet-9h9j.2.3)", () => {
  it("renders all eight W1 column headers, with owner showing the value or (none)", async () => {
    const { fn } = makeFetchMock(MEMBERS_A);
    vi.stubGlobal("fetch", fn);

    await renderMembers();

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

    // owner is the server's {package, ref} object, rendered "<package>@<ref>";
    // an absent owner renders "(none)".
    const ownerCells = Array.from(container.querySelectorAll("tbody tr")).map(
      (tr) => tr.querySelectorAll("td")[7]?.textContent
    );
    expect(ownerCells).toEqual(["fleet-sprint@proj-alpha", "(none)"]);
  });

  it("opens a drawer on row click and issues exactly one request per action button", async () => {
    const { fn, calls } = makeFetchMock(MEMBERS_A);
    vi.stubGlobal("fetch", fn);

    await renderMembers();

    const row = container.querySelector("tbody tr");
    expect(row).not.toBeNull();
    await act(async () => {
      (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    // Compose permissions is no longer a generic ACTIONS entry (it needs
    // role/tags/grant/grant_reason inputs, apra-fleet-i9ag.6.2.1) -- its own
    // coverage lives in the paired [test] task's suite.
    const actions: Array<[string, string]> = [
      ["Provision LLM auth", "/api/fleet/provision-llm-auth"],
      ["Provision VCS auth", "/api/fleet/provision-vcs-auth"],
      ["Revoke VCS auth", "/api/fleet/revoke-vcs-auth"],
      ["Setup SSH key", "/api/fleet/setup-ssh-key"],
      ["Update LLM CLI", "/api/fleet/update-llm-cli"],
      ["Remove member", "/api/fleet/remove-member"]
    ];

    for (const [label, path] of actions) {
      await act(async () => {
        findButton(container, label).click();
      });
    }

    for (const [, path] of actions) {
      const matching = calls.filter((c) => c.url === path && c.method === "POST");
      expect(matching.length).toBe(1);
      expect(matching[0].body).toMatchObject({ member_id: "member-1" });
    }
  });

  it("Show member detail posts to /api/fleet/member-detail and renders the returned detail", async () => {
    const { fn, calls } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/member-detail": jsonResponse(200, {
        name: "alpha",
        id: "member-1",
        llm_cli: "claude 2.1.0",
        connectivity: { status: "online" }
      })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    const row = container.querySelector("tbody tr");
    await act(async () => {
      (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButton(container, "Show member detail").click();
    });

    const detailCalls = calls.filter((c) => c.url === "/api/fleet/member-detail");
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0].method).toBe("POST");
    expect(detailCalls[0].body).toEqual({ member_id: "member-1", format: "json" });

    const detail = container.querySelector('[data-testid="member-detail"]');
    expect(detail).not.toBeNull();
    const text = detail?.textContent ?? "";
    expect(text).toContain("claude 2.1.0");
    // Nested objects are stringified, never rendered as a React child.
    expect(text).toContain('{"status":"online"}');
  });

  it("Show member detail renders a route error inline", async () => {
    const { fn } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/member-detail": jsonResponse(400, { error: "stub: member_id required" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    const row = container.querySelector("tbody tr");
    await act(async () => {
      (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButton(container, "Show member detail").click();
    });

    const alert = Array.from(container.querySelectorAll('[role="alert"]')).find((el) =>
      (el.textContent ?? "").includes("stub: member_id required")
    );
    expect(alert).toBeDefined();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("renders a 4xx tool error inline while the drawer stays open", async () => {
    const { fn } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/remove-member": jsonResponse(422, { error: "stub: member is busy" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();

    const row = container.querySelector("tbody tr");
    await act(async () => {
      (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      findButton(container, "Remove member").click();
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const alert = Array.from(container.querySelectorAll('[role="alert"]')).find((el) =>
      (el.textContent ?? "").includes("stub: member is busy")
    );
    expect(alert).toBeDefined();
  });

  it("keeps the previously rendered rows in the DOM while a background refresh is in flight", async () => {
    vi.useFakeTimers();

    let resolveSecond!: (value: unknown) => void;
    const secondResponse = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    const calls: FetchCall[] = [];
    const fn = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: undefined });
      if (calls.filter((c) => c.url === "/api/fleet/members").length <= 1) {
        return Promise.resolve(jsonResponse(200, MEMBERS_A));
      }
      return secondResponse;
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers(1000);

    expect(container.textContent ?? "").toContain("alpha");

    await act(async () => {
      vi.advanceTimersByTime(1000);
      // Let the interval's async load() reach its pending fetch.
      await Promise.resolve();
    });

    // Second fetch is in flight (unresolved) -- the first response's rows
    // must still be present, with no loading placeholder in their place.
    expect(container.textContent ?? "").toContain("alpha");
    expect(container.textContent ?? "").not.toContain("Loading members");

    await act(async () => {
      resolveSecond(jsonResponse(200, MEMBERS_B));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent ?? "").toContain("gamma");
    expect(container.textContent ?? "").not.toContain("alpha");
  });
});
