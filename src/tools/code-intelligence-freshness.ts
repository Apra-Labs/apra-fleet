// Pure comparison function for F2.2 freshness metadata. No IO here -- fully
// unit-testable in isolation. Kept in its own module (rather than
// code-intelligence.ts) so code-intelligence-gitnexus.ts can import it as a
// value without creating a circular import (code-intelligence.ts already
// imports GitNexusProvider from code-intelligence-gitnexus.ts).
//
// Returns null when either SHA is missing or they match; otherwise the
// verbatim freshness note (first 8 chars of each SHA) that callGitNexus
// appends to a tool response when the gitnexus index is behind repo HEAD.
export function freshnessNote(lastCommit: string | undefined, head: string | undefined): string | null {
  if (!lastCommit || !head) return null;
  if (lastCommit === head) return null;
  const shortLastCommit = lastCommit.slice(0, 8);
  const shortHead = head.slice(0, 8);
  return `[code-intelligence] index is behind repo HEAD (indexed ${shortLastCommit} vs HEAD ${shortHead}). Results may miss recent changes; run 'npx gitnexus analyze' to refresh.`;
}
