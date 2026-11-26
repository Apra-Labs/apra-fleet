// Path resolution and spawn environment for the member-host driver. Every
// process the driver spawns gets HOME, USERPROFILE and GIT_CONFIG_GLOBAL (and
// the temp dirs) pointed inside one temp root, so nothing is written to the
// runner's real home. Pure; unit-tested by tests/member-host-harness.test.ts.
import path from 'node:path';

export function resolveSandbox(root) {
  const r = path.resolve(root);
  return {
    root: r,
    home: path.join(r, 'home'),
    tmp: path.join(r, 'tmp'),
    gitConfigGlobal: path.join(r, 'gitconfig'),
    keyDir: path.join(r, 'ssh'),
    keyPath: path.join(r, 'ssh', 'member_key'),
    out: path.join(r, 'out'),
    cache: path.join(r, 'cache'),
    argsDir: path.join(r, 'args'),
  };
}

export function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Throws unless every given path is inside the sandbox root. */
export function assertInside(sandbox, ...paths) {
  for (const p of paths) {
    if (!isInside(sandbox.root, p)) throw new Error(`refusing to touch ${p}: outside the sandbox ${sandbox.root}`);
  }
}

/** Env for every spawned process: caller env + sandbox redirects, CI markers kept off npm/bd side effects. */
export function sandboxEnv(base, sandbox) {
  const env = { ...base };
  env.HOME = sandbox.home;
  env.USERPROFILE = sandbox.home;
  env.GIT_CONFIG_GLOBAL = sandbox.gitConfigGlobal;
  env.TMPDIR = sandbox.tmp;
  env.TMP = sandbox.tmp;
  env.TEMP = sandbox.tmp;
  env.APRA_FLEET_DATA_DIR = path.join(sandbox.home, '.apra-fleet', 'data');
  return env;
}
