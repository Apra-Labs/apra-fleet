// Fleet-written shell-profile exports carry a marker, and the default
// unsetEnv removes only marked lines (a hand-written export of the same NAME
// stays). Generated commands are executed only inside a temp HOME.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getOsCommands } from '../src/os/index.js';
import { FLEET_ENV_MARKER, unsetEnvSedExpr, envSourceLine, envSourceLineSedExpr } from '../src/os/os-commands.js';
import { findRealBash } from './helpers/real-bash.js';

const linux = getOsCommands('linux');
const macos = getOsCommands('macos');
const gitbash = getOsCommands('windows', 'gitbash');
const windows = getOsCommands('windows');

// A real bash (Git Bash on Windows, never the WSL launcher), or null.
const bashProbe = findRealBash();
const BASH: string | null = bashProbe.path ?? null;
if (!BASH) console.warn(`env-profile-marker: bash execution tests skipped -- ${bashProbe.reason}`);
// Each builder targets its member's sed dialect: the linux/gitbash builders
// emit GNU `sed -i`, the macos builder BSD `sed -i ''`. Execute each only on a
// host whose sed matches (macOS runner = BSD, Linux/Git Bash = GNU).
const DARWIN = process.platform === 'darwin';
const RUN_GNU = !!BASH && !DARWIN;
const RUN_BSD = !!BASH && DARWIN;
const MAC_PROFILES = ['.bashrc', '.zshrc', '.zshenv', '.profile'];

/** Run one command in bash with HOME/USERPROFILE pointed at `home`. */
function runInHome(home: string, cmd: string): void {
  const h = home.replace(/\\/g, '/');
  const r = spawnSync(BASH!, ['--noprofile', '--norc', '-c', cmd], {
    env: { ...process.env, HOME: h, USERPROFILE: home },
    encoding: 'utf-8',
  });
  if (r.error) throw r.error;
}

const tmpDirs: string[] = [];
function tempHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-marker-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('persisted profile lines carry the fleet marker', () => {
  for (const [label, cmds] of [['linux', linux], ['macos', macos], ['windows-gitbash', gitbash]] as const) {
    it(`${label}: persistEnvFileContent ends with the marker comment`, () => {
      expect(cmds.persistEnvFileContent('MY_VAR', 'v')).toBe(`export MY_VAR="v" # ${FLEET_ENV_MARKER}\n`);
    });
  }

  it('windows powershell persists a User env var (base64 file, no profile line)', () => {
    expect(windows.persistEnvFileContent('MY_VAR', 'v')).toBe(Buffer.from('v').toString('base64'));
  });
});

