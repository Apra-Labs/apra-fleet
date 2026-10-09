// The kb_maintainer grant, as seen from inside a kb_* tool handler.
//
// A MEMBER session carries the grant only when the engine opened it as a
// repository's kb_maintainer (origin=engine&kb_maintainer=1, see
// src/services/tool-scope.ts). Tool exposure (member-tool-allowlist.ts) keeps
// the CONFIRMED-minting tools off every other member session; this module is
// for the tools every member session IS served but whose particular input can
// mint or retire CONFIRMED (kb_import with an explicit path, kb_invalidate of a
// CONFIRMED entry). Like the grant itself it is a routing guard that keeps agent
// sessions off those paths, not a security boundary against a local process
// (which can open a FULL session).

import { getSessionKbMaintainer, getSessionMemberId } from '../tool-scope.js';
import type { KbAnchor } from './kb-self.js';

export type KbMaintainerGrantErrorCode = 'E-KB-MAINTAINER-REQUIRED';

export class KbMaintainerGrantError extends Error {
  readonly code: KbMaintainerGrantErrorCode;
  readonly remediation: string;
  constructor(problem: string, remediation: string) {
    super(`E-KB-MAINTAINER-REQUIRED: ${problem} Remediation: ${remediation}`);
    this.name = 'KbMaintainerGrantError';
    this.code = 'E-KB-MAINTAINER-REQUIRED';
    this.remediation = remediation;
  }
}

/**
 * True when the executing tool call comes from a MEMBER session that does NOT
 * carry the kb_maintainer grant. False for a FULL session, for an in-process
 * caller passing an explicit KbAnchor (same predicate as memberOwnerTag), and
 * for the kb_maintainer member session.
 */
export function memberLacksKbMaintainer(anchor?: KbAnchor): boolean {
  if (anchor !== undefined) return false;
  return getSessionMemberId() !== undefined && !getSessionKbMaintainer();
}
