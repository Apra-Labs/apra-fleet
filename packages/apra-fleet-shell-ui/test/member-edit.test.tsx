import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Members } from "../src/pages/Members";
import type { FleetMember } from "../src/api/members";
import { LOCAL_MEMBER, MEMBERS_LOCAL } from "./member-fixtures";
import { findButton, findFieldInSection, jsonResponse, makeFetchMock, openDrawerFor, setInputValue } from "./harness";

// apra-fleet-i9ag.6.1.2: covers the member edit flow added by apra-fleet-i9ag.6.1.1
// (updateMember wrapper + MemberDrawer's "Edit member" form). Same harness as
// test/members.test.tsx -- react-dom/client createRoot plus React's own act,
// no @testing-library/react.

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
    await openDrawerFor(container, "local-one");

    const tagsInput = findFieldInSection(container, "Edit member", "Tags") as HTMLInputElement;
    await act(async () => {
      setInputValue(tagsInput, "core, extra");
    });

    currentMembers = { members: [{ ...LOCAL_MEMBER, tags: ["core", "extra"] }] };

    await act(async () => {
      findButton(container, "Save changes").click();
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
    await openDrawerFor(container, "local-one");

    const tagsInput = findFieldInSection(container, "Edit member", "Tags") as HTMLInputElement;
    await act(async () => {
      setInputValue(tagsInput, "core, extra");
    });
    await act(async () => {
      findButton(container, "Save changes").click();
    });

    const alert = Array.from(container.querySelectorAll('[role="alert"]')).find((el) =>
      (el.textContent ?? "").includes("stub: friendly_name invalid")
    );
    expect(alert).toBeDefined();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("a rename followed by a second edit of a different field re-derives the dirty-diff baseline from the refreshed member, so the second POST carries only the second field (apra-fleet-i9ag.6.4)", async () => {
    // Members.tsx keys MemberDrawer on `selected?.id`, which never changes
    // across a same-member save -- so without re-pointing `selected` at the
    // refreshed row after load(), MemberDrawer.buildUpdateBody would keep
    // diffing against the PRE-rename member object and re-send friendly_name
    // on every subsequent save even though the operator never touched it
    // again. currentMembers is swapped to the server's post-rename payload
    // before the first save resolves, exactly as the real re-fetch would.
    let currentMembers: { members: FleetMember[] } = MEMBERS_LOCAL;
    const { fn, calls } = makeFetchMock(() => currentMembers, {
      "/api/fleet/update-member": jsonResponse(200, { text: "updated" })
    });
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor(container, "local-one");

    const nameInput = findFieldInSection(container, "Edit member", "Friendly name") as HTMLInputElement;
    await act(async () => {
      setInputValue(nameInput, "renamed-one");
    });

    currentMembers = { members: [{ ...LOCAL_MEMBER, name: "renamed-one" }] };

    await act(async () => {
      findButton(container, "Save changes").click();
    });

    const firstUpdateCalls = calls.filter((c) => c.url === "/api/fleet/update-member");
    expect(firstUpdateCalls).toHaveLength(1);
    expect(Object.keys(firstUpdateCalls[0].body as Record<string, unknown>).sort()).toEqual([
      "friendly_name",
      "member_id"
    ]);

    // The row/drawer title now reflect the rename -- confirms `selected` was
    // re-pointed at the refreshed member, not left on the pre-save snapshot.
    expect(container.querySelector('[role="dialog"] h2')?.textContent ?? "").toContain("renamed-one");

    const tagsInput = findFieldInSection(container, "Edit member", "Tags") as HTMLInputElement;
    await act(async () => {
      setInputValue(tagsInput, "core, extra");
    });

    currentMembers = { members: [{ ...LOCAL_MEMBER, name: "renamed-one", tags: ["core", "extra"] }] };

    await act(async () => {
      findButton(container, "Save changes").click();
    });

    const secondUpdateCalls = calls.filter((c) => c.url === "/api/fleet/update-member");
    expect(secondUpdateCalls).toHaveLength(2);
    const secondBody = secondUpdateCalls[1].body as Record<string, unknown>;
    // The bug this guards against: without the fix, friendly_name would still
    // be dirty (baseline stuck on the pre-rename name) and would reappear here.
    expect(Object.keys(secondBody).sort()).toEqual(["member_id", "tags"]);
    expect(secondBody.tags).toEqual(["core", "extra"]);
  });

  it("does not render host/port/username inputs for a local-type member", async () => {
    const { fn } = makeFetchMock(() => MEMBERS_LOCAL);
    vi.stubGlobal("fetch", fn);

    await renderMembers();
    await openDrawerFor(container, "local-one");

    expect(() => findFieldInSection(container, "Edit member", "Host")).toThrow();
    expect(() => findFieldInSection(container, "Edit member", "Port")).toThrow();
    expect(() => findFieldInSection(container, "Edit member", "Username")).toThrow();
  });
});
