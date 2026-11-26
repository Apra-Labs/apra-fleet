// Vendored exec-bd copy: PATH-order bd resolution (same cases as tests/exec-bd.test.ts).
// Paths are built with SEP so no backslash escaping is needed.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    execBdSync, resolveWindowsBdCommand, resetBdResolutionLogForTests,
} from '../src/supervisor/lib/exec-bd.mjs';

const SEP = String.fromCharCode(92);
const w = (...parts) => parts.join(SEP);
const SHIM = '"%_prog%"  "%dp0%' + w('', 'node_modules', '@beads', 'bd', 'bin', 'bd.js') + '" %*';
const A = w('C:', 'a');
const B = w('C:', 'b');

function mk(present, pathVar) {
    const logs = [];
    const versionCalls = [];
    const deps = {
        env: { PATH: pathVar, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        platform: 'win32',
        existsFn: (p) => present.includes(p),
        readFileFn: () => SHIM,
        execFileSyncFn: (cmd, args) => { versionCalls.push({ cmd, args }); return 'bd version 9.9.9'; },
        log: (m) => { logs.push(m); },
    };
    return { deps, logs, versionCalls };
}

describe('vendored exec-bd PATH order', () => {
    test('bd.exe in an earlier dir beats a later bd.cmd', () => {
        resetBdResolutionLogForTests();
        const { deps } = mk([w(A, 'bd.exe'), w(B, 'bd.cmd')], `${A};${B}`);
        assert.deepStrictEqual(resolveWindowsBdCommand(deps), { kind: 'exe', path: w(A, 'bd.exe') });
    });

    test('bd.cmd in an earlier dir beats a later bd.exe', () => {
        resetBdResolutionLogForTests();
        const { deps } = mk([w(A, 'bd.cmd'), w(B, 'bd.exe')], `${A};${B}`);
        assert.deepStrictEqual(resolveWindowsBdCommand(deps), { kind: 'script', path: w(A, 'node_modules', '@beads', 'bd', 'bin', 'bd.js') });
    });

    test('empty and relative PATH entries are ignored', () => {
        resetBdResolutionLogForTests();
        const { deps } = mk(['bd.exe', w('rel', 'bd.exe'), w(B, 'bd.exe')], `;rel;.;${B}`);
        assert.deepStrictEqual(resolveWindowsBdCommand(deps), { kind: 'exe', path: w(B, 'bd.exe') });
    });

    test('execBdSync execs the exe directly (shell:false) and logs the resolution once across calls', () => {
        resetBdResolutionLogForTests();
        const { deps, logs, versionCalls } = mk([w(A, 'bd.exe'), w(B, 'bd.cmd')], `${A};${B}`);
        const calls = [];
        const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return 'ok'; };
        const resolver = () => resolveWindowsBdCommand(deps);
        execBdSync(['list'], {}, fake, resolver);
        execBdSync(['show', 'x'], {}, fake, resolver);
        execBdSync(['ready'], {}, fake, resolver);
        assert.deepStrictEqual(calls.map((c) => c.cmd), [w(A, 'bd.exe'), w(A, 'bd.exe'), w(A, 'bd.exe')]);
        assert.strictEqual(calls[0].opts.shell, false);
        assert.strictEqual(logs.length, 1);
        assert.ok(logs[0].includes(w(A, 'bd.exe')) && logs[0].includes('9.9.9'), logs[0]);
        assert.strictEqual(versionCalls.length, 1);
    });
});
