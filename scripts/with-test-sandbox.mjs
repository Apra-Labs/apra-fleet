#!/usr/bin/env node
// Run a command inside the per-run test sandbox (scripts/test-sandbox.mjs).
// Used by the workspace packages' `test` scripts so a standalone
// `npm test --workspace=...` is sandboxed exactly like the root `npm test`.
//   node ../../scripts/with-test-sandbox.mjs node --test test/*.test.mjs
import { spawn } from 'node:child_process';
import { ensureTestSandbox } from './test-sandbox.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
    console.error('usage: node scripts/with-test-sandbox.mjs <command> [args...]');
    process.exit(2);
}
const sandbox = ensureTestSandbox(process.env);
const child = spawn(cmd === 'node' ? process.execPath : cmd, args, { stdio: 'inherit', env: process.env });
const forward = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
process.on('SIGINT', forward);
process.on('SIGTERM', forward);
child.on('exit', (code, signal) => {
    sandbox.cleanup();
    process.exit(code ?? (signal ? 1 : 0));
});
child.on('error', (err) => {
    console.error(`[test-sandbox] could not run ${cmd}: ${err.message}`);
    sandbox.cleanup();
    process.exit(1);
});
