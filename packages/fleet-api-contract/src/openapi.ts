import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

import { JWTClaimsSchema } from './schemas/jwt.js';
import { WorkspaceSchema } from './schemas/workspace.js';
import { ProjectSchema } from './schemas/project.js';
import { MemberSchema, MemberTokenResponseSchema } from './schemas/member.js';
import { ActivityEventSchema } from './schemas/activity.js';
import { UsageRecordSchema, CostResponseSchema } from './schemas/usage.js';
import { InstallerSchema } from './schemas/installer.js';
import { AdminUserSchema } from './schemas/admin-user.js';
import { Endpoints } from './endpoints.js';

/**
 * Builds the OpenAPI 3.1 document from the SAME Zod schemas exported by this
 * package -- no hand-written/dual-maintained spec. `JWTClaims` is registered
 * once and reused everywhere via `bearerAuth`, matching its role as the
 * anchor schema.
 */
export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();

  registry.register('JWTClaims', JWTClaimsSchema);
  registry.register('Workspace', WorkspaceSchema);
  registry.register('Project', ProjectSchema);
  registry.register('Member', MemberSchema);
  registry.register('MemberTokenResponse', MemberTokenResponseSchema);
  registry.register('ActivityEvent', ActivityEventSchema);
  registry.register('UsageRecord', UsageRecordSchema);
  registry.register('CostResponse', CostResponseSchema);
  registry.register('Installer', InstallerSchema);
  registry.register('AdminUser', AdminUserSchema);

  const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Workspace-scoped member JWT; claims validated against JWTClaims.',
  });

  for (const [route, def] of Object.entries(Endpoints)) {
    const [method, path] = route.split(' ') as [string, string];
    const openapiPath = path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
    const responseSchema = (def as { response: z.ZodTypeAny }).response;
    const requestSchema = (def as { request?: z.ZodTypeAny }).request;

    registry.registerPath({
      method: method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete' | 'put',
      path: openapiPath,
      summary: def.summary,
      security: def.auth ? [{ [bearerAuth.name]: [] }] : [],
      request: requestSchema
        ? { body: { content: { 'application/json': { schema: requestSchema } } } }
        : undefined,
      responses: {
        200: {
          description: def.summary,
          content: { 'application/json': { schema: responseSchema } },
        },
      },
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'apra-fleet hub <-> dashboard API',
      version: '0.1.0',
      description:
        'Contract for fleet.apralabs.com. JWTClaims (the ws/workspace_id claim) is the ' +
        'anchor schema -- every workspace-scoped route is gated behind it.',
    },
    servers: [{ url: 'https://fleet.apralabs.com' }],
  });
}
