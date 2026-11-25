import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfKbProviders, type KbAnchor } from '../services/knowledge/kb-self.js';
import { HttpKbProvider } from '../services/knowledge/http-provider.js';
import { isSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import { KB_LOCAL_CAPABILITIES } from '../services/knowledge/kb-local-capabilities.js';
import { fleetBuild } from '../services/knowledge/bible-rules.js';

// kb_capabilities: what the calling session's project KB serves, in the shape
// of the KB server's GET /api/kb/capabilities body {contract, routes,
// branch_aware, query_filters?} (memory-contract/v1 spec section 2.9.1).
//
// - HTTP provider: the server's body as it sent it (unknown route names and
//   extra fields kept; a malformed query_filters dropped), NOT the normalized view HttpKbProvider.capabilities()
//   keeps for route gating. A server without the route yields the documented
//   default set; errors map exactly as the capabilities read does.
// - SQLite provider: KB_LOCAL_CAPABILITIES, the same object the sample
//   kb-server answers on GET /api/kb/capabilities.
//
// Both answers also carry fleet's own `fleet_build` field
// ({version, bible_rules}): the build of the fleet server answering, not of
// the KB server. A sprint engine reads it before running kb_bible_commit on a
// kb_maintainer and refuses a build whose bible_rules is older than it needs.
// It overwrites any field of that name in an http server's body.
//
// Read-only: never mutates, never bumps use_count.
export const kbCapabilitiesSchema = z.object({
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbCapabilitiesInput = z.infer<typeof kbCapabilitiesSchema>;

export async function kbCapabilities(_input: KbCapabilitiesInput, anchor?: KbAnchor): Promise<string> {
  const providers = await getSelfKbProviders(anchor);
  const project = providers.project;
  if (project instanceof HttpKbProvider) {
    return JSON.stringify({ ...(await project.capabilitiesBody()), fleet_build: fleetBuild() });
  }
  if (isSqliteProject(project)) {
    return JSON.stringify({ ...KB_LOCAL_CAPABILITIES, fleet_build: fleetBuild() });
  }
  throw new Error('kb_capabilities: the configured KB provider reports no capabilities (only the sqlite and http providers are supported)');
}
