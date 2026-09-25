import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionVcsAuthSchema } from "../../../src/tools/provision-vcs-auth.js";
import { revokeVcsAuthSchema } from "../../../src/tools/revoke-vcs-auth.js";
import { provisionVcsAuth, revokeVcsAuth } from "../src/api/members";

// apra-fleet-9h9j.2.1 review fix: the previous drawer wiring posted only
// {member_id} for provision-vcs-auth/revoke-vcs-auth, which safeParse's
// below reject (`provider` is a bare z.enum with no .optional() on both
// schemas) -- routes/fleet.ts 400s the request BEFORE dispatch, so the
// buttons were dead in every case. This test pins the body api/members.ts
// actually posts against the REAL server-side zod schemas (not a mocked
// fetch's toMatchObject alone), so a future regression back to a bare
// {member_id} body fails here even though members.test.tsx's mocked-fetch
// assertions would stay green.

interface FetchCall {
  url: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function makeFetchMock() {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return jsonResponse(200, { text: `ok:${url}` });
  });
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("members VCS action body shape (apra-fleet-9h9j.2.1)", () => {
  it("a bare {member_id} body fails both real server schemas (proves the bug the fix addresses)", () => {
    expect(provisionVcsAuthSchema.safeParse({ member_id: "member-1" }).success).toBe(false);
    expect(revokeVcsAuthSchema.safeParse({ member_id: "member-1" }).success).toBe(false);
  });

  it("provisionVcsAuth posts a body the real provisionVcsAuthSchema accepts", async () => {
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal("fetch", fn);

    await provisionVcsAuth("member-1", "github");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/fleet/provision-vcs-auth");
    const parsed = provisionVcsAuthSchema.safeParse(calls[0].body);
    expect(parsed.success).toBe(true);
  });

  it("revokeVcsAuth posts a body the real revokeVcsAuthSchema accepts", async () => {
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal("fetch", fn);

    await revokeVcsAuth("member-1", "azure-devops");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/fleet/revoke-vcs-auth");
    const parsed = revokeVcsAuthSchema.safeParse(calls[0].body);
    expect(parsed.success).toBe(true);
  });
});
