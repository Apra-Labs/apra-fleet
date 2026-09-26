import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runSupervisor,
  applySupervisorEnvDefaults,
  missingInstallMessage,
  defaultDeps,
  SUPERVISOR_WORKING_DIR,
  SUPERVISOR_SERVE_SCRIPT,
  SUPERVISOR_DATA_DIR,
  SUPERVISOR_WORKFLOW_NAME,
  type SupervisorDeps,
} from '../src/cli/supervisor.js';
import { WORKFLOWS_DIR, SCHEMAS_DIR } from '../src/cli/config.js';

// apra-fleet-i9ag.2.2.2 (unit half) -- src/cli/supervisor.ts, the
// `apra-fleet supervisor` launcher. Everything filesystem/env/import shaped
// goes through the injectable deps bag, so nothing here needs a real
// ~/.apra-fleet install, a child process, or a bound port.
//
// The headline property pinned below is the DOUBLE-BOOT TRAP: serve.mjs ends
// with `if (isMainModule()) serveMain()...`, where isMainModule() compares its
// own import.meta.url against pathToFileURL(process.argv[1]).href. A launcher
// that both rewrote process.argv[1] to serve.mjs (workflow.ts's trampoline
// shape) AND called the exported serveMain() itself would boot the supervisor
// twice, and the second HTTP listener would die on the port. The fake module
// in `harness()` below re-implements that exact guard, so the single-boot
// assertion is structural rather than incidental.

const MOCK_HOME = path.resolve('/mock/home');
const MOCK_WORKING_DIR = path.join(MOCK_HOME, '.apra-fleet', 'workflows', 'fleet-sprint');
const MOCK_SERVE_SCRIPT = path.join(MOCK_WORKING_DIR, 'bin', 'serve.mjs');
const MOCK_SCHEMAS_DIR = path.join(MOCK_HOME, '.apra-fleet', 'schemas');
const MOCK_DATA_DIR = path.join(MOCK_HOME, '.apra-fleet-se');

interface Harness {
  deps: SupervisorDeps;
  errors: string[];
  /** Every URL handed to deps.importModule(), in call order. */
  imported: string[];
  /** Every argv array serveMain() was called with, in call order. */
  serveMainCalls: string[][];
  /** process.argv as the imported module observed it at import time. */
  argvAtImport: string[] | null;
}

function harness(
  opts: {
    env?: Record<string, string | undefined>;
    /** false => the installed tree is absent (default: present). */
    installed?: boolean;
    /** What the fake serveMain() resolves to (default: { exitCode: 0 }). */
    result?: unknown;
    /** Make the fake serveMain() reject. */
    serveThrows?: Error;
    /** Make deps.importModule() reject. */
    importThrows?: Error;
    /** Replace the fake module's export bag (default: { serveMain }). */
    moduleExports?: (serveMain: (argv: string[]) => Promise<unknown>) => Record<string, unknown>;
  } = {},
): Harness {
  const errors: string[] = [];
  const imported: string[] = [];
  const serveMainCalls: string[][] = [];
  const h: Harness = { errors, imported, serveMainCalls, argvAtImport: null, deps: null as never };

  const serveMain = async (argv: string[]): Promise<unknown> => {
    serveMainCalls.push([...argv]);
    if (opts.serveThrows) throw opts.serveThrows;
    return opts.result === undefined ? { exitCode: 0 } : opts.result;
  };

  h.deps = {
    env: opts.env ?? {},
    workingDir: MOCK_WORKING_DIR,
    serveScript: MOCK_SERVE_SCRIPT,
    schemasDir: MOCK_SCHEMAS_DIR,
    dataDir: MOCK_DATA_DIR,
    exists: (p) => (opts.installed === false ? false : p === MOCK_SERVE_SCRIPT),
    error: (m) => errors.push(m),
    importModule: async (url) => {
      imported.push(url);
      if (opts.importThrows) throw opts.importThrows;
      h.argvAtImport = [...process.argv];
      // Faithful re-implementation of serve.mjs's own tail:
      //   function isMainModule() { return process.argv[1] !== undefined
      //       && import.meta.url === pathToFileURL(process.argv[1]).href; }
      //   if (isMainModule()) serveMain().then(...)
      // A launcher that rewrote argv[1] to the serve script would trip this
      // and boot the supervisor a SECOND time.
      const selfUrl = pathToFileURL(MOCK_SERVE_SCRIPT).href;
      const argv1 = process.argv[1];
      if (argv1 !== undefined && pathToFileURL(argv1).href === selfUrl) {
        await serveMain(process.argv.slice(2));
      }
      return opts.moduleExports ? opts.moduleExports(serveMain) : { serveMain };
    },
  };
  return h;
}

