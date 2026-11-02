/**
 * The LLM-facing vcs_credential_exec text (tool description, `command` schema
 * description, and the apra-fleet-client JSDoc that mirrors them) must state
 * the current Bitbucket rule: REST takes the token as a Bearer value, the git
 * username is the fixed x-bitbucket-api-token-auth, and no email is used. An
 * agent following a stale "basic auth user:token" hint builds a REST call
 * that gets a 401.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vcsCredentialExecSchema } from '../src/tools/vcs-credential-exec.js';

const root = join(__dirname, '..');

function registryDescription(): string {
  const src = readFileSync(join(root, 'src/services/tool-registry.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes("server.tool('vcs_credential_exec'"));
  expect(line, 'vcs_credential_exec registration line').toBeTruthy();
  return line as string;
}

function clientDoc(): string {
  return readFileSync(join(root, 'packages/apra-fleet-client/src/client/api.mjs'), 'utf8');
}

const texts: Array<[string, () => string]> = [
  ['tool-registry description', registryDescription],
  ['command schema description', () => vcsCredentialExecSchema.shape.command.description ?? ''],
  ['apra-fleet-client api.mjs', clientDoc],
];

describe('vcs_credential_exec LLM-facing text states the Bitbucket Bearer rule', () => {
  for (const [name, get] of texts) {
    it(`${name}: Bearer REST, fixed git username, no email, no basic user:token`, () => {
      const t = get();
      expect(t).toContain('Authorization: Bearer {{vcs_token_inline}}');
      expect(t).toContain('x-bitbucket-api-token-auth');
      expect(t).toMatch(/no email/);
      expect(t).not.toMatch(/basic[- ]auth/i);
      expect(t).not.toContain('user:token');
    });
  }
});
