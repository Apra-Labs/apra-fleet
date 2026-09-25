import { vi } from "vitest";
import { act } from "react";

// Shared test harness for the Members screen suites (apra-fleet-i9ag.6.5):
// makeFetchMock, jsonResponse, setInputValue, setSelectValue, findButton and
// openDrawerFor were duplicated across test/members.test.tsx, test/member-
// edit.test.tsx and test/member-compose.test.tsx. All three now import from
// here instead. Each container-scoped helper takes `container` as an
// explicit parameter (rather than closing over a module-level variable) so
// this module stays test-runner-agnostic and each caller keeps owning its
// own container/root lifecycle.

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

export function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

/**
 * A fetch stub that always answers GET /api/fleet/members from
 * `membersPayload` and any POST /api/fleet/<action> from
 * `actionOverrides[path]`, defaulting to a generic success envelope. Every
 * call is recorded in `calls`.
 *
 * `membersPayload` accepts either a plain value (reused verbatim for every
 * GET) or a thunk -- pass a thunk (`() => ...`) when a test needs to swap in
 * an updated payload between the initial mount GET and a later re-fetch GET,
 * needed to observe that a row actually re-renders from that SECOND fetch,
 * not merely that a second fetch happened.
 */
export function makeFetchMock(
  membersPayload: unknown | (() => unknown),
  actionOverrides: Record<string, unknown> = {}
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url === "/api/fleet/members" && method === "GET") {
      const payload = typeof membersPayload === "function" ? (membersPayload as () => unknown)() : membersPayload;
      return jsonResponse(200, payload);
    }
    if (url in actionOverrides) {
      return actionOverrides[url];
    }
    return jsonResponse(200, { text: `ok:${url}` });
  });
  return { fn, calls };
}

export function findButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label
  );
  if (!button) throw new Error(`button "${label}" not found`);
  return button as HTMLButtonElement;
}

/** Finds the <input>/<select> associated with a <label> whose text STARTS WITH
 *  `fieldLabel`, scoped to the <section aria-label="sectionLabel"> that holds
 *  it -- the drawer renders a "Tags (comma-separated)" label in BOTH the Edit
 *  member and Compose permissions sections, so an unscoped lookup would
 *  silently depend on document order. */
export function findFieldInSection(
  container: ParentNode,
  sectionLabel: string,
  fieldLabel: string
): HTMLInputElement | HTMLSelectElement {
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

export function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function openDrawerFor(container: ParentNode, memberName: string) {
  const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
    (tr.textContent ?? "").includes(memberName)
  );
  if (!row) throw new Error(`row for "${memberName}" not found`);
  await act(async () => {
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
