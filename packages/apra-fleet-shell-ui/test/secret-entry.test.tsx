import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SecretEntry } from "../src/pages/SecretEntry";

// apra-fleet-i9ag.11.15: client-side empty-value guard for the secret-entry
// page, on top of the SecretEntry page added by apra-fleet-i9ag.11.7. Same
// react-dom/client + act rendering pattern as test/secrets.test.tsx. Full
// routing and non-leakage coverage for this page lives in the still-open
// apra-fleet-i9ag.11.8 (streak i9ag11-shell-route-test); this file covers
// only the empty-value guard so it can land ahead of that task without
// duplicating its scope.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROMPT_FIXTURE = { name: "github-pat", prompt: "Enter the GitHub PAT" };

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

interface FetchCall {
  url: string;
  body: unknown;
}

function makeFetchMock(overrides: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
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

async function renderSecretEntry(token = "abc123") {
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

function valueInput(): HTMLInputElement {
  const input = container.querySelector('input[name="secretEntryValue"]');
  if (!input) throw new Error("secret value input not found");
  return input as HTMLInputElement;
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
      setValue(valueInput(), "s3cr3t");
    });

    expect(submitButton().disabled).toBe(false);

    await act(async () => {
      setValue(valueInput(), "");
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
      setValue(valueInput(), "s3cr3t");
    });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    const submitCalls = calls.filter((c) => c.url === "/api/secret-entry/submit");
    expect(submitCalls.length).toBe(1);
    expect(submitCalls[0].body).toEqual({ token: "abc123", value: "s3cr3t" });
  });
});