describe('unsetEnv default removes only marked lines', () => {
  const marked = `export MY_VAR="fleet" # ${FLEET_ENV_MARKER}`;
  const unmarked = 'export MY_VAR="mine"';

  it('the default sed expression matches only the marked line; all matches both', () => {
    // Translate the POSIX BRE to a JS RegExp for a host-independent check.
    const toRe = (expr: string) => new RegExp(expr.slice(1, -2).replace('[[:space:]]', '\\s'));
    const def = toRe(unsetEnvSedExpr('MY_VAR'));
    expect(def.test(marked)).toBe(true);
    expect(def.test(`${marked}\r`)).toBe(true);
    expect(def.test(unmarked)).toBe(false);
    expect(def.test(`export OTHER_MY_VAR="x" # ${FLEET_ENV_MARKER}`)).toBe(false);
    const all = toRe(unsetEnvSedExpr('MY_VAR', { all: true }));
    expect(all.test(marked) && all.test(unmarked)).toBe(true);
  });

  for (const [label, cmds] of [['linux', linux], ['windows-gitbash', gitbash]] as const) {
    it.skipIf(!RUN_GNU)(`${label}: running the generated commands keeps the hand-written export`, () => {
      const home = tempHome();
      for (const f of ['.bashrc', '.profile']) {
        fs.writeFileSync(path.join(home, f), `# owner\n${unmarked}\n${marked}\nexport KEEP=1\n`);
      }
      for (const cmd of cmds.unsetEnv('MY_VAR')) runInHome(home, cmd);
      for (const f of ['.bashrc', '.profile']) {
        expect(fs.readFileSync(path.join(home, f), 'utf-8')).toBe(`# owner\n${unmarked}\nexport KEEP=1\n`);
      }
    });
  }

  it.skipIf(!RUN_GNU)('linux: { all: true } removes marked and unmarked lines', () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, '.bashrc'), `${unmarked}\n${marked}\nexport KEEP=1\n`);
    for (const cmd of linux.unsetEnv('MY_VAR', { all: true })) runInHome(home, cmd);
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8')).toBe('export KEEP=1\n');
  });

  it('macOS keeps the BSD sed -i empty-string dialect for all four profiles', () => {
    for (const opts of [undefined, { all: true }]) {
      const cmds = macos.unsetEnv('MY_VAR', opts);
      const expr = unsetEnvSedExpr('MY_VAR', opts);
      for (const f of ['.bashrc', '.zshrc', '.zshenv', '.profile']) {
        expect(cmds).toContain(`sed -i '' -e '${expr}' -e '${envSourceLineSedExpr('MY_VAR')}' ~/${f} 2>/dev/null || true`);
      }
      expect(cmds).toContain('rm -f "$HOME/.apra-fleet/env/MY_VAR"');
      expect(cmds).toContain('unset MY_VAR');
    }
  });

  it('macOS persistEnvFromFile replaces with BSD sed on all four profiles (path-only line)', () => {
    const cmd = macos.persistEnvFromFile('MY_VAR', '/Users/u/.f');
    for (const f of ['.bashrc', '.zshrc', '.zshenv', '.profile']) {
      expect(cmd).toContain(`sed -i '' -e '${unsetEnvSedExpr('MY_VAR', { all: true })}' -e '${envSourceLineSedExpr('MY_VAR')}' ~/${f}`);
      expect(cmd).toContain(`printf '%s\\n' '${envSourceLine('MY_VAR')}' >> ~/${f}`);
      expect(cmd).not.toContain(`cat '/Users/u/.f' >> ~/${f}`);
    }
  });

  it.skipIf(!RUN_GNU)('linux: persistEnvFromFile replaces every export line with one path-only source line', () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, '.bashrc'), `${unmarked}\n${marked}\nexport KEEP=1\n`);
    const staged = path.join(home, 'staged').split(path.sep).join('/');
    fs.writeFileSync(staged, linux.persistEnvFileContent('MY_VAR', 'new'));
    runInHome(home, linux.persistEnvFromFile('MY_VAR', staged));
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8'))
      .toBe(`export KEEP=1\n${envSourceLine('MY_VAR')}\n`);
    expect(fs.readFileSync(path.join(home, '.apra-fleet', 'env', 'MY_VAR'), 'utf-8'))
      .toBe(`export MY_VAR="new" # ${FLEET_ENV_MARKER}\n`);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it.skipIf(!RUN_GNU)('linux: persistEnvFromFile with a missing staged file strips nothing', () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, '.bashrc'), `${marked}\n`);
    runInHome(home, linux.persistEnvFromFile('MY_VAR', path.join(home, 'absent').split(path.sep).join('/')));
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8')).toBe(`${marked}\n`);
  });

  it('linux/gitbash use GNU sed -i (no suffix argument)', () => {
    for (const cmds of [linux, gitbash]) {
      expect(cmds.unsetEnv('MY_VAR')[0]).toBe(`sed -i -e '${unsetEnvSedExpr('MY_VAR')}' -e '${envSourceLineSedExpr('MY_VAR')}' ~/.bashrc 2>/dev/null || true`);
    }
  });

  // The macos builder executed for real against BSD sed (macOS runner only).
  it.skipIf(!RUN_BSD)('macos: running the generated commands keeps the hand-written export on all four profiles', () => {
    const home = tempHome();
    for (const f of MAC_PROFILES) {
      fs.writeFileSync(path.join(home, f), `# owner\n${unmarked}\n${marked}\nexport KEEP=1\n`);
    }
    for (const cmd of macos.unsetEnv('MY_VAR')) runInHome(home, cmd);
    for (const f of MAC_PROFILES) {
      expect(fs.readFileSync(path.join(home, f), 'utf-8'), f).toBe(`# owner\n${unmarked}\nexport KEEP=1\n`);
    }
  });

  it.skipIf(!RUN_BSD)('macos: { all: true } removes marked and unmarked lines on all four profiles', () => {
    const home = tempHome();
    for (const f of MAC_PROFILES) fs.writeFileSync(path.join(home, f), `${unmarked}\n${marked}\nexport KEEP=1\n`);
    for (const cmd of macos.unsetEnv('MY_VAR', { all: true })) runInHome(home, cmd);
    for (const f of MAC_PROFILES) expect(fs.readFileSync(path.join(home, f), 'utf-8'), f).toBe('export KEEP=1\n');
  });

  it.skipIf(!RUN_BSD)('macos: persistEnvFromFile leaves one path-only source line on all four profiles', () => {
    const home = tempHome();
    for (const f of MAC_PROFILES) fs.writeFileSync(path.join(home, f), `${unmarked}\n${marked}\nexport KEEP=1\n`);
    const staged = path.join(home, 'staged');
    fs.writeFileSync(staged, macos.persistEnvFileContent('MY_VAR', 'new'));
    runInHome(home, macos.persistEnvFromFile('MY_VAR', staged));
    for (const f of MAC_PROFILES) {
      expect(fs.readFileSync(path.join(home, f), 'utf-8'), f)
        .toBe(`export KEEP=1\n${envSourceLine('MY_VAR')}\n`);
    }
    expect(fs.existsSync(staged)).toBe(false);
  });
});

