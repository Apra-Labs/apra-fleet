import { credentialSet, credentialList } from './dist/services/credential-store.js';
import path from 'path';
import fs from 'fs';

const testDir = '/tmp/apra-test-' + Date.now();
process.env.APRA_FLEET_DATA_DIR = testDir;

credentialSet('test-cred', 'secret-value', true, 'allow');

const credPath = path.join(testDir, 'credentials.json');
if (fs.existsSync(credPath)) {
  console.log('✓ APRA_FLEET_DATA_DIR works: credentials.json created at', credPath);
  const content = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  if (content.credentials['test-cred']) {
    console.log('✓ Credential stored correctly in custom directory');
  } else {
    console.log('✗ Credential not found in custom directory');
  }
} else {
  console.log('✗ credentials.json not found at', credPath);
}

fs.rmSync(testDir, { recursive: true });
console.log('✓ Cleanup completed');
