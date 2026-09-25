import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Secrets } from "../src/pages/Secrets";

// apra-fleet-9h9j.3.3: Secrets screen (S2, apra-fleet-9h9j.3.1) against a
// mocked fetch and window.open -- list rendering, the out-of-band add flow,
// update, delete-behind-confirm, GitHub App setup, and secret non-leakage.
// Same react-dom/client + act rendering pattern as test/app.test.tsx.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A sentinel that must never appear in any request body or rendered text --
// the console route's whitelist (src/console/routes/fleet.ts
// whitelistCredentialEntry) never emits a credential value, so this must
// stay entirely absent even though a real "value" field does not exist in
// this response shape at all.
const SENTINEL = "SENTINEL-SECRET-DO-NOT-LEAK";

const ONE_CREDENTIAL = {
  credentials: [
    {
      name: "github-pat",
      network_policy: "confirm",
      members: "*",
      expiry: "2027-01-01T00:00:00Z",
      value: SENTINEL // must never be forwarded by the whitelist route in real life;
      // included here only to prove the UI would not render/forward it even if it leaked.
    }
  ]
};

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function makeFetchMock(overrides: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url in overrides) return overrides[url];
    if (url === "/api/fleet/credential-store-list") return jsonResponse(200, ONE_CREDENTIAL);
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

async function renderSecrets() {
  await act(async () => {
    root.render(<Secrets />);
  });
}

function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!button) throw new Error(`button "${label}" not found`);
  button.click();
}

function findByLabel(label: string): HTMLInputElement | HTMLSelectElement {
  const labels = Array.from(container.querySelectorAll("label[for]"));
  const target = labels.find((el) => {
    const text = el.textContent ?? "";
    return text === label || text === `${label} *`;
  });
  if (!target) throw new Error(`label "${label}" not found`);
  const id = target.getAttribute("for");
  const field = container.querySelector(`#${id}`);
  if (!field) throw new Error(`field for label "${label}" not found`);
  return field as HTMLInputElement | HTMLSelectElement;
}

function setValue(field: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    field instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Secrets screen (apra-fleet-9h9j.3.3)", () => {
  it("renders name, policy, members and expiry for a fixture credential, with no leaked value", async () => {
    const { fn } = makeFetchMock();
    vi.stubGlobal("fetch", fn);

    await renderSecrets();

    const text = container.textContent ?? "";
    expect(text).toContain("github-pat");
    expect(text).toContain("confirm");
    expect(text).toContain("*");
    expect(text).toContain("2027-01-01T00:00:00Z");
    expect(text).not.toContain(SENTINEL);
  });

  it("the add flow calls window.open with exactly the url the credential-set route returned, with no secret value in any request body", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const { fn, calls } = makeFetchMock({
      "/api/fleet/credential-store-set": jsonResponse(200, {
        url: "http://127.0.0.1:9000/collect/abc123",
        expiresAt: "2026-10-01T00:00:00Z"
      })
    });
    vi.stubGlobal("fetch", fn);

    await renderSecrets();

    await act(async () => {
      clickButton("Add credential");
    });
    setValue(findByLabel("Name"), "new-secret");
    setValue(findByLabel("Prompt"), "Enter the new secret");

    await act(async () => {
      clickButton("Submit");
      await flush();
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith("http://127.0.0.1:9000/collect/abc123", "_blank", "noopener");

    for (const call of calls) {
      expect(JSON.stringify(call.body ?? "")).not.toContain(SENTINEL);
    }
    expect(container.textContent ?? "").not.toContain(SENTINEL);
  });

  it("update calls its own route", async () => {
    const { fn, calls } = makeFetchMock({
      "/api/fleet/credential-store-update": jsonResponse(200, { name: "github-pat" })
    });
    vi.stubGlobal("fetch", fn);

    await renderSecrets();

    await act(async () => {
      clickButton("Update");
    });
    setValue(findByLabel("Members"), "alice,bob");

    await act(async () => {
      clickButton("Save");
      await flush();
    });

    const updateCalls = calls.filter((c) => c.url === "/api/fleet/credential-store-update");
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].body).toMatchObject({ name: "github-pat", members: "alice,bob" });
  });

  it("delete requires confirm, and cancelling issues no delete request", async () => {
    const { fn, calls } = makeFetchMock({
      "/api/fleet/credential-store-delete": jsonResponse(200, { name: "github-pat" })
    });
    vi.stubGlobal("fetch", fn);

    await renderSecrets();

    await act(async () => {
      clickButton("Delete");
    });
    await act(async () => {
      clickButton("Cancel");
    });

    expect(calls.some((c) => c.url === "/api/fleet/credential-store-delete")).toBe(false);

    await act(async () => {
      clickButton("Delete");
    });
    await act(async () => {
      clickButton("Confirm delete");
      await flush();
    });

    const deleteCalls = calls.filter((c) => c.url === "/api/fleet/credential-store-delete");
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0].body).toMatchObject({ name: "github-pat" });
  });

  it("setup GitHub App calls its own route", async () => {
    const { fn, calls } = makeFetchMock({
      "/api/fleet/setup-git-app": jsonResponse(200, { text: "GitHub App configured" })
    });
    vi.stubGlobal("fetch", fn);

    await renderSecrets();

    await act(async () => {
      clickButton("Setup GitHub App");
    });
    setValue(findByLabel("App ID"), "12345");
    setValue(findByLabel("Private key path"), "/keys/app.pem");
    setValue(findByLabel("Installation ID"), "678");

    await act(async () => {
      clickButton("Submit");
      await flush();
    });

    const gitAppCalls = calls.filter((c) => c.url === "/api/fleet/setup-git-app");
    expect(gitAppCalls.length).toBe(1);
    expect(gitAppCalls[0].body).toEqual({
      app_id: "12345",
      private_key_path: "/keys/app.pem",
      installation_id: 678
    });
    expect(container.textContent ?? "").toContain("GitHub App configured");
  });
});
