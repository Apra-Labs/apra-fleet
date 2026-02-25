import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { updateAgent, getKeysDir } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const setupSSHKeySchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to set up SSH key auth for'),
});

export type SetupSSHKeyInput = z.infer<typeof setupSSHKeySchema>;

export async function setupSSHKey(input: SetupSSHKeyInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  if (agent.agentType === 'local') {
    return `❌ SSH key setup is not applicable for local agents. Agent "${agent.friendlyName}" runs on the same machine — no SSH authentication is needed.`;
  }

  if (agent.authType === 'key') {
    return `Agent "${agent.friendlyName}" is already using key-based authentication.`;
  }

  const keysDir = getKeysDir();
  const keyName = `${agent.id}_rsa`;
  const privateKeyPath = path.join(keysDir, keyName);
  const publicKeyPath = `${privateKeyPath}.pub`;

  const strategy = getStrategy(agent);

  // Step 1: Generate RSA-4096 key pair
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Convert public key to OpenSSH format for authorized_keys
    const keyObj = crypto.createPublicKey(publicKey);
    const sshPubKey = keyObj.export({ type: 'spki', format: 'der' });
    const sshPubKeyB64 = sshPubKey.toString('base64');
    const openSSHPubKey = `ssh-rsa ${sshPubKeyB64} claude-fleet-${agent.friendlyName}`;

    fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, openSSHPubKey);

    // Step 2: Deploy public key to remote
    const deployCommands = [
      'mkdir -p ~/.ssh',
      'chmod 700 ~/.ssh',
      'touch ~/.ssh/authorized_keys',
      'chmod 600 ~/.ssh/authorized_keys',
      `echo '${openSSHPubKey}' >> ~/.ssh/authorized_keys`,
    ];

    for (const cmd of deployCommands) {
      const result = await strategy.execCommand(cmd, 10000);
      if (result.code !== 0) {
        return `❌ Failed to deploy key to "${agent.friendlyName}": ${result.stderr}`;
      }
    }

    // Step 3: Test key-based login
    const testAgent = { ...agent, authType: 'key' as const, keyPath: privateKeyPath, encryptedPassword: undefined };
    const testStrategy = getStrategy(testAgent);
    try {
      const testResult = await testStrategy.execCommand('echo "key-auth-ok"', 10000);
      if (!testResult.stdout.includes('key-auth-ok')) {
        return `❌ Key-based authentication test failed for "${agent.friendlyName}".`;
      }
    } catch (err: any) {
      return `❌ Key-based authentication test failed: ${err.message}. Password auth is still active.`;
    }

    // Step 4: Update agent registration
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
