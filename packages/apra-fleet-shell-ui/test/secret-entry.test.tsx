import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SecretEntry } from "../src/pages/SecretEntry";

// apra-fleet-i9ag.11.15: client-side empty-value guard for the secret-entry
// page, on top of the SecretEntry page added by apra-fleet-i9ag.11.7.
// apra-fleet-i9ag.11.8 (streak i9ag11-shell-route-test) extends this file
// with full page coverage: prompt load, submit outcomes, and the
// non-leakage property. Same react-dom/client + act rendering pattern as
// test/secrets.test.tsx, with mocked fetch and no @testing-library/react
// dependency.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "abc123";
const PROMPT_FIXTURE = { name: "github-pat", prompt: "Enter the GitHub PAT" };

// The value that must never leak into the DOM, the location, or a console
// call once it has been typed and submitted.
const SENTINEL = "SENTINEL-SECRET-DO-NOT-LEAK";

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Defaults the prompt route to PROMPT_FIXTURE (so tests that only care
 *  about the form/submit behaviour don't each have to supply it) unless an
 *  override says otherwise. */
function makeFetchMock(overrides: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url in overrides) return overrides[url];
    if (url === "/api/secret-entry/prompt") return jsonResponse(200, PROMPT_FIXTURE);
    return jsonResponse(200, {});
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

async function renderSecretEntry(token = TOKEN) {
  await act(async () => {
    root.render(<SecretEntry token={token} />);
  });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function submitButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Submit");
  if (!button) throw new Error('button "Submit" not found');
  return button as HTMLButtonElement;
}

function valueInput(): HTMLInputElement | null {
  return container.querySelector('input[name="secretEntryValue"]');
}

function setValue(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("SecretEntry page empty-value guard (apra-fleet-i9ag.11.15)", () => {
  it("disables Submit while the value is empty, and enables it once a value is typed", async () => {
    vi.stubGlobal("fetch", makeFetchMock().fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      setValue(valueInput()!, "s3cr3t");
    });

    expect(submitButton().disabled).toBe(false);

    await act(async () => {
      setValue(valueInput()!, "");
    });

    expect(submitButton().disabled).toBe(true);
  });

  it("submitting the form with an empty value never issues a request to /api/secret-entry/submit", async () => {
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal("fetch", fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(calls.some((c) => c.url === "/api/secret-entry/submit")).toBe(false);
  });

  it("submitting the form with a non-empty value does issue exactly one request", async () => {
    const { fn, calls } = makeFetchMock({
      "/api/secret-entry/submit": jsonResponse(200, {})
    });
    vi.stubGlobal("fetch", fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    await act(async () => {
      setValue(valueInput()!, "s3cr3t");
    });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    const submitCalls = calls.filter((c) => c.url === "/api/secret-entry/submit");
    expect(submitCalls.length).toBe(1);
    expect(submitCalls[0].body).toEqual({ token: TOKEN, value: "s3cr3t" });
  });
});

describe("SecretEntry page (apra-fleet-i9ag.11.8)", () => {
  it("mounts, POSTs the prompt request with { token }, and renders the returned name + prompt text", async () => {
    const { fn, calls } = makeFetchMock({
      "/api/secret-entry/prompt": jsonResponse(200, { name: "github-pat", prompt: "Enter the PAT" })
    });
    vi.stubGlobal("fetch", fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    const promptCalls = calls.filter((c) => c.url === "/api/secret-entry/prompt");
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0].method).toBe("POST");
    expect(promptCalls[0].body).toEqual({ token: TOKEN });

    expect(container.textContent ?? "").toContain("github-pat");
    expect(container.textContent ?? "").toContain("Enter the PAT");
  });

  it("a 404 on the prompt renders the expired/already-used message and no password input", async () => {
    const { fn } = makeFetchMock({
      "/api/secret-entry/prompt": jsonResponse(404, {})
    });
    vi.stubGlobal("fetch", fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "This entry link has expired or was already used."
    );
    expect(valueInput()).toBeNull();
  });

  it("typing a value and submitting POSTs exactly { token, value } to a root-relative url, then renders success with the input gone", async () => {
    const { fn, calls } = makeFetchMock({
      "/api/secret-entry/prompt": jsonResponse(200, { name: "github-pat", prompt: "Enter the PAT" }),
      "/api/secret-entry/submit": jsonResponse(200, {})
    });
    vi.stubGlobal("fetch", fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    await act(async () => {
      setValue(valueInput()!, SENTINEL);
    });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    const submitCalls = calls.filter((c) => c.url === "/api/secret-entry/submit");
    expect(submitCalls.length).toBe(1);
    expect(submitCalls[0].method).toBe("POST");
    // Root-relative: no scheme, no loopback host, no port -- the same
    // request must work on loopback, a LAN address or a tunnelled port.
    expect(submitCalls[0].url.startsWith("/api/secret-entry/")).toBe(true);
    expect(submitCalls[0].url).not.toMatch(/^[a-z]+:\/\//i);
    expect(submitCalls[0].url).not.toContain("127.0.0.1");
    expect(submitCalls[0].url).not.toMatch(/:\d+/);
    expect(submitCalls[0].body).toEqual({ token: TOKEN, value: SENTINEL });

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Stored");
    expect(valueInput()).toBeNull();
  });

  it("a 422 on submit renders the server error text and keeps the form usable", async () => {
    const { fn } = makeFetchMock({
      "/api/secret-entry/prompt": jsonResponse(200, { name: "github-pat", prompt: "Enter the PAT" }),
      "/api/secret-entry/submit": jsonResponse(422, { error: "value rejected: too short" })
    });
    vi.stubGlobal("fetch", fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    await act(async () => {
      setValue(valueInput()!, "short");
    });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("value rejected: too short");
    expect(valueInput()).not.toBeNull();
  });

  it("a 404 on submit switches to the expired/already-used state", async () => {
    const { fn } = makeFetchMock({
      "/api/secret-entry/prompt": jsonResponse(200, { name: "github-pat", prompt: "Enter the PAT" }),
      "/api/secret-entry/submit": jsonResponse(404, {})
    });
    vi.stubGlobal("fetch", fn);

    await renderSecretEntry();
    await act(async () => {
      await flush();
    });

    await act(async () => {
      setValue(valueInput()!, "some-value");
    });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "This entry link has expired or was already used."
    );
    expect(valueInput()).toBeNull();
  });

  it("NON-LEAKAGE: the submitted value never appears in the DOM, the url, or any console call", async () => {
    const { fn } = makeFetchMock({
      "/api/secret-entry/prompt": jsonResponse(200, { name: "github-pat", prompt: "Enter the PAT" }),
      "/api/secret-entry/submit": jsonResponse(200, {})
    });
    vi.stubGlobal("fetch", fn);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await renderSecretEntry();
      await act(async () => {
        await flush();
      });

      await act(async () => {
        setValue(valueInput()!, SENTINEL);
      });

      const form = container.querySelector("form");
      if (!form) throw new Error("form not found");

      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await flush();
      });

      expect(document.body.innerHTML).not.toContain(SENTINEL);
      expect(window.location.href).not.toContain(SENTINEL);
      expect(window.location.hash).not.toContain(SENTINEL);

      for (const spy of [logSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(SENTINEL);
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
