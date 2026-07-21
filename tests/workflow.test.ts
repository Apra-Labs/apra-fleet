import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runWorkflow,
  resolveWorkflowEntry,
  applyEnvDefaults,
  listWorkflows,
  formatWorkflowList,
  launcherHelp,
  WorkflowError,
  ENTRY_CONVENTIONS,
  type WorkflowDeps,
} from '../src/cli/workflow.js';

// apra-fleet-7pm.7 -- src/cli/workflow.ts import-trampoline launcher.
// Server reachability follows docs/adr-workflow-server-resolution.md (BINDING):
// APRA_FLEET_TRANSPORT override -> HTTP-singleton probe (attach, spawn nothing)
// -> stdio self-spawn fallback. The launcher calls the ONE shared helper
// (@apralabs/apra-fleet-client/server-resolution) -- here it is injected via
// deps.resolveConnection so no test ever probes a real server.
//
// Everything goes through the injectable deps bag: no real ~/.apra-fleet needed.

// Anchor the fake home with path.resolve, not a bare '/mock/home': on Windows
// path.join('/mock/home', x) yields '\mock\home\x' while the launcher's
// path.resolve(dir, entry) yields the drive-qualified 'C:\mock\home\x'. Resolving
// the root once keeps the virtual-FS keys and the launcher's lookups identical on
// every platform.
const MOCK_HOME = path.resolve('/mock/home');
const WF_DIR = path.join(MOCK_HOME, '.apra-fleet', 'workflows');
const SCHEMAS_DIR = path.join(MOCK_HOME, '.apra-fleet', 'schemas');
const NODE_MODULES_DIR = path.join(MOCK_HOME, '.apra-fleet', 'node_modules');
const SERVER_BIN = path.join(MOCK_HOME, '.apra-fleet', 'bin', 'apra-fleet');

interface Harness {
  deps: WorkflowDeps;
  logs: string[];
  warns: string[];
  errors: string[];
  imported: string[];
  /** process.argv as the imported entry observed it */
  seenArgv: string[] | null;
  /** Each call to deps.selfHeal(), recording the includeBuiltins arg passed. */
  selfHealCalls?: boolean[];
  /** The env object runWorkflow passed to deps.resolveConnection. */
  resolutionEnv?: Record<string, string | undefined>;
}

/**
 * Build a deps bag over a virtual filesystem.
 * @param files  absolute path -> file contents
 * @param opts   env, installed-binary version, SEA asset presence, import behavior
 */
function harness(
  files: Record<string, string>,
  opts: {
    env?: Record<string, string | undefined>;
    version?: string;
    hasAssets?: boolean;
    mode?: string;
    resolveThrows?: Error;
    moduleExports?: Record<string, unknown>;
    importThrows?: Error;
    /** Simulate `~/.apra-fleet/node_modules` missing (default: present). */
    nodeModulesMissing?: boolean;
    /** deps.selfHeal() return value (default: false -- no-op, as in dev/npm mode). */
    selfHealResult?: boolean;
  } = {},
): Harness {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const imported: string[] = [];
  const selfHealCalls: boolean[] = [];
  const h: Harness = { logs, warns, errors, imported, seenArgv: null, deps: null as never };

  // A synthetic marker file so `deps.exists(nodeModulesDir)` is true by default --
  // only tests exercising self-heal opt out via `nodeModulesMissing: true`.
  const allFiles = opts.nodeModulesMissing
    ? files
    : { ...files, [path.join(NODE_MODULES_DIR, '.marker')]: '' };

  const deps: WorkflowDeps = {
    env: opts.env ?? {},
    workflowsDir: WF_DIR,
    nodeModulesDir: NODE_MODULES_DIR,
    schemasDir: SCHEMAS_DIR,
    serverBin: SERVER_BIN,
    version: opts.version ?? '1.2.3',
    execPath: '/usr/bin/node',
    exists: (p) =>
      Object.prototype.hasOwnProperty.call(allFiles, p) ||
      // a directory exists if any file lives under it
      Object.keys(allFiles).some((f) => f.startsWith(p + path.sep)),
    readFile: (p) => {
      if (!Object.prototype.hasOwnProperty.call(allFiles, p)) throw new Error(`ENOENT: ${p}`);
      return allFiles[p];
    },
    listDirs: (p) => {
      const names = new Set<string>();
      for (const f of Object.keys(allFiles)) {
        if (!f.startsWith(p + path.sep)) continue;
        const rest = f.slice(p.length + 1).split(path.sep);
        if (rest.length > 1) names.add(rest[0]);
      }
      return [...names];
    },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    importModule: async (url) => {
      imported.push(url);
      // Capture argv exactly as the workflow's own arg parser would see it.
      h.seenArgv = [...process.argv];
      if (opts.importThrows) throw opts.importThrows;
      return opts.moduleExports ?? { selfExecuting: true };
    },
    hasWorkflowAssets: () => opts.hasAssets ?? true,
    selfHeal: (includeBuiltins) => {
      selfHealCalls.push(includeBuiltins);
      return opts.selfHealResult ?? false;
    },
    resolveConnection: async (env) => {
      h.resolutionEnv = env;
      if (opts.resolveThrows) throw opts.resolveThrows;
      const mode = opts.mode ?? 'http';
      return { mode, reason: `attached to ${mode}` };
    },
  };

  h.deps = deps;
  h.selfHealCalls = selfHealCalls;
  return h;
}

