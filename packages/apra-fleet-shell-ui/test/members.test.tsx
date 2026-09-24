import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Members } from "../src/pages/Members";

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

const MEMBERS_A = {
  members: [
    {
      id: "member-1",
      name: "alpha",
      type: "worker",
      os: "linux",
      shell: "gitbash",
      llmProvider: "anthropic",
      llm_auth: "ok",
      tags: ["core", "gpu"],
      reservedBy: "sprint-42",
      owner: "alice@example.com"
    },
    {
      id: "member-2",
      name: "beta",
      type: "orchestrator",
      os: "windows",
      llmProvider: "openai",
      llm_auth: "expired",
      tags: null,
      reservedBy: null,
      owner: null
    }
  ]
};

const MEMBERS_B = {
  members: [
    {
      id: "member-3",
      name: "gamma",
      type: "worker",
      os: "macos",
      llmProvider: "claude",
      llm_auth: "ok",
      tags: null,
      reservedBy: null,
      owner: null
    }
  ]
};

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

/** A fetch stub that always answers GET /api/fleet/members from `membersPayload`
 *  and any POST /api/fleet/<action> from `actionOverrides[path]`, defaulting
 *  to a generic success envelope. Every call is recorded in `calls`. */
function makeFetchMock(membersPayload: unknown, actionOverrides: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url === "/api/fleet/members" && method === "GET") {
      return jsonResponse(200, membersPayload);
    }
    if (url in actionOverrides) {
      return actionOverrides[url];
    }
    return jsonResponse(200, { text: `ok:${url}` });
  });
  return { fn, calls };
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

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label
  );
  if (!button) throw new Error(`button "${label}" not found`);
  return button as HTMLButtonElement;
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

    const rowText = container.textContent ?? "";
    expect(rowText).toContain("alice@example.com");
    expect(rowText).toContain("(none)");
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

    const actions: Array<[string, string]> = [
      ["Provision LLM auth", "/api/fleet/provision-llm-auth"],
      ["Provision VCS auth", "/api/fleet/provision-vcs-auth"],
      ["Revoke VCS auth", "/api/fleet/revoke-vcs-auth"],
      ["Setup SSH key", "/api/fleet/setup-ssh-key"],
      ["Compose permissions", "/api/fleet/compose-permissions"],
      ["Update LLM CLI", "/api/fleet/update-llm-cli"],
      ["Remove member", "/api/fleet/remove-member"]
    ];

    for (const [label, path] of actions) {
      await act(async () => {
        findButton(label).click();
      });
    }

    for (const [, path] of actions) {
      const matching = calls.filter((c) => c.url === path && c.method === "POST");
      expect(matching.length).toBe(1);
      expect(matching[0].body).toMatchObject({ member_id: "member-1" });
    }
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
      findButton("Remove member").click();
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
