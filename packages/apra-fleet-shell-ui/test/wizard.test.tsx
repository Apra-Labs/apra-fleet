import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AddMemberWizard } from "../src/pages/members/AddMemberWizard";

// apra-fleet-9h9j.2.3: step navigation, required-field blocking and the
// registerMember-shaped submit body for both member kinds
// (apra-fleet-9h9j.2.2). Same react-dom/client + act rendering pattern as
// test/app.test.tsx and test/members.test.tsx.

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

function findByLabel(label: string): HTMLInputElement | HTMLSelectElement {
  // Only match a <label for="..."> whose full text is exactly the field
  // label (optionally with the required-field " *" suffix) -- a plain
  // startsWith would also match a RadioGroup option's <label> wrapper text
  // (e.g. the "Password" auth-method radio option ahead of the "Password"
  // text field in the remote step).
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

function findRadio(name: string, value: string): HTMLInputElement {
  const radio = container.querySelector(`input[type="radio"][name="${name}"][value="${value}"]`);
  if (!radio) throw new Error(`radio ${name}=${value} not found`);
  return radio as HTMLInputElement;
}

function setValue(field: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement
    ? window.HTMLInputElement.prototype
    : window.HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!button) throw new Error(`button "${label}" not found`);
  button.click();
}

function alertTexts(): string[] {
  return Array.from(container.querySelectorAll('[role="alert"]')).map((el) => el.textContent ?? "");
}

async function renderWizard(onRegistered = vi.fn()) {
  await act(async () => {
    root.render(<AddMemberWizard open onClose={() => {}} onRegistered={onRegistered} />);
  });
  return onRegistered;
}

describe("AddMemberWizard (apra-fleet-9h9j.2.3)", () => {
  it("blocks the Next transition when a required field is blank, naming the field", async () => {
    await renderWizard();

    // Step 1 -> step 2 ("Details") for the default local member kind.
    await act(async () => {
      clickButton("Next");
    });

    await act(async () => {
      clickButton("Next");
    });

    expect(alertTexts().some((t) => t.includes("Friendly name is required"))).toBe(true);
  });

  it("walks the local path and submits a registerMember-shaped body matching a literal object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ text: "registered" })
      })
    );
    const onRegistered = await renderWizard();

    // Step "kind" defaults to local -- advance straight to details.
    await act(async () => {
      clickButton("Next");
    });

    setValue(findByLabel("Friendly name"), "local-box");
    setValue(findByLabel("Work folder"), "/home/work");

    await act(async () => {
      clickButton("Next");
    });

    await act(async () => {
      clickButton("Register");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onRegistered).toHaveBeenCalledTimes(1);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/fleet/register-member");
    expect(JSON.parse(String(init.body))).toEqual({
      friendly_name: "local-box",
      work_folder: "/home/work",
      member_type: "local",
      llm_provider: "claude"
    });
  });

  it("walks the SSH remote path (host/port/user/auth) and submits a matching literal body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ text: "registered" })
      })
    );
    await renderWizard();

    act(() => {
      findRadio("memberKind", "remote").click();
    });

    await act(async () => {
      clickButton("Next");
    });

    // Blank required remote fields block the transition.
    await act(async () => {
      clickButton("Next");
    });
    expect(alertTexts().some((t) => t.includes("Host is required"))).toBe(true);

    setValue(findByLabel("Host"), "10.0.0.5");
    setValue(findByLabel("Port"), "2222");
    setValue(findByLabel("Username"), "deploy");
    setValue(findByLabel("Password"), "s3cret");

    await act(async () => {
      clickButton("Next");
    });

    setValue(findByLabel("Friendly name"), "remote-box");
    setValue(findByLabel("Work folder"), "/srv/work");

    await act(async () => {
      clickButton("Next");
    });

    await act(async () => {
      clickButton("Register");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({
      friendly_name: "remote-box",
      work_folder: "/srv/work",
      member_type: "remote",
      llm_provider: "claude",
      host: "10.0.0.5",
      port: 2222,
      username: "deploy",
      auth_type: "password",
      password: "s3cret"
    });
  });

  it("shows a server submit error on the final step without discarding entered input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: "stub: name already taken" })
      })
    );
    await renderWizard();

    await act(async () => {
      clickButton("Next");
    });
    setValue(findByLabel("Friendly name"), "dup-box");
    setValue(findByLabel("Work folder"), "/home/work");
    await act(async () => {
      clickButton("Next");
    });
    await act(async () => {
      clickButton("Register");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(alertTexts().some((t) => t.includes("stub: name already taken"))).toBe(true);

    // Back to the details step: the entered values must still be there.
    await act(async () => {
      clickButton("Back");
    });
    expect((findByLabel("Friendly name") as HTMLInputElement).value).toBe("dup-box");
    expect((findByLabel("Work folder") as HTMLInputElement).value).toBe("/home/work");
  });
});
