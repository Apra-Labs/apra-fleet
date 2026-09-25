import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Members } from "../src/pages/Members";
import { MEMBERS_A } from "./member-fixtures";
import { findButton, findFieldInSection, makeFetchMock, jsonResponse, openDrawerFor, setInputValue, setSelectValue } from "./harness";

// apra-fleet-i9ag.6.2.2: covers the compose-permissions flow added by
// apra-fleet-i9ag.6.2.1 (widened composePermissions wrapper + MemberDrawer's
// own "Compose permissions" section). Same harness as test/members.test.tsx --
// react-dom/client createRoot plus React's own act, no @testing-library/react.

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
});

async function renderMembers() {
  await act(async () => {
    root.render(<Members />);
  });
}

describe("Compose permissions flow (apra-fleet-i9ag.6.2.2)", () => {
  it("choosing role=reviewer posts member_id + role=reviewer", async () => {
    const { fn, calls } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/compose-permissions": jsonResponse(200, { text: "composed" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor(container, "alpha");

    const roleSelect = findFieldInSection(container, "Compose permissions", "Role") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(roleSelect, "reviewer");
    });
    await act(async () => {
      findButton(container, "Compose permissions").click();
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
    await openDrawerFor(container, "alpha");

    await act(async () => {
      findButton(container, "Compose permissions").click();
    });

    const composeCalls = calls.filter((c) => c.url === "/api/fleet/compose-permissions");
    expect(composeCalls).toHaveLength(0);

    const alert = Array.from(container.querySelectorAll('[role="alert"]')).find((el) =>
      (el.textContent ?? "").includes("Provide at least one of role or tags")
    );
    expect(alert).toBeDefined();
  });

  it("renders a NEVER_AUTO_GRANT refusal verbatim even though it arrives as an HTTP 200 {text} envelope", async () => {
    // ASCII only (CLAUDE.md): the real refusal in src/tools/compose-permissions.ts:646
    // is prefixed with a cross emoji, but `refusal` here is self-referential -- it is
    // both the mocked response body and the expected substring -- so dropping the
    // emoji changes nothing about what this test proves.
    const refusal = "Cannot auto-grant dangerous permissions: Bash(sudo:*). Escalate to user.";
    const { fn } = makeFetchMock(MEMBERS_A, {
      "/api/fleet/compose-permissions": jsonResponse(200, { text: refusal })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor(container, "alpha");

    const tagsInput = findFieldInSection(container, "Compose permissions", "Tags") as HTMLInputElement;
    await act(async () => {
      setInputValue(tagsInput, "gpu");
    });
    await act(async () => {
      findButton(container, "Compose permissions").click();
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
    await openDrawerFor(container, "alpha");

    const roleSelect = findFieldInSection(container, "Compose permissions", "Role") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(roleSelect, "doer");
    });
    await act(async () => {
      findButton(container, "Compose permissions").click();
    });

    const composeCalls = calls.filter((c) => c.url === "/api/fleet/compose-permissions");
    expect(composeCalls).toHaveLength(1);
    const body = composeCalls[0].body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("grant");
    expect(Object.keys(body)).not.toContain("grant_reason");
  });
});