/** A well-formed workflow with an explicit workflow.json entry. */
function autoSprintFiles(extra: Record<string, string> = {}) {
  return {
    [path.join(WF_DIR, '.installed.json')]: JSON.stringify({
      version: '1.2.3',
      builtin: ['auto-sprint', 'hello-world'],
    }),
    [path.join(WF_DIR, 'auto-sprint', 'workflow.json')]: JSON.stringify({
      entry: 'main.mjs',
      description: 'Run an autonomous sprint',
    }),
    [path.join(WF_DIR, 'auto-sprint', 'main.mjs')]: '// entry',
    ...extra,
  };
}

describe('resolveWorkflowEntry', () => {
  it('resolves the entry declared in workflow.json', () => {
    const { deps } = harness(autoSprintFiles());
    expect(resolveWorkflowEntry(deps, 'auto-sprint')).toBe(
      path.join(WF_DIR, 'auto-sprint', 'main.mjs'),
    );
  });

  it('resolves a nested entry path inside the workflow directory', () => {
    const files = {
      [path.join(WF_DIR, 'nested', 'workflow.json')]: JSON.stringify({ entry: 'src/run.mjs' }),
      [path.join(WF_DIR, 'nested', 'src', 'run.mjs')]: '// entry',
    };
    const { deps } = harness(files);
    expect(resolveWorkflowEntry(deps, 'nested')).toBe(
      path.join(WF_DIR, 'nested', 'src', 'run.mjs'),
    );
  });

  it.each(ENTRY_CONVENTIONS)(
    'falls back to the %s convention when there is no workflow.json',
    (candidate) => {
      const files = { [path.join(WF_DIR, 'conv', candidate)]: '// entry' };
      const { deps } = harness(files);
      expect(resolveWorkflowEntry(deps, 'conv')).toBe(path.join(WF_DIR, 'conv', candidate));
    },
  );

  it('prefers the conventions in order (main.mjs before index.mjs before runner.js)', () => {
    const files = {
      [path.join(WF_DIR, 'conv', 'runner.js')]: '// c',
      [path.join(WF_DIR, 'conv', 'index.mjs')]: '// b',
      [path.join(WF_DIR, 'conv', 'main.mjs')]: '// a',
    };
    const { deps } = harness(files);
    expect(resolveWorkflowEntry(deps, 'conv')).toBe(path.join(WF_DIR, 'conv', 'main.mjs'));
  });

  it('rejects a ".." escape out of the workflow directory', () => {
    const files = {
      [path.join(WF_DIR, 'evil', 'workflow.json')]: JSON.stringify({
        entry: '../../../../etc/passwd',
      }),
      [path.join(WF_DIR, 'evil', 'main.mjs')]: '// decoy',
    };
    const { deps } = harness(files);
    expect(() => resolveWorkflowEntry(deps, 'evil')).toThrow(WorkflowError);
    expect(() => resolveWorkflowEntry(deps, 'evil')).toThrow(
      /resolves outside the workflow directory/,
    );
  });

  it('rejects an absolute entry that escapes the workflow directory', () => {
    const files = {
      [path.join(WF_DIR, 'evil', 'workflow.json')]: JSON.stringify({
        entry: path.resolve('/etc/passwd'),
      }),
    };
    const { deps } = harness(files);
    expect(() => resolveWorkflowEntry(deps, 'evil')).toThrow(
      /resolves outside the workflow directory/,
    );
  });

  it('errors, naming the file, when workflow.json has no valid "entry"', () => {
    const files = {
      [path.join(WF_DIR, 'broken', 'workflow.json')]: JSON.stringify({ description: 'no entry' }),
    };
    const { deps } = harness(files);
    expect(() => resolveWorkflowEntry(deps, 'broken')).toThrow(
      new RegExp(`${escapeRe(path.join(WF_DIR, 'broken', 'workflow.json'))}.*missing a valid "entry"`, 's'),
    );
  });

  it('errors, naming the file, when workflow.json is unparseable', () => {
    const files = {
      [path.join(WF_DIR, 'broken', 'workflow.json')]: '{ not json',
    };
    const { deps } = harness(files);
    expect(() => resolveWorkflowEntry(deps, 'broken')).toThrow(/missing a valid "entry"/);
  });

  it('errors when the declared entry does not exist on disk', () => {
    const files = {
      [path.join(WF_DIR, 'ghost', 'workflow.json')]: JSON.stringify({ entry: 'main.mjs' }),
    };
    const { deps } = harness(files);
    expect(() => resolveWorkflowEntry(deps, 'ghost')).toThrow(/does not exist at/);
  });

  it('errors when a workflow dir has neither workflow.json nor a convention entry', () => {
    const files = { [path.join(WF_DIR, 'empty', 'README.md')]: '# nothing runnable' };
    const { deps } = harness(files);
    expect(() => resolveWorkflowEntry(deps, 'empty')).toThrow(/has no workflow.json and none of/);
  });

  it('errors with the not-found text plus the list for an unknown name', () => {
    const { deps } = harness(autoSprintFiles());
    let msg = '';
    try {
      resolveWorkflowEntry(deps, 'nope');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(`Error: workflow "nope" not found in ${WF_DIR}.`);
    // ...plus the --list output, so the user sees what IS available.
    expect(msg).toContain('auto-sprint');
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('applyEnvDefaults', () => {
  it('sets both env defaults when the caller set neither (stdio mode)', () => {
    const { deps } = harness({}, { env: {} });
    const env = applyEnvDefaults(deps, 'stdio');
    expect(env.APRA_FLEET_SE_SCHEMAS_DIR).toBe(SCHEMAS_DIR);
    expect(env.APRA_FLEET_SERVER_BIN).toBe(SERVER_BIN);
  });

  it('never overwrites a caller-set APRA_FLEET_SE_SCHEMAS_DIR', () => {
    const { deps } = harness({}, { env: { APRA_FLEET_SE_SCHEMAS_DIR: '/my/schemas' } });
    const env = applyEnvDefaults(deps, 'stdio');
    expect(env.APRA_FLEET_SE_SCHEMAS_DIR).toBe('/my/schemas');
  });

  it('never overwrites a caller-set APRA_FLEET_SERVER_BIN', () => {
    const { deps } = harness({}, { env: { APRA_FLEET_SERVER_BIN: '/my/apra-fleet' } });
    const env = applyEnvDefaults(deps, 'stdio');
    expect(env.APRA_FLEET_SERVER_BIN).toBe('/my/apra-fleet');
  });

  it('does not default APRA_FLEET_SERVER_BIN when the resolver chose HTTP attach (ADR)', () => {
    // The shared resolver reads APRA_FLEET_SERVER_BIN as an *explicit stdio request*;
    // defaulting it on the HTTP path would sabotage the attach the ADR mandates.
    const { deps } = harness({}, { env: {} });
    const env = applyEnvDefaults(deps, 'http');
    expect(env.APRA_FLEET_SERVER_BIN).toBeUndefined();
    expect(env.APRA_FLEET_SE_SCHEMAS_DIR).toBe(SCHEMAS_DIR);
  });

  it('leaves an explicit APRA_FLEET_SERVER_CMD escape hatch alone', () => {
    const { deps } = harness({}, { env: { APRA_FLEET_SERVER_CMD: 'my-server run' } });
    const env = applyEnvDefaults(deps, 'stdio');
    expect(env.APRA_FLEET_SERVER_CMD).toBe('my-server run');
    expect(env.APRA_FLEET_SERVER_BIN).toBeUndefined();
  });
});

describe('listWorkflows / --list', () => {
  it('marks .installed.json names builtin and everything else user', () => {
    const files = autoSprintFiles({
      [path.join(WF_DIR, 'my-flow', 'workflow.json')]: JSON.stringify({
        entry: 'main.mjs',
        description: 'mine',
      }),
      [path.join(WF_DIR, 'my-flow', 'main.mjs')]: '// e',
    });
    const { deps } = harness(files);
    const list = listWorkflows(deps);
    expect(list.map((w) => w.name)).toEqual(['auto-sprint', 'my-flow']); // sorted
    expect(list.find((w) => w.name === 'auto-sprint')?.builtin).toBe(true);
    expect(list.find((w) => w.name === 'my-flow')?.builtin).toBe(false);
    expect(list.find((w) => w.name === 'auto-sprint')?.description).toBe(
      'Run an autonomous sprint',
    );
  });

  it('falls back to (no description) when workflow.json omits one', () => {
    const files = { [path.join(WF_DIR, 'bare', 'main.mjs')]: '// e' };
    const { deps } = harness(files);
    expect(listWorkflows(deps)[0].description).toBe('(no description)');
  });

  it('formats an empty workflows dir with an actionable hint', () => {
    const { deps } = harness({});
    expect(formatWorkflowList(deps)).toContain('No workflows installed');
    expect(formatWorkflowList(deps)).toContain('apra-fleet install');
  });

  it('--list prints the list and exits 0 without importing anything', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow(['--list'], h.deps);
    expect(code).toBe(0);
    expect(h.logs.join('\n')).toContain('auto-sprint');
    expect(h.logs.join('\n')).toContain('[builtin]');
    expect(h.imported).toEqual([]);
  });
});

describe('--help (launcher-owned flags are only recognized before <name>)', () => {
  it('--help with no name prints the launcher help, exit 0', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow(['--help'], h.deps);
    expect(code).toBe(0);
    expect(h.logs.join('\n')).toContain('apra-fleet workflow -- run an installed workflow');
    expect(h.imported).toEqual([]);
  });

  it('does NOT swallow "<name> --help" -- it passes --help to the workflow', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow(['auto-sprint', '--help'], h.deps);
    expect(code).toBe(0);
    // The launcher's own help must NOT have been printed...
    expect(h.logs.join('\n')).not.toContain('apra-fleet workflow -- run an installed workflow');
    // ...the workflow was imported and saw --help itself.
    expect(h.imported).toHaveLength(1);
    expect(h.seenArgv?.slice(2)).toEqual(['--help']);
  });

  it('does not swallow a --list that comes after <name>', async () => {
    const h = harness(autoSprintFiles());
    await runWorkflow(['auto-sprint', '--list'], h.deps);
    expect(h.seenArgv?.slice(2)).toEqual(['--list']);
    expect(h.imported).toHaveLength(1);
  });

  it('rejects an unknown launcher option before <name>, exit 1', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow(['--bogus', 'auto-sprint'], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain("unknown launcher option '--bogus'");
    expect(h.imported).toEqual([]);
  });

  it('errors with help when no workflow name is given at all', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow([], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('missing workflow name');
  });

  it('launcherHelp documents the two env defaults and APRA_FLEET_TRANSPORT', () => {
    const help = launcherHelp();
    expect(help).toContain('APRA_FLEET_SERVER_BIN');
    expect(help).toContain('APRA_FLEET_SE_SCHEMAS_DIR');
    expect(help).toContain('APRA_FLEET_TRANSPORT');
  });
});

describe('runWorkflow -- import trampoline', () => {
  it('imports the resolved entry as a file URL and exits 0', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(0);
    expect(h.imported).toEqual([
      pathToFileURL(path.join(WF_DIR, 'auto-sprint', 'main.mjs')).href,
    ]);
  });

  it('rewrites process.argv to [execPath, entry, ...passthrough] -- args untouched', async () => {
    const h = harness(autoSprintFiles());
    // The acceptance-criteria integration shape: auto-sprint's own parseCliArgs()
    // must see these flags byte-for-byte, with no launcher re-parsing.
    const args = ['--issue', 'X', '--members', 'm1', '--dry-run', '--', '--not-a-launcher-flag'];
    await runWorkflow(['auto-sprint', ...args], h.deps);
    expect(h.seenArgv).toEqual([
      '/usr/bin/node',
      path.join(WF_DIR, 'auto-sprint', 'main.mjs'),
      ...args,
    ]);
    // argv[2..] is exactly what the user typed after <name>.
    expect(h.seenArgv?.slice(2)).toEqual(args);
  });

  it('restores the original process.argv afterwards', async () => {
    const h = harness(autoSprintFiles());
    const before = [...process.argv];
    await runWorkflow(['auto-sprint', '--x'], h.deps);
    expect(process.argv).toEqual(before);
  });

  it('restores process.argv even when the workflow throws', async () => {
    const h = harness(autoSprintFiles(), { importThrows: new Error('boom') });
    const before = [...process.argv];
    await runWorkflow(['auto-sprint'], h.deps);
    expect(process.argv).toEqual(before);
  });

  it('calls an exported main() with the raw args when the module did not self-execute', async () => {
    const main = vi.fn();
    const h = harness(autoSprintFiles(), { moduleExports: { main } });
    const code = await runWorkflow(['auto-sprint', '--issue', 'X'], h.deps);
    expect(code).toBe(0);
    expect(main).toHaveBeenCalledWith(['--issue', 'X']);
  });

  it.each([['run'], ['default']])('also accepts an exported %s()', async (key) => {
    const fn = vi.fn();
    const h = harness(autoSprintFiles(), { moduleExports: { [key]: fn } });
    await runWorkflow(['auto-sprint', '-v'], h.deps);
    expect(fn).toHaveBeenCalledWith(['-v']);
  });

  it('does not call main() when the module self-executed', async () => {
    const main = vi.fn();
    const h = harness(autoSprintFiles(), { moduleExports: { selfExecuting: true, main } });
    await runWorkflow(['auto-sprint'], h.deps);
    expect(main).not.toHaveBeenCalled();
  });

  // apra-fleet-eft.41.2 / .41.4: a module that neither declares
  // `selfExecuting = true` nor exports a callable main/run/default used to
  // fall through silently, RETURNing 0 having done nothing -- the worst
  // failure mode (a no-op reported as success). The launcher must fail loud:
  // nonzero exit + an actionable stderr message naming the module.
  it('fails loud (nonzero exit, actionable stderr) when the module neither self-executes nor exports a callable entry', async () => {
    const h = harness(autoSprintFiles(), { moduleExports: {} });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).not.toBe(0);
    expect(code).toBe(1);
    const errText = h.errors.join('\n');
    expect(errText).toContain('did not execute');
    expect(errText).toContain('auto-sprint');
    expect(errText).toContain('selfExecuting');
    expect(errText).toContain('main/run/default');
  });

  it('also fails loud when the module exports non-function main/run/default values', async () => {
    const h = harness(autoSprintFiles(), {
      moduleExports: { main: 'not-a-function', run: 42, default: {} },
    });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('did not execute');
  });

  it('a thrown error from the workflow is exit 1 with the stack on stderr', async () => {
    const err = new Error('workflow blew up');
    const h = harness(autoSprintFiles(), { importThrows: err });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('workflow blew up');
    expect(h.errors.join('\n')).toContain('Error: workflow blew up\n    at'); // the stack
  });

  it('unknown <name> exits 1 with the not-found text and the list', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow(['nope'], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain(`Error: workflow "nope" not found in ${WF_DIR}.`);
    expect(h.errors.join('\n')).toContain('auto-sprint');
    expect(h.imported).toEqual([]);
  });

  it('an invalid workflow.json entry exits 1 naming the file', async () => {
    const files = {
      [path.join(WF_DIR, 'broken', 'workflow.json')]: JSON.stringify({ description: 'x' }),
    };
    const h = harness(files);
    const code = await runWorkflow(['broken'], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain(path.join(WF_DIR, 'broken', 'workflow.json'));
    expect(h.imported).toEqual([]);
  });
});

describe('runWorkflow -- fleet-server resolution (ADR)', () => {
  it('delegates to the shared resolver and logs which path it took', async () => {
    const h = harness(autoSprintFiles(), { mode: 'http' });
    await runWorkflow(['auto-sprint'], h.deps);
    expect(h.logs.join('\n')).toContain('[workflow] fleet server: attached to http');
  });

  it('a resolver failure warns but still runs the workflow (not every workflow needs a server)', async () => {
    const h = harness(autoSprintFiles(), { resolveThrows: new Error('no singleton') });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(0);
    expect(h.warns.join('\n')).toContain('could not resolve the fleet server: no singleton');
    expect(h.imported).toHaveLength(1);
  });
});

describe('R10 -- version skew between the binary and the installed workflows', () => {
  it('warns and suggests apra-fleet install on mismatch, but still runs', async () => {
    const files = autoSprintFiles({
      [path.join(WF_DIR, '.installed.json')]: JSON.stringify({
        version: '1.0.0',
        builtin: ['auto-sprint'],
      }),
    });
    const h = harness(files, { version: '1.2.3' });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(0); // a warning, not a failure
    const warned = h.warns.join('\n');
    expect(warned).toContain('installed by apra-fleet 1.0.0');
    expect(warned).toContain('this binary is 1.2.3');
    expect(warned).toContain("Run 'apra-fleet install'");
  });

  it('does not warn when the versions match', async () => {
    const h = harness(autoSprintFiles(), { version: '1.2.3' });
    await runWorkflow(['auto-sprint'], h.deps);
    expect(h.warns.join('\n')).not.toContain('installed by apra-fleet');
  });

  it('does not warn when .installed.json records no version', async () => {
    const files = autoSprintFiles({
      [path.join(WF_DIR, '.installed.json')]: JSON.stringify({ builtin: ['auto-sprint'] }),
    });
    const h = harness(files, { version: '1.2.3' });
    await runWorkflow(['auto-sprint'], h.deps);
    expect(h.warns.join('\n')).not.toContain('installed by apra-fleet');
  });
});

describe('R9 -- binary built without the workflow asset sections', () => {
  it('prints an actionable rebuild/reinstall error instead of a raw resolution failure', async () => {
    // Old binary: no workflows on disk AND no workflow sections in its SEA manifest.
    const h = harness({}, { hasAssets: false });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(1);
    const msg = h.errors.join('\n');
    expect(msg).toContain('built without the workflow subsystem assets');
    expect(msg).toContain('npm run build:binary');
    expect(msg).toContain('apra-fleet update');
    // Explicitly NOT the raw "not found" resolution failure.
    expect(msg).not.toContain('has no workflow.json and none of');
    expect(h.imported).toEqual([]);
  });

  it('does not fire when the workflow is present on disk (assets already extracted)', async () => {
    const h = harness(autoSprintFiles(), { hasAssets: false });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(0);
    expect(h.errors.join('\n')).not.toContain('built without the workflow subsystem assets');
  });

  it('a current binary with assets reports the normal not-found error', async () => {
    const h = harness(autoSprintFiles(), { hasAssets: true });
    const code = await runWorkflow(['nope'], h.deps);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('not found');
    expect(h.errors.join('\n')).not.toContain('built without the workflow subsystem assets');
  });
});

describe('self-heal -- on-demand extraction (apra-fleet-7pm.8)', () => {
  it('extracts runtime+schemas+built-ins and prints exactly one notice, then runs hello-world', async () => {
    // Empty ~/.apra-fleet: neither workflows/ nor node_modules/ has anything, but
    // this binary's manifest DOES carry the workflow sections (hasAssets: true) --
    // self-heal writes hello-world/main.mjs into the (simulated) virtual FS via
    // deps.selfHeal returning true, and the launcher proceeds to resolve+run it.
    const files = {
      [path.join(WF_DIR, 'hello-world', 'workflow.json')]: JSON.stringify({
        entry: 'main.mjs',
        description: 'Minimal example workflow',
      }),
      [path.join(WF_DIR, 'hello-world', 'main.mjs')]: '// entry',
    };
    const h = harness(files, { hasAssets: true, nodeModulesMissing: true, selfHealResult: true });
    const code = await runWorkflow(['hello-world'], h.deps);
    expect(code).toBe(0);
    expect(h.selfHealCalls).toEqual([true]); // hello-world IS a recognized built-in
    const notices = h.logs.filter((l) => l.startsWith('[workflow] self-heal:'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('built-in workflows');
    expect(h.imported).toEqual([pathToFileURL(path.join(WF_DIR, 'hello-world', 'main.mjs')).href]);
  });

  it('does not self-heal (or print a notice) when workflows/ and node_modules/ are both present', async () => {
    const h = harness(autoSprintFiles());
    await runWorkflow(['auto-sprint'], h.deps);
    expect(h.selfHealCalls).toEqual([]);
    expect(h.logs.some((l) => l.startsWith('[workflow] self-heal:'))).toBe(false);
  });

  it('a non-built-in name triggers runtime/schemas-only self-heal (includeBuiltins=false), no notice mentions built-ins', async () => {
    const h = harness({}, { hasAssets: true, nodeModulesMissing: true, selfHealResult: true });
    const code = await runWorkflow(['my-custom-flow'], h.deps);
    expect(code).toBe(1); // still "not found" -- self-heal never fabricates the dir
    expect(h.selfHealCalls).toEqual([false]);
    const notices = h.logs.filter((l) => l.startsWith('[workflow] self-heal:'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain('built-in');
    expect(h.errors.join('\n')).toContain(`Error: workflow "my-custom-flow" not found in ${WF_DIR}.`);
  });

  it('a non-built-in unknown name never creates a workflow directory for itself', async () => {
    const h = harness({}, { hasAssets: true, nodeModulesMissing: true, selfHealResult: true });
    await runWorkflow(['unknown-name'], h.deps);
    // The harness deps.exists() only reflects the virtual FS map, which self-heal
    // (mocked) never wrote into for the requested name -- resolveWorkflowEntry's
    // own not-found check (already exercised above) is the real guarantee here.
    expect(h.deps.exists(path.join(WF_DIR, 'unknown-name'))).toBe(false);
  });

  it('prints no notice when deps.selfHeal() is a no-op (e.g. dev/npm mode)', async () => {
    const h = harness({}, { hasAssets: true, nodeModulesMissing: true, selfHealResult: false });
    await runWorkflow(['hello-world'], h.deps);
    expect(h.selfHealCalls).toEqual([true]);
    expect(h.logs.some((l) => l.startsWith('[workflow] self-heal:'))).toBe(false);
  });

  it('triggers self-heal when only workflows/ is missing (node_modules/ present)', async () => {
    // Everything is "present" per the default harness marker EXCEPT workflows/,
    // which has no files at all in this virtual FS.
    const h = harness({}, { hasAssets: true, selfHealResult: true });
    await runWorkflow(['auto-sprint'], h.deps);
    expect(h.selfHealCalls).toEqual([true]);
  });
});

describe('server resolution env defaults (build-binary smoke false positive)', () => {
  // The launcher knows its own server binary (deps.serverBin -- in SEA mode the
  // running executable itself), but used to resolve the connection against the
  // raw ambient env and only apply that default AFTERWARD, so a bare home
  // (no singleton, no dev dist/) warned "could not resolve the fleet server"
  // on every green CI build-binary smoke run. The resolver must see the same
  // default the workflow itself will receive.
  it('passes serverBin as APRA_FLEET_SERVER_BIN to resolveConnection when the ambient env sets neither variable', async () => {
    const h = harness(autoSprintFiles());
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(0);
    expect(h.resolutionEnv?.APRA_FLEET_SERVER_BIN).toBe(SERVER_BIN);
    expect(h.warns.filter((w) => w.includes('could not resolve'))).toEqual([]);
  });

  it('never overrides an ambient APRA_FLEET_SERVER_BIN', async () => {
    const h = harness(autoSprintFiles(), { env: { APRA_FLEET_SERVER_BIN: '/custom/bin/apra-fleet' } });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(0);
    expect(h.resolutionEnv?.APRA_FLEET_SERVER_BIN).toBe('/custom/bin/apra-fleet');
  });

  it('never injects SERVER_BIN into the resolution env when APRA_FLEET_SERVER_CMD is set', async () => {
    const h = harness(autoSprintFiles(), { env: { APRA_FLEET_SERVER_CMD: 'node server.js run' } });
    const code = await runWorkflow(['auto-sprint'], h.deps);
    expect(code).toBe(0);
    expect(h.resolutionEnv?.APRA_FLEET_SERVER_BIN).toBeUndefined();
    expect(h.resolutionEnv?.APRA_FLEET_SERVER_CMD).toBe('node server.js run');
  });
});
