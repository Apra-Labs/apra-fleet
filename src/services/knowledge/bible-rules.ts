import { serverVersion } from '../../version.js';

/**
 * Revision of the bible format and the kb_bible_commit rules this build
 * implements (tombstone kinds, which ids a commit may write or clear, the
 * basis rule). A sprint engine refuses to run a bible commit on a kb_maintainer
 * whose installed server reports a LOWER revision (or none): the commit runs in
 * that member's installed server, which can be older than the sprint's source,
 * and an older build writes bibles the newer rules forbid.
 *
 * Bump it with every change to the bible format or the kb_bible_commit /
 * kb_import tombstone rules, and bump the engine's
 * REQUIRED_MAINTAINER_BIBLE_RULES (packages/apra-fleet-se/fleet-sprint/kb.mjs)
 * with it -- tests/knowledge/kb-capabilities-tool.test.ts keeps the two equal.
 * A version string alone cannot order two builds of one core version.
 *
 * Revisions: 1 = tombstone kinds and the HEAD basis rule; 2 = kb_bible_commit
 * builds from the bible committed at HEAD (never the work-tree file) and
 * records only the blob it committed as trusted.
 */
export const BIBLE_RULES_REVISION = 2;

/**
 * This server's build identity, reported by kb_capabilities as `fleet_build`:
 * the version string (core version plus a dev commit suffix) and the bible
 * rules revision.
 */
export function fleetBuild(): { version: string; bible_rules: number } {
  return { version: serverVersion, bible_rules: BIBLE_RULES_REVISION };
}
