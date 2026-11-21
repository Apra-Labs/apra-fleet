// Fleet-written shell-profile exports carry a marker, and the default
// unsetEnv removes only marked lines (a hand-written export of the same NAME
// stays). Generated commands are executed only inside a temp HOME.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getOsCommands } from '../src/os/index.js';
import { FLEET_ENV_MARKER, unsetEnvSedExpr } from '../src/os/os-commands.js';
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
        expect(cmds).toContain(`sed -i '' '${expr}' ~/${f} 2>/dev/null || true`);
      }
      expect(cmds).toContain('unset MY_VAR');
    }
  });

  it('macOS persistEnvFromFile replaces with BSD sed on all four profiles', () => {
    const cmd = macos.persistEnvFromFile('MY_VAR', '/Users/u/.f');
    for (const f of ['.bashrc', '.zshrc', '.zshenv', '.profile']) {
      expect(cmd).toContain(`sed -i '' '${unsetEnvSedExpr('MY_VAR', { all: true })}' ~/${f}`);
      expect(cmd).toContain(`cat '/Users/u/.f' >> ~/${f}`);
    }
  });

  it.skipIf(!RUN_GNU)('linux: persistEnvFromFile leaves exactly one marked line (replaces a hand-written one)', () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, '.bashrc'), `${unmarked}\n${marked}\nexport KEEP=1\n`);
    const staged = path.join(home, 'staged').split(path.sep).join('/');
    fs.writeFileSync(staged, linux.persistEnvFileContent('MY_VAR', 'new'));
    runInHome(home, linux.persistEnvFromFile('MY_VAR', staged));
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8'))
      .toBe(`export KEEP=1\nexport MY_VAR="new" # ${FLEET_ENV_MARKER}\n`);
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
      expect(cmds.unsetEnv('MY_VAR')[0]).toBe(`sed -i '${unsetEnvSedExpr('MY_VAR')}' ~/.bashrc 2>/dev/null || true`);
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

  it.skipIf(!RUN_BSD)('macos: persistEnvFromFile leaves exactly one marked line on all four profiles', () => {
    const home = tempHome();
    for (const f of MAC_PROFILES) fs.writeFileSync(path.join(home, f), `${unmarked}\n${marked}\nexport KEEP=1\n`);
    const staged = path.join(home, 'staged');
    fs.writeFileSync(staged, macos.persistEnvFileContent('MY_VAR', 'new'));
    runInHome(home, macos.persistEnvFromFile('MY_VAR', staged));
    for (const f of MAC_PROFILES) {
      expect(fs.readFileSync(path.join(home, f), 'utf-8'), f)
        .toBe(`export KEEP=1\nexport MY_VAR="new" # ${FLEET_ENV_MARKER}\n`);
    }
    expect(fs.existsSync(staged)).toBe(false);
  });
});
