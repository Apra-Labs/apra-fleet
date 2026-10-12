import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMembers } from "../src/api/members";
import { fetchFleetStatus } from "../src/api/health";
import { listCredentials } from "../src/api/secrets";
import { fetchWorkflowPackages, extSrc } from "../src/api/workflow-packages";
import { fetchSupervisorProjectState } from "../src/api/supervisor-health";

// apra-fleet-o9nv.2: with the shell served under a reverse-proxy sub-path,
// every API/ext request is prefixed with that sub-path; at the root mount
// the URLs are unchanged.

function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ members: [], credentials: [], packages: [] }) };
  });
  return urls;
}

async function exerciseAll(): Promise<void> {
  await Promise.allSettled([
    fetchMembers(),
    fetchFleetStatus(),
    listCredentials(),
    fetchWorkflowPackages(),
    fetchSupervisorProjectState()
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("console mount path (o9nv.2)", () => {
  it("under /fleet/ui/ every request is prefixed with /fleet", async () => {
    window.history.pushState({}, "", "/fleet/ui/");
    const urls = stubFetch();
    await exerciseAll();
    expect(urls.length).toBeGreaterThanOrEqual(5);
    for (const u of urls) expect(u).toMatch(/^\/fleet\/(api|ext)\//);
    expect(extSrc("se", "/ui/x")).toBe("/fleet/ext/se/ui/x");
  });

  it("under /ui/ URLs are unchanged from the root mount", async () => {
    window.history.pushState({}, "", "/ui/");
    const urls = stubFetch();
    await exerciseAll();
    expect(urls.length).toBeGreaterThanOrEqual(5);
    for (const u of urls) expect(u).toMatch(/^\/(api|ext)\//);
    expect(urls).toContain("/api/fleet/members");
    expect(urls).toContain("/api/fleet/status");
    expect(urls).toContain("/api/fleet/credential-store-list");
    expect(extSrc("se", "/ui/x")).toBe("/ext/se/ui/x");
  });
});
