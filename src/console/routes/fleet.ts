/**
 * Fleet console routes (apra-fleet-v6t7.2.1).
 *
 * This sprint registers GET /api/fleet/members ONLY -- the Members screen's
 * data source. Later sprints add their endpoints by appending to the table
 * below (or by adding their own module next to this one and one line to
 * ROUTE_MODULES in ../server.ts); they do not edit the seam's dispatch.
 *
 * Handlers read through ../local-api.js (in-process tool handlers), never by
 * calling the server's own HTTP surface.
 */
import type { ConsoleRoute } from '../server.js';
import { getMembersJson } from '../local-api.js';

export const fleetRoutes: ConsoleRoute[] = [
  {
    method: 'GET',
    path: '/api/fleet/members',
    handler: async (_req, res) => {
      const body = await getMembersJson();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    },
  },
];