describe('supervisor launcher: installed-path resolution (apra-fleet-i9ag.2.2.2)', () => {
  it('resolves <FLEET_BASE>/workflows/fleet-sprint/bin/serve.mjs from WORKFLOWS_DIR', () => {
    expect(SUPERVISOR_WORKFLOW_NAME).toBe('fleet-sprint');
    expect(SUPERVISOR_WORKING_DIR).toBe(path.join(WORKFLOWS_DIR, 'fleet-sprint'));
    expect(SUPERVISOR_SERVE_SCRIPT).toBe(
      path.join(WORKFLOWS_DIR, 'fleet-sprint', 'bin', 'serve.mjs'),
    );
  });

  it('defaultDeps() wires those exported constants plus the SCHEMAS_DIR/data-dir defaults', () => {
    const deps = defaultDeps();
    expect(deps.workingDir).toBe(SUPERVISOR_WORKING_DIR);
    expect(deps.serveScript).toBe(SUPERVISOR_SERVE_SCRIPT);
    expect(deps.schemasDir).toBe(SCHEMAS_DIR);
    expect(deps.dataDir).toBe(SUPERVISOR_DATA_DIR);
  });

  it('imports exactly the resolved serve.mjs, as a file URL', async () => {
    const h = harness();
    await runSupervisor([], h.deps);
    expect(h.imported).toEqual([pathToFileURL(MOCK_SERVE_SCRIPT).href]);
  });
});

