/**
 * Smoke test for core services.
 * Run: npm run smoke
 *
 * Tests:
 * 1. Crypto: encrypt/decrypt round-trip
 * 2. Registry: add agent, read back, verify JSON, remove agent
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptPassword, decryptPassword } from './utils/crypto.js';
import { addAgent, getAgent, getAllAgents, removeAgent } from './services/registry.js';
import type { Agent } from './types.js';
import { FLEET_DIR } from './paths.js';

const REGISTRY_PATH = path.join(FLEET_DIR, 'registry.json');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

console.log('=== Smoke Test: Apra Fleet ===\n');

// --- Test 1: Crypto ---
console.log('1. Crypto (AES-256-GCM encrypt/decrypt)');
try {
  const original = 'my-ssh-password-123!@#';
  const encrypted = encryptPassword(original);
  const decrypted = decryptPassword(encrypted);

  console.log(`   Plaintext:  ${original}`);
  console.log(`   Encrypted:  ${encrypted}`);
  console.log(`   Decrypted:  ${decrypted}`);

  assert(decrypted === original, 'Decrypt matches original');
  assert(encrypted !== original, 'Encrypted is not plaintext');
  assert(encrypted.split(':').length === 3, 'Encrypted has 3 parts (iv:tag:data)');
} catch (err: any) {
  console.log(`  ❌ Crypto test threw: ${err.message}`);
  failed++;
}

console.log();

// --- Test 2: Registry CRUD ---
console.log('2. Registry CRUD');
try {
  const testAgent: Agent = {
    id: 'smoke-test-agent-001',
    friendlyName: 'smoke-test-server',
    agentType: 'remote',
    host: '10.0.0.99',
    port: 22,
    username: 'smokeuser',
    authType: 'password',
    encryptedPassword: encryptPassword('smokepass'),
    workFolder: '/home/smokeuser/project',
    os: 'linux',
    createdAt: new Date().toISOString(),
  };

  // Add
  addAgent(testAgent);
  const retrieved = getAgent('smoke-test-agent-001');
  assert(retrieved !== undefined, 'Agent was added and retrieved');
  assert(retrieved!.friendlyName === 'smoke-test-server', 'Agent has correct name');
  assert(retrieved!.host === '10.0.0.99', 'Agent has correct host');

  // Verify JSON file
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  assert(parsed.version === '1.0', 'Registry JSON has version field');
  assert(Array.isArray(parsed.agents), 'Registry JSON has agents array');

  const agentInFile = parsed.agents.find((a: any) => a.id === 'smoke-test-agent-001');
  assert(agentInFile !== undefined, 'Agent found in JSON file');
  assert(agentInFile.encryptedPassword !== 'smokepass', 'Password is NOT stored in plaintext');
  assert(agentInFile.encryptedPassword.includes(':'), 'Password field looks encrypted (contains colons)');

  console.log(`\n   Registry JSON preview:`);
  console.log(`   ${JSON.stringify(agentInFile, null, 2).split('\n').join('\n   ')}`);

  // Remove
  const removed = removeAgent('smoke-test-agent-001');
  assert(removed === true, 'Agent removed successfully');
  assert(getAllAgents().filter(a => a.id === 'smoke-test-agent-001').length === 0, 'Registry is clean after removal');
} catch (err: any) {
  console.log(`  ❌ Registry test threw: ${err.message}`);
  failed++;
}

console.log();

// --- Summary ---
console.log('=== Results ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log();

if (failed > 0) {
  console.log('❌ SMOKE TEST FAILED');
  process.exit(1);
} else {
  console.log('✅ ALL SMOKE TESTS PASSED');
  process.exit(0);
}
