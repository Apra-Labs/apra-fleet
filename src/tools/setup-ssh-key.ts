import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { updateAgent, getKeysDir } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import { getOsCommands } from '../os/index.js';
import type { Agent } from '../types.js';

export const setupSSHKeySchema = z.object({
  member_id: z.string().describe('The UUID of the member (worker) to set up SSH key auth for'),
});

export type SetupSSHKeyInput = z.infer<typeof setupSSHKeySchema>;

/**
 * Convert an RSA public key (PEM) to OpenSSH authorized_keys format.
 * Uses JWK export to extract modulus (n) and exponent (e), then builds
 * the ssh-rsa wire format per RFC 4253.
 */
function rsaPublicKeyToOpenSSH(publicKeyPem: string, comment: string): string {
  const keyObj = crypto.createPublicKey(publicKeyPem);
  const jwk = keyObj.export({ format: 'jwk' }) as { n?: string; e?: string };

  const e = Buffer.from(jwk.e!, 'base64url');
  const n = Buffer.from(jwk.n!, 'base64url');

  const typeStr = 'ssh-rsa';
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(typeStr.length);

  // Leading zero byte needed if high bit is set (to avoid being interpreted as negative)
  const ePadded = (e[0] & 0x80) ? Buffer.concat([Buffer.from([0]), e]) : e;
  const eLen = Buffer.alloc(4);
  eLen.writeUInt32BE(ePadded.length);

  const nPadded = (n[0] & 0x80) ? Buffer.concat([Buffer.from([0]), n]) : n;
  const nLen = Buffer.alloc(4);
  nLen.writeUInt32BE(nPadded.length);

  const blob = Buffer.concat([typeLen, Buffer.from(typeStr), eLen, ePadded, nLen, nPadded]);
  return `ssh-rsa ${blob.toString('base64')} ${comment}`;
}

export async function setupSSHKey(input: SetupSSHKeyInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  if (agent.agentType === 'local') {
    return `❌ SSH key setup is not applicable for local members. Member "${agent.friendlyName}" runs on the same machine — no SSH authentication is needed.`;
  }

  if (agent.authType === 'key') {
    return `Member "${agent.friendlyName}" is already using key-based authentication.`;
  }

  const keysDir = getKeysDir();
  const keyName = `${agent.id}_rsa`;
  const privateKeyPath = path.join(keysDir, keyName);
  const publicKeyPath = `${privateKeyPath}.pub`;

  const strategy = getStrategy(agent);

  // Step 1: Generate RSA-4096 key pair using Node crypto (no external tools needed)
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });

    // Convert to OpenSSH authorized_keys format
    const comment = `apra-fleet-${agent.friendlyName}`;
    const opensshPubKey = rsaPublicKeyToOpenSSH(publicKey, comment);

    fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, opensshPubKey, { mode: 0o644 });

    // Step 2: Deploy public key to remote using OS-specific commands
    const cmds = getOsCommands(agent.os ?? 'linux');
    const deployCommands = cmds.deploySSHPublicKey(opensshPubKey);

    for (const cmd of deployCommands) {
      const result = await strategy.execCommand(cmd, 10000);
      if (result.code !== 0) {
        return `❌ Failed to deploy key to "${agent.friendlyName}": ${result.stderr}`;
      }
    }

    // Step 3: Test key-based login before committing the change
    const testAgent = { ...agent, authType: 'key' as const, keyPath: privateKeyPath, encryptedPassword: undefined };
    const testStrategy = getStrategy(testAgent);
    try {
      const testResult = await testStrategy.execCommand('echo "key-auth-ok"', 10000);
      if (!testResult.stdout.includes('key-auth-ok')) {
        return `❌ Key-based authentication test failed for "${agent.friendlyName}". Password auth is still active.`;
      }
    } catch (err: any) {
      return `❌ Key-based authentication test failed: ${err.message}. Password auth is still active.`;
    }

    // Step 4: Update agent registration (only after successful verification)
    updateAgent(agent.id, {
      authType: 'key',
      keyPath: privateKeyPath,
      encryptedPassword: undefined,
    });

    let result = `✅ SSH key authentication set up for "${agent.friendlyName}"\n\n`;
    result += `  Private key: ${privateKeyPath}\n`;
    result += `  Public key:  ${publicKeyPath}\n`;
    result += `  Auth type:   key (updated from password)\n`;
    result += `  Verification: Key-based login successful\n`;

    return result;
  } catch (err: any) {
    return `❌ Failed to set up SSH key: ${err.message}`;
  }
}
