import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { listMembers } from "../../../src/tools/list-members.js";
import { Members } from "../src/pages/Members";
import { memberFieldGuards } from "../src/api/members";
import { MEMBERS_A, MEMBERS_B } from "./member-fixtures";

// Drift guard (response direction): the Members screen once typed owner as a
// string while the server emitted {package, ref}; hand-written fixtures kept
// the suite green while the real screen crashed. This test builds the payload
// with the REAL server list_members(format: "json") code path from a registry
// agent that sets every optional field the UI reads, then (1) checks each
// field the UI declares against memberFieldGuards, (2) renders Members.tsx
// from that payload, and (3) checks the hand-written fixtures against the
// same guards. A server-side shape change to a declared field fails here.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { SERVER_AGENT } = vi.hoisted(() => ({
  SERVER_AGENT: {
    id: "drift-1",
    friendlyName: "drift-member",
    agentType: "remote",
    host: "10.0.0.5",
    port: 22,
    username: "fleet",
    authType: "key",
    workFolder: "/srv/work",
    createdAt: "2026-01-01T00:00:00.000Z",
    os: "windows",
    shell: "pwsh7",
    llmProvider: "claude",
    tags: ["gpu"],
    reservedBy: "sprint-7",
    owner: { package: "fleet-sprint", ref: "proj-drift" },
    env: { REGION: "eu-west-1" },
    vcsTokenExpiresAt: "2026-12-31T00:00:00.000Z"
  } as Record<string, unknown>
}));

vi.mock("../../../src/services/registry.js", () => ({
  getAllAgents: () => [SERVER_AGENT]
}));

// Offline: no connection or auth probing (same mocks as tests/list-members.test.ts).
vi.mock("../../../src/services/strategy.js", () => ({
  getStrategy: () => ({
    testConnection: async () => ({ ok: false }),
    execCommand: async () => ({ stdout: "", stderr: "" })
  })
}));
vi.mock("../../../src/providers/index.js", () => ({
  getProvider: () => ({ oauthCredentialFiles: () => [], authEnvVar: undefined })
}));
vi.mock("../../../src/services/cloud-sync.js", () => ({
  syncCloudCache: vi.fn(async () => ({ status: "not-connected" }))
}));

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

async function serverPayload(): Promise<{ members: Array<Record<string, unknown>> }> {
  return JSON.parse(await listMembers({ format: "json" }));
}

function guardFailures(member: Record<string, unknown>): string[] {
  return Object.entries(memberFieldGuards)
    .filter(([field, guard]) => !guard(member[field]))
    .map(([field]) => `${field}=${JSON.stringify(member[field])}`);
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

describe("FleetMember vs real list_members json (drift guard)", () => {
  it("every field the UI declares matches the shape the server emits", async () => {
    const { members } = await serverPayload();
    expect(members).toHaveLength(1);
    expect(guardFailures(members[0])).toEqual([]);
  });

  it("renders Members.tsx from the real server payload without crashing", async () => {
    const payload = await serverPayload();
    const server = payload.members[0];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, payload)));

    await act(async () => {
      root.render(<Members />);
    });

    const cells = Array.from(container.querySelectorAll("tbody tr td")).map((td) => td.textContent);
    expect(cells[0]).toBe("drift-member");
    // Compare against the raw server values, not the UI's own formatter, so
    // the assertion holds for whichever fields this server build emits.
    expect(cells[2]).toBe(typeof server.shell === "string" ? server.shell : "-");
    const owner = server.owner as { package: string; ref: string } | undefined;
    expect(cells[7]).toBe(owner ? `${owner.package}@${owner.ref}` : "(none)");
  });

  it("the hand-written Members fixtures satisfy the same guards", () => {
    for (const member of [...MEMBERS_A.members, ...MEMBERS_B.members]) {
      expect(guardFailures(member)).toEqual([]);
    }
  });

  it("a drifted owner shape (plain string) is rejected by the guard", () => {
    const drifted = { ...MEMBERS_A.members[0], owner: "alice@example.com" };
    expect(guardFailures(drifted)).toEqual(['owner="alice@example.com"']);
  });
});