// The provisioned key never lands in a shared shell profile (often 0644 under
// a 0755 home): it lives in an owner-only file the profile only sources.
// Fake key only; every command runs inside a temp HOME.
describe('persisted key stays out of shared shell profiles', () => {
  const FAKE = 'sk-ant-api03-FAKEKEY5y8u';
  const PROFILES = ['.bashrc', '.profile'];
  const stage = (home: string): string => {
    const staged = path.join(home, '.apra-fleet-persist-x').split(path.sep).join('/');
    fs.writeFileSync(staged, linux.persistEnvFileContent('MY_KEY', FAKE), { mode: 0o600 });
    return staged;
  };

  for (const [label, cmds] of [['linux', linux], ['macos', macos], ['windows-gitbash', gitbash]] as const) {
    it(`${label}: the env file is created exclusively under umask 077 before any profile is touched`, () => {
      const cmd = cmds.persistEnvFromFile('MY_KEY', '/h/.s');
      const install = cmd.indexOf('( umask 077 && mkdir -p "$HOME/.apra-fleet/env" && chmod 700 "$HOME/.apra-fleet/env"');
      expect(install).toBeGreaterThan(-1);
      expect(cmd).toContain(`( set -C; cat '/h/.s' > "$HOME/.apra-fleet/env/.MY_KEY.tmp" ) && chmod 600 "$HOME/.apra-fleet/env/.MY_KEY.tmp" && mv -f "$HOME/.apra-fleet/env/.MY_KEY.tmp" "$HOME/.apra-fleet/env/MY_KEY" ) && `);
      expect(install).toBeLessThan(cmd.indexOf('sed -i'));
      // No profile append ever reads the staged (secret-bearing) file.
      expect(cmd).not.toMatch(/cat '\/h\/\.s' >> ~\//);
    });
  }

  for (const [label, cmds, run, profiles] of [['linux', linux, RUN_GNU, PROFILES], ['macos', macos, RUN_BSD, MAC_PROFILES]] as const) {
    it.skipIf(!run)(`${label}: no profile carries the key; the env file is 0600 in a 0700 dir; a login shell still sees the key`, () => {
      const home = tempHome();
      for (const f of profiles) fs.writeFileSync(path.join(home, f), 'export KEEP=1\n', { mode: 0o644 });
      runInHome(home, cmds.persistEnvFromFile('MY_KEY', stage(home)));
      for (const f of profiles) {
        const body = fs.readFileSync(path.join(home, f), 'utf-8');
        expect(body, f).not.toContain(FAKE);
        expect(body, f).toBe(`export KEEP=1\n${envSourceLine('MY_KEY')}\n`);
      }
      const envFile = path.join(home, '.apra-fleet', 'env', 'MY_KEY');
      expect(fs.readFileSync(envFile, 'utf-8')).toContain(FAKE);
      if (process.platform !== 'win32') {
        // NTFS (Git Bash) reports no POSIX mode: the profile ACL is the boundary there.
        expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(envFile)).mode & 0o777).toBe(0o700);
      }
      // Consumers (apiKeyCheck's login shell, a human's shell) still get the var.
      const h = home.replace(/\\/g, '/');
      const r = spawnSync(BASH!, ['--noprofile', '--norc', '-c', '. ~/.profile; printf %s "${MY_KEY:0:10}"'], {
        env: { ...process.env, HOME: h, USERPROFILE: home }, encoding: 'utf-8',
      });
      expect(r.stdout).toBe(FAKE.slice(0, 10));
    });
  }

  it.skipIf(!RUN_GNU)('migration: provisioning over an older release\'s profile export moves the key out of every profile', () => {
    const home = tempHome();
    const legacyMarked = `export MY_KEY="sk-ant-api03-OLDFAKE" # ${FLEET_ENV_MARKER}`;
    const legacyUnmarked = 'export MY_KEY="sk-ant-api03-OLDFAKE2"';
    for (const f of PROFILES) fs.writeFileSync(path.join(home, f), `# owner\n${legacyUnmarked}\n${legacyMarked}\nexport KEEP=1\n`);
    // Twice: a re-provision keeps exactly one source line.
    runInHome(home, linux.persistEnvFromFile('MY_KEY', stage(home)));
    runInHome(home, linux.persistEnvFromFile('MY_KEY', stage(home)));
    for (const f of PROFILES) {
      const body = fs.readFileSync(path.join(home, f), 'utf-8');
      expect(body, f).not.toMatch(/OLDFAKE|FAKEKEY/);
      expect(body, f).toBe(`# owner\nexport KEEP=1\n${envSourceLine('MY_KEY')}\n`);
    }
  });

  it.skipIf(!RUN_GNU)('unsetEnv (remove_member default) removes the env file, the source line and an older release\'s marked export', () => {
    const home = tempHome();
    runInHome(home, linux.persistEnvFromFile('MY_KEY', stage(home)));
    const legacyMarked = `export MY_KEY="sk-ant-api03-OLDFAKE" # ${FLEET_ENV_MARKER}`;
    fs.appendFileSync(path.join(home, '.profile'), `${legacyMarked}\n`);
    for (const cmd of linux.unsetEnv('MY_KEY')) runInHome(home, cmd);
    for (const f of PROFILES) expect(fs.readFileSync(path.join(home, f), 'utf-8'), f).toBe('');
    expect(fs.existsSync(path.join(home, '.apra-fleet', 'env', 'MY_KEY'))).toBe(false);
  });

  it('the source line and its sed address are exact per name', () => {
    expect(envSourceLine('MY_KEY')).not.toMatch(/export MY_KEY=/);
    const re = new RegExp(envSourceLineSedExpr('MY_KEY').slice(1, -2).replace(/\\\//g, '/'));
    expect(re.test(envSourceLine('MY_KEY'))).toBe(true);
    expect(re.test(envSourceLine('OTHER_MY_KEY'))).toBe(false);
    expect(re.test(envSourceLine('MY_KEY_2'))).toBe(false);
  });
});