describe('supervisor launcher: missing installed tree (apra-fleet-i9ag.2.2.2)', () => {
  it('exits non-zero naming the absolute path and telling the operator to run apra-fleet install', async () => {
    const h = harness({ installed: false });
    const code = await runSupervisor(['--port', '9999'], h.deps);

    expect(code).not.toBe(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain(MOCK_SERVE_SCRIPT);
    expect(path.isAbsolute(MOCK_SERVE_SCRIPT)).toBe(true);
    expect(h.errors[0]).toContain('apra-fleet install');
    // Never a module-not-found stack: the check runs BEFORE the import, so the
    // loader is never given the chance to throw one.
    expect(h.errors[0]).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(h.errors[0]).not.toMatch(/\n\s+at /);
    expect(h.imported).toEqual([]);
    expect(h.serveMainCalls).toEqual([]);
  });

  it('missingInstallMessage() is the single source of that text', async () => {
    const h = harness({ installed: false });
    await runSupervisor([], h.deps);
    expect(h.errors[0]).toBe(missingInstallMessage(h.deps));
  });
});

describe('supervisor launcher: env defaults (apra-fleet-i9ag.2.2.2)', () => {
  it('sets APRA_FLEET_SE_SCHEMAS_DIR when absent', async () => {
    const env: Record<string, string | undefined> = {};
    const h = harness({ env });
    await runSupervisor([], h.deps);
    expect(env.APRA_FLEET_SE_SCHEMAS_DIR).toBe(MOCK_SCHEMAS_DIR);
  });

  it('does NOT overwrite a caller-set APRA_FLEET_SE_SCHEMAS_DIR', async () => {
    const env: Record<string, string | undefined> = {
      APRA_FLEET_SE_SCHEMAS_DIR: '/caller/schemas',
    };
    const h = harness({ env });
    await runSupervisor([], h.deps);
    expect(env.APRA_FLEET_SE_SCHEMAS_DIR).toBe('/caller/schemas');
  });

  it('sets FLEET_SE_DATA_DIR when absent', async () => {
    const env: Record<string, string | undefined> = {};
    const h = harness({ env });
    await runSupervisor([], h.deps);
    expect(env.FLEET_SE_DATA_DIR).toBe(MOCK_DATA_DIR);
  });

  it('does NOT overwrite a caller-set FLEET_SE_DATA_DIR', async () => {
    const env: Record<string, string | undefined> = { FLEET_SE_DATA_DIR: '/caller/se-data' };
    const h = harness({ env });
    await runSupervisor([], h.deps);
    expect(env.FLEET_SE_DATA_DIR).toBe('/caller/se-data');
  });

  it('applies both defaults BEFORE the module is imported (serve.mjs reads them at load/boot time)', async () => {
    const env: Record<string, string | undefined> = {};
    const seen: Array<string | undefined> = [];
    const h = harness({ env });
    const inner = h.deps.importModule;
    h.deps.importModule = async (url) => {
      seen.push(env.APRA_FLEET_SE_SCHEMAS_DIR, env.FLEET_SE_DATA_DIR);
      return inner(url);
    };
    await runSupervisor([], h.deps);
    expect(seen).toEqual([MOCK_SCHEMAS_DIR, MOCK_DATA_DIR]);
  });

  it('applySupervisorEnvDefaults() returns the SAME env object it mutated', () => {
    const env: Record<string, string | undefined> = {};
    const h = harness({ env });
    expect(applySupervisorEnvDefaults(h.deps)).toBe(env);
  });
});

describe('supervisor launcher: verbatim passthrough (apra-fleet-i9ag.2.2.2)', () => {
  it('hands serve.mjs the exact argv tail, unparsed, including --port/--beads-dir/-h', async () => {
    const argv = ['--port', '9312', '--beads-dir', '/some/project', '-h'];
    const h = harness();
    await runSupervisor(argv, h.deps);
    expect(h.serveMainCalls).toEqual([argv]);
  });

  it('passes an empty tail through as an empty array (serve.mjs then uses its own defaults)', async () => {
    const h = harness();
    await runSupervisor([], h.deps);
    expect(h.serveMainCalls).toEqual([[]]);
  });

  it('never re-parses or reorders unknown flags', async () => {
    const argv = ['--not-a-launcher-flag', 'positional', '--port=1234'];
    const h = harness();
    await runSupervisor(argv, h.deps);
    expect(h.serveMainCalls).toEqual([argv]);
  });
});

describe('supervisor launcher: single-boot property (apra-fleet-i9ag.2.2.2)', () => {
  it('invokes the module entry point EXACTLY ONCE, even though the fake module re-implements serve.mjs isMainModule() guard', async () => {
    const h = harness();
    const code = await runSupervisor(['--port', '9312'], h.deps);

    expect(code).toBe(0);
    expect(h.imported).toHaveLength(1);
    // The double-boot form (argv[1] rewritten to serve.mjs AND an explicit
    // serveMain() call) would make this 2 -- the fake module's isMainModule()
    // emulation would fire first, then the launcher's own call.
    expect(h.serveMainCalls).toHaveLength(1);
    expect(h.serveMainCalls[0]).toEqual(['--port', '9312']);
  });

  it('leaves process.argv untouched across the import -- the mechanism that keeps isMainModule() false', async () => {
    const before = [...process.argv];
    const h = harness();
    await runSupervisor(['--port', '9312'], h.deps);

    expect(h.argvAtImport).not.toBeNull();
    expect(h.argvAtImport![1]).not.toBe(MOCK_SERVE_SCRIPT);
    expect(h.argvAtImport).toEqual(before);
    expect(process.argv).toEqual(before);
  });
});

describe('supervisor launcher: exit-code propagation and failure modes (apra-fleet-i9ag.2.2.2)', () => {
  it('propagates a non-zero exitCode out of serve.mjs rather than swallowing it', async () => {
    const h = harness({ result: { exitCode: 7 } });
    expect(await runSupervisor([], h.deps)).toBe(7);
  });

  it('propagates exitCode 0 as 0', async () => {
    const h = harness({ result: { exitCode: 0 } });
    expect(await runSupervisor([], h.deps)).toBe(0);
  });

  it('treats a missing/!numeric exitCode as 0 (serve.mjs always returns one; be forgiving, not wrong)', async () => {
    expect(await runSupervisor([], harness({ result: undefined }).deps)).toBe(0);
    expect(await runSupervisor([], harness({ result: {} }).deps)).toBe(0);
    expect(await runSupervisor([], harness({ result: { exitCode: 'nope' } }).deps)).toBe(0);
  });

  it('reports a non-zero code when the installed module exports no callable serveMain', async () => {
    const h = harness({ moduleExports: () => ({ notServeMain: true }) });
    const code = await runSupervisor([], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('serveMain');
    expect(h.errors.join('\n')).toContain('apra-fleet install');
    expect(h.serveMainCalls).toEqual([]);
  });

  it('reports a non-zero code when the import itself fails, naming the script', async () => {
    const h = harness({ importThrows: new Error('boom during load') });
    const code = await runSupervisor([], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain(MOCK_SERVE_SCRIPT);
    expect(h.errors.join('\n')).toContain('boom during load');
  });

  it('reports a non-zero code when serveMain() itself rejects', async () => {
    const h = harness({ serveThrows: new Error('supervisor blew up') });
    const code = await runSupervisor([], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('supervisor blew up');
  });
});
