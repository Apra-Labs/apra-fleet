/**
 * Workflow-package console routes (apra-fleet-iywi.3.2).
 *
 * Thin HTTP adapter over src/services/workflow-packages.ts -- handlers read
 * and mutate through the service; they never re-implement storage and never
 * call the server's own HTTP surface. These are /api paths, so they sit
 * behind the console guard (../server.ts's requiresConsoleGuard) purely by
 * virtue of being registered in ROUTE_MODULES -- no guard edit needed here.
 */
import type http from 'node:http';
import type { ConsoleRoute } from '../server.js';
import { workflowPackageService } from '../../services/workflow-packages.js';

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export const workflowPackagesRoutes: ConsoleRoute[] = [
  {
    method: 'POST',
    path: '/api/workflow-packages/register',
    handler: async (req, res) => {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON body' });
        return;
      }

      const { id, baseUrl, apraFleetApi } = (body ?? {}) as Record<string, unknown>;
      if (
        typeof id !== 'string' || id === '' ||
        typeof baseUrl !== 'string' || baseUrl === '' ||
        typeof apraFleetApi !== 'string' || apraFleetApi === ''
      ) {
        jsonResponse(res, 400, { error: 'id, baseUrl and apraFleetApi are required non-empty strings' });
        return;
      }

      const result = await workflowPackageService.register({ id, baseUrl, apraFleetApi });
      if (result.ok) {
        jsonResponse(res, 200, { ok: true });
        return;
      }
      // A malformed range is a client mistake (400); a well-formed range
      // that just doesn't match the server version is the documented 409.
      const status = result.reason === 'invalid-range' ? 400 : 409;
      jsonResponse(res, status, { error: result.message });
    },
  },
  {
    // Parameterised route (apra-fleet-iywi.3.2's matcher extension) -- see
    // ../server.ts's matchRoutes(). Never shadows the literal
    // /api/workflow-packages/register route above: literal matches are
    // always tried first.
    method: 'DELETE',
    path: '/api/workflow-packages/:id',
    handler: async (_req, res, _context, params) => {
      const result = await workflowPackageService.unregister(params.id);
      if (result.ok) {
        jsonResponse(res, 200, { ok: true });
        return;
      }
      if (result.reason === 'not-found') {
        jsonResponse(res, 404, { error: 'not found' });
        return;
      }
      jsonResponse(res, 409, { error: 'a config-declared package cannot be unregistered' });
    },
  },
  {
    method: 'GET',
    path: '/api/workflow-packages',
    handler: async (_req, res) => {
      // refreshHealth() never throws (see the service's probeOne) -- a
      // failing poll degrades that package's health record, never this
      // route's response.
      await workflowPackageService.refreshHealth();
      jsonResponse(res, 200, { packages: workflowPackageService.list() });
    },
  },
];
