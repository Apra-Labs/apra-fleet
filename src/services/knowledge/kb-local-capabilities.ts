import { KB_REQUIRED_ROUTES, KB_OPTIONAL_ROUTES } from './http-provider.js';

/**
 * The capabilities a local SQLite KB implements, in the shape of the
 * GET /api/kb/capabilities body (memory-contract/v1 spec section 2.9.1):
 * every contract route (demote and withdraw included), no per-branch truth,
 * and the optional kb_query filters the local query honours (the cited
 * filter: files, symbols).
 *
 * One constant for both answers: the sample kb-server (src/commands/kb-server.ts,
 * which always serves a local SQLite KB) answers GET /api/kb/capabilities with
 * it, and kb_capabilities returns it for a SQLite project KB, so the two can
 * never drift. routes is derived from KB_REQUIRED_ROUTES + KB_OPTIONAL_ROUTES
 * (the contract route list), so a route added there is served here too.
 */
export const KB_LOCAL_CAPABILITIES = Object.freeze({
  contract: 'v1',
  routes: Object.freeze([...KB_REQUIRED_ROUTES, ...KB_OPTIONAL_ROUTES]),
  branch_aware: false,
  // The optional kb_query filters the local query honours (the cited filter).
  query_filters: Object.freeze(['files', 'symbols']),
});
