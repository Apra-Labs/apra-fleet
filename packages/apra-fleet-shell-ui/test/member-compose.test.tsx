import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Members } from "../src/pages/Members";
import { MEMBERS_A } from "./member-fixtures";

// apra-fleet-i9ag.6.2.2: covers the compose-permissions flow added by
// apra-fleet-i9ag.6.2.1 (widened composePermissions wrapper + MemberDrawer's
// own "Compose permissions" section). Same harness as test/members.test.tsx --
// react-dom/client createRoot plus React's own act, no @testing-library/react.

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
 *  would silently grab the wrong one. */
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

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
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

describe("Compose permissions flow (apra-fleet-i9ag.6.2.2)", () => {
  it("choosing role=reviewer posts member_id + role=reviewer", async () => {
    const { fn, calls } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/compose-permissions": jsonResponse(200, { text: "composed" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor("alpha");

    const roleSelect = findFieldInSection("Compose permissions", "Role") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(roleSelect, "reviewer");
    });
    await act(async () => {
      findButton("Compose permissions").click();
    });

    const composeCalls = calls.filter((c) => c.url === "/api/fleet/compose-permissions" && c.method === "POST");
    expect(composeCalls).toHaveLength(1);
    const body = composeCalls[0].body as Record<string, unknown>;
    expect(body.member_id).toBe("member-1");
    expect(body.role).toBe("reviewer");
  });

  it("submitting with neither role nor tags issues NO fetch and shows a visible message", async () => {
    const { fn, calls } = makeFetchMock(MEMBERS_A);
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor("alpha");

    await act(async () => {
      findButton("Compose permissions").click();
    });

    const composeCalls = calls.filter((c) => c.url === "/api/fleet/compose-permissions");
    expect(composeCalls).toHaveLength(0);

    const alert = Array.from(container.querySelectorAll('[role="alert"]')).find((el) =>
      (el.textContent ?? "").includes("Provide at least one of role or tags")
    );
    expect(alert).toBeDefined();
  });

  it("renders a NEVER_AUTO_GRANT refusal verbatim even though it arrives as an HTTP 200 {text} envelope", async () => {
    const refusal = "❌ Cannot auto-grant dangerous permissions: Bash(sudo:*). Escalate to user.";
    const { fn } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/compose-permissions": jsonResponse(200, { text: refusal })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor("alpha");

    const tagsInput = findFieldInSection("Compose permissions", "Tags") as HTMLInputElement;
    await act(async () => {
      setInputValue(tagsInput, "gpu");
    });
    await act(async () => {
      findButton("Compose permissions").click();
    });

    const status = Array.from(container.querySelectorAll('[role="status"]')).find((el) =>
      (el.textContent ?? "").includes(refusal)
    );
    expect(status).toBeDefined();
  });

  it("omits empty grant and grant_reason inputs from the posted body", async () => {
    const { fn, calls } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/compose-permissions": jsonResponse(200, { text: "composed" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor("alpha");

    const roleSelect = findFieldInSection("Compose permissions", "Role") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(roleSelect, "doer");
    });
    await act(async () => {
      findButton("Compose permissions").click();
    });

    const composeCalls = calls.filter((c) => c.url === "/api/fleet/compose-permissions");
    expect(composeCalls).toHaveLength(1);
    const body = composeCalls[0].body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("grant");
    expect(Object.keys(body)).not.toContain("grant_reason");
  });
});
