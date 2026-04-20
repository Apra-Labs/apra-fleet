import { secureInput } from '../src/utils/secure-input.js';

try {
  const value = await secureInput({ prompt: 'Password', allowEmpty: true });
  console.log(`Captured: ${value}`);
  console.log(`Length: ${value.length}`);
} catch (err: any) {
  console.log(`Cancelled: ${err.message}`);
}
