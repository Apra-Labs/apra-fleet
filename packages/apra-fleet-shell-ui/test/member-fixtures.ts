import type { FleetMember } from "../src/api/members";

// Shared list_members(format: "json") fixtures for the Members screen tests.
// Shapes follow the REAL server output (src/tools/list-members.ts): owner is
// an {package, ref} object, env a name -> value map. list-members-drift.test.tsx
// checks every fixture here against memberFieldGuards, and checks those same
// guards against the live server output, so a fixture can no longer certify
// a shape the server does not emit.

export const MEMBERS_A: { members: FleetMember[] } = {
  members: [
    {
      id: "member-1",
      name: "alpha",
      type: "worker",
      os: "linux",
      shell: "gitbash",
      llmProvider: "anthropic",
      llm_auth: "ok",
      tags: ["core", "gpu"],
      reservedBy: "sprint-42",
      owner: { package: "fleet-sprint", ref: "proj-alpha" },
      env: { REGION: "us-east-1" },
      vcsTokenExpiresAt: "2026-12-31T00:00:00.000Z"
    },
    {
      id: "member-2",
      name: "beta",
      type: "orchestrator",
      os: "windows",
      llmProvider: "openai",
      llm_auth: "expired",
      tags: null,
      reservedBy: null
    }
  ]
};

export const MEMBERS_B: { members: FleetMember[] } = {
  members: [
    {
      id: "member-3",
      name: "gamma",
      type: "worker",
      os: "macos",
      llmProvider: "claude",
      llm_auth: "ok",
      tags: null,
      reservedBy: null
    }
  ]
};
