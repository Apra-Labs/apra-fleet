// Thin fetch wrapper over the fleet-supervisor's own GET /api/health,
// reached through the console's /ext/<package id>/* proxy
// (src/console/proxy.ts), which forwards a derived upstream credential on
// every hop -- there is no second, unguarded health surface on the
// supervisor. Its own module, separate from health.ts/secrets.ts/
// members.ts, per this area's file-ownership convention (see the header
// comment on ./health.ts, which records that rule).

import { extSrc } from "./workflow-packages";

/** The workflow-package id the fleet-supervisor registers as (see
 *  PACKAGE_ID in packages/apra-fleet-se/src/registration/manifest.mjs).
 *  The shell-ui package has no build-time dependency on apra-fleet-se, so
 *  the literal is restated here once, matching the WorkflowPackageView
 *  shape restatement rule documented in ./workflow-packages.ts. */
export const SUPERVISOR_PACKAGE_ID = "se";

/**
 * The three distinguishable states of the supervisor's resolved project
 * folder (apra-fleet-i9ag.17.3):
 *  - `configured`: the supervisor answered and resolved a project folder;
 *    `source` is one of the precedence sources (flag/config/walk-up -- see
 *    PROJECT_DIR_SOURCE in
 *    packages/apra-fleet-se/src/supervisor/beads-identity.mjs) but rendered
 *    verbatim, never re-derived, so a shell that does not recognize a
 *    future source value still shows it rather than hiding it.
 *  - `not-configured`: the supervisor answered and explicitly resolved no
 *    project folder (`projectDir: null` in its payload).
 *  - `unknown`: the supervisor was unreachable, OR its payload predates
 *    this field entirely (an older supervisor). The shell cannot tell
 *    those two apart and must not guess which one happened.
 */
export type SupervisorProjectState =
  | { kind: "configured"; projectDir: string; source: string }
  | { kind: "not-configured" }
  | { kind: "unknown" };

/** Mirrors the `projectDir`/`projectDirSource` fields GET /api/health adds
 *  alongside `beads`/`beadsWarning`
 *  (packages/apra-fleet-se/src/supervisor/server.mjs) -- only what this
 *  reader needs. Both optional here only so this type still accepts a
 *  payload from an older supervisor that predates the fields entirely. */
interface SupervisorHealthPayload {
  projectDir?: string | null;
  projectDirSource?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Fetches the supervisor's resolved-project state through the console
 * proxy and classifies it into one of the three states above. Never
 * throws: a network failure, a non-2xx response, or an unparseable body
 * all degrade to `unknown` so a supervisor outage only ever affects this
 * one Health row -- matching the "404/network failure is expected" contract
 * ./workflow-packages.ts already uses for the registry fetch.
 */
export async function fetchSupervisorProjectState(): Promise<SupervisorProjectState> {
  let response: Response;
  try {
    response = await fetch(extSrc(SUPERVISOR_PACKAGE_ID, "/api/health"));
  } catch {
    return { kind: "unknown" };
  }
  if (!response.ok) return { kind: "unknown" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "unknown" };
  }
  if (!isRecord(payload) || !("projectDir" in payload)) {
    // Key absent entirely (as opposed to present-and-null): an older
    // supervisor whose payload predates this field.
    return { kind: "unknown" };
  }

  const typed = payload as SupervisorHealthPayload;
  if (typed.projectDir === null || typed.projectDir === undefined) {
    return { kind: "not-configured" };
  }
  const source = typeof typed.projectDirSource === "string" ? typed.projectDirSource : "unknown";
  return { kind: "configured", projectDir: typed.projectDir, source };
}
