import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "../src/ErrorBoundary";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new Error("Objects are not valid as a React child");
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // React logs caught render errors to console.error; keep the output quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders an error message instead of a blank screen when a child throws", async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("This screen failed to render.");
    expect(alert?.textContent).toContain("Objects are not valid as a React child");
  });

  it("renders its children unchanged when nothing throws", async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <p>fine</p>
        </ErrorBoundary>
      );
    });

    expect(container.textContent).toBe("fine");
  });
});
