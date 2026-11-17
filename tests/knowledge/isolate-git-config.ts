import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ISOLATED_VARS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;

// Points git at an empty global config and no system config for this process,
// so neither the test's own git calls nor the code under test (which inherits
// process.env) read the developer's global core.hooksPath or init.templateDir.
// Returns a function that restores the previous values and removes the file.
export function isolateGitConfig(): () => void {
  const saved = ISOLATED_VARS.map((name) => [name, process.env[name]] as const);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gitconfig-'));
  const globalConfig = path.join(dir, '.gitconfig');
  fs.writeFileSync(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
