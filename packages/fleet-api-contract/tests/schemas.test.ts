import { describe, expect, it } from 'vitest';
import {
  JWTClaimsSchema,
  RoleSchema,
  WorkspaceSchema,
  ProjectSchema,
  MemberSchema,
  ProviderSchema,
  UsageRecordSchema,
  ActivityEventSchema,
  InstallerSchema,
  AdminUserSchema,
  Endpoints,
} from '../src/index.js';

describe('JWTClaims (anchor schema)', () => {
  it('accepts a well-formed workspace-scoped token', () => {
    const claims = {
      iss: 'https://fleet.apralabs.com',
      ws: 'ws_apra',
      sub: 'member-uuid-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      role: 'member',
    };
    expect(JWTClaimsSchema.parse(claims)).toEqual(claims);
  });

  it('rejects a token missing the ws (workspace_id) hard-scope claim', () => {
    const claims = {
      iss: 'https://fleet.apralabs.com',
      sub: 'member-uuid-1',
      exp: 123,
      role: 'member',
    };
    expect(() => JWTClaimsSchema.parse(claims)).toThrow();
  });

  it('rejects an unknown role', () => {
    expect(() => RoleSchema.parse('root')).toThrow();
  });
});

describe('Member (provider must include "none" per us9.14)', () => {
  it('accepts a no-LLM executor member', () => {
    expect(ProviderSchema.parse('none')).toBe('none');
    const member = {
      id: 'dave',
      name: 'dave',
      provider: 'none',
      model: null,
      machine: 'gcp-e2-std',
      folder: '/srv/fleet/exec',
      status: 'online',
      lastSeen: 11,
      lastPrompt: null,
      lastPromptAt: null,
      tags: ['executor', 'devops'],
      jwtExp: 40 * 86400,
      agentVer: '1.4.2',
      reservedBy: null,
    };
    expect(MemberSchema.parse(member)).toEqual(member);
  });
});

describe('Workspace / Project / Usage / Activity / Installer / AdminUser', () => {
  it('parses a workspace', () => {
    WorkspaceSchema.parse({ id: 'ws_apra', name: 'apra-labs', role: 'admin', members: 8, projects: 3 });
  });

  it('parses a project with no repository field (contract requirement)', () => {
    const project = {
      id: 'apollo',
      name: 'apollo',
      desc: 'cost-aware dashboard for fleet ops',
      status: 'active',
      members: ['alice', 'bob'],
      lastActivity: 18,
    };
    expect(ProjectSchema.parse(project)).toEqual(project);
    expect('repository' in ProjectSchema.shape).toBe(false);
  });

  it('parses a usage record', () => {
    UsageRecordSchema.parse({ project: 'apollo', member: 'alice', tokens: 142300, cost: 3.21 });
  });

  it('parses an activity event', () => {
    ActivityEventSchema.parse({ t: 18, member: 'alice', project: 'apollo', kind: 'prompt', text: 'wire the cost rollup endpoint' });
  });

  it('parses an installer', () => {
    InstallerSchema.parse({ os: 'macOS', arch: 'arm64 · x64', file: 'apra-fleet-1.4.2.pkg', cmd: 'brew install apra-labs/tap/apra-fleet' });
  });

  it('parses an admin user', () => {
    AdminUserSchema.parse({
      id: 'u1',
      name: 'Alice',
      email: 'alice@example.com',
      status: 'pending',
      workspaces: [],
      signedUpAt: 120,
      lastLoginAt: null,
    });
  });
});

describe('Endpoints map covers the README API sketch', () => {
  it('has an entry for every documented route', () => {
    expect(Object.keys(Endpoints)).toEqual(
      expect.arrayContaining([
        'POST /auth/oauth/:provider',
        'GET /workspaces',
        'POST /workspaces',
        'GET /ws/:id/projects',
        'POST /ws/:id/projects',
        'POST /ws/:id/projects/:pid/members',
        'GET /ws/:id/members',
        'POST /ws/:id/members',
        'POST /ws/:id/members/:mid/rotate',
        'GET /ws/:id/activity',
        'GET /ws/:id/cost',
        'GET /admin/users',
        'DELETE /admin/users/:id',
        'GET /installers',
      ]),
    );
  });

  it('every auth-gated route request references JWTClaimsSchema (not an ad-hoc shape)', () => {
    for (const [route, def] of Object.entries(Endpoints)) {
      if ((def as { auth: boolean }).auth) {
        const request = (def as { request?: { shape?: Record<string, unknown> } }).request;
        expect(request, `${route} is auth-gated but has no request schema`).toBeDefined();
        expect(request!.shape).toHaveProperty('auth');
      }
    }
  });
});
