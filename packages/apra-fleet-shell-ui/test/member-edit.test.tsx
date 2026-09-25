import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Members } from "../src/pages/Members";
import type { FleetMember } from "../src/api/members";

// apra-fleet-i9ag.6.1.2: covers the member edit flow added by apra-fleet-i9ag.6.1.1
// (updateMember wrapper + MemberDrawer's "Edit member" form). Same harness as
// test/members.test.tsx -- react-dom/client createRoot plus React's own act,
// no @testing-library/react.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

/** membersPayload is a thunk (not a plain value) so a test can swap in an
 *  updated payload between the initial mount GET and a later re-fetch GET --
 *  needed to observe that the row actually re-renders from the second fetch,
 *  not just that a second fetch happened. */
function makeFetchMock(membersPayload: () => unknown, actionOverrides: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url === "/api/fleet/members" && method === "GET") {
      return jsonResponse(200, membersPayload());
    }
    if (url in actionOverrides) {
      return actionOverrides[url];
    }
    return jsonResponse(200, { text: `ok:${url}` });
  });
  return { fn, calls };
}

// `type` here is the REAL agentType value ("local"), unlike test/member-fixtures.ts's
// placeholder "worker"/"orchestrator" strings -- MemberDrawer's remote-only-fields
// check is `member.type === "remote"`, so this is the value that actually exercises it.
const LOCAL_MEMBER: FleetMember = {
  id: "member-local-1",
  name: "local-one",
  type: "local",
  os: "linux",
  llmProvider: "claude",
  llm_auth: "ok",
  tags: ["core"],
  reservedBy: null
};

const MEMBERS_LOCAL: { members: FleetMember[] } = { members: [LOCAL_MEMBER] };

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

async function renderMembers() {
  await act(async () => {
    root.render(<Members />);
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label
  );
  if (!button) throw new Error(`button "${label}" not found`);
  return button as HTMLButtonElement;
}

/** Finds the <input>/<select> associated with a <label> whose text STARTS WITH
 *  `fieldLabel`, scoped to the <section aria-label="sectionLabel"> that holds
 *  it -- the drawer has a "Tags (comma-separated)" field in BOTH the edit-
 *  member section and the compose-permissions section, so an unscoped lookup
 *  would silently grab the wrong one (same fix as member-compose.test.tsx). */
function findFieldInSection(sectionLabel: string, fieldLabel: string): HTMLInputElement | HTMLSelectElement {
  const section = container.querySelector(`section[aria-label="${sectionLabel}"]`);
  if (!section) throw new Error(`section "${sectionLabel}" not found`);
  const labelEl = Array.from(section.querySelectorAll("label")).find((l) =>
    (l.textContent ?? "").trim().startsWith(fieldLabel)
  );
  if (!labelEl) throw new Error(`label starting with "${fieldLabel}" not found in section "${sectionLabel}"`);
  const forId = labelEl.getAttribute("for");
  const field = forId
    ? Array.from(section.querySelectorAll("input, select")).find((el) => el.id === forId)
    : null;
  if (!field) throw new Error(`field for label "${fieldLabel}" not found in section "${sectionLabel}"`);
  return field as HTMLInputElement | HTMLSelectElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openDrawerFor(memberName: string) {
  const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
    (tr.textContent ?? "").includes(memberName)
  );
  if (!row) throw new Error(`row for "${memberName}" not found`);
  await act(async () => {
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Member edit flow (apra-fleet-i9ag.6.1.2)", () => {
  it("editing only tags sends member_id + tags ONLY, then re-fetches the members list and renders the new tags", async () => {
    // The second GET (triggered by onUpdated's re-fetch) resolves a payload
    // with the server's new tags -- distinct from the initial mount payload --
    // so the test can observe the row actually re-rendering from that fetch,
    // not merely that a second fetch happened.
    let currentMembers: { members: FleetMember[] } = MEMBERS_LOCAL;
    const { fn, calls } = makeFetchMock(() => currentMembers, {
      "/api/fleet/update-member": jsonResponse(200, { text: "updated" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor("local-one");

    const tagsInput = findFieldInSection("Edit member", "Tags") as HTMLInputElement;
    await act(async () => {
      setInputValue(tagsInput, "core, extra");
    });

    currentMembers = { members: [{ ...LOCAL_MEMBER, tags: ["core", "extra"] }] };

    await act(async () => {
      findButton("Save changes").click();
    });

    const updateCalls = calls.filter((c) => c.url === "/api/fleet/update-member");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].method).toBe("POST");
    const body = updateCalls[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["member_id", "tags"]);
    expect(body.tags).toEqual(["core", "extra"]);

    // A successful submit triggers a re-fetch of the members list: the
    // initial mount issues one GET, onUpdated's re-fetch issues a second.
    const memberGets = calls.filter((c) => c.url === "/api/fleet/members" && c.method === "GET");
    expect(memberGets).toHaveLength(2);

    // ...AND the row renders the new tag text from that second fetch, not
    // just the initial payload -- this would fail if load()'s result were
    // discarded or the Table were mis-keyed.
    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      (tr.textContent ?? "").includes("local-one")
    );
    expect(row).toBeDefined();
    expect(row?.textContent ?? "").toContain("core, extra");
  });

  it("a rejected submit renders the server's error verbatim and leaves the drawer open", async () => {
    const { fn } = makeFetchMock(() => MEMBERS_LOCAL, {
      "/api/fleet/update-member": jsonResponse(400, { error: "stub: friendly_name invalid" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor("local-one");

    const tagsInput = findFieldInSection("Edit member", "Tags") as HTMLInputElement;
    await act(async () => {
      setInputValue(tagsInput, "core, extra");
    });
    await act(async () => {
      findButton("Save changes").click();
    });

    const alert = Array.from(container.querySelectorAll('[role="alert"]')).find((el) =>
      (el.textContent ?? "").includes("stub: friendly_name invalid")
    );
    expect(alert).toBeDefined();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("does not render host/port/username inputs for a local-type member", async () => {
    const { fn } = makeFetchMock(() => MEMBERS_LOCAL);
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor("local-one");

    expect(() => findFieldInSection("Edit member", "Host")).toThrow();
    expect(() => findFieldInSection("Edit member", "Port")).toThrow();
    expect(() => findFieldInSection("Edit member", "Username")).toThrow();
  });
});
