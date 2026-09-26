// Stand-in for `agy --new-project ...` used by tests/agy-project.test.ts.
// Mimics what agy 1.2.11 was observed to do (docs/compose-permissions-design.md
// section 8.5): create <home>/.gemini/config/projects/<uuid>.json, write
//   project: created project "<name>" (id=<uuid>) at <path>
// to the --log-file, and print a JSON result on stdout.
//
// Leading test-only options (LocalStrategy does not forward the test's env):
//   --fake-home <dir>       home whose projects dir is used (required)
//   --fake-mode <mode>      ok (default) | two | none | mismatch | fail
//   --fake-args-file <f>    append the agy argv to this file as one JSON line
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const fake = {};
while (argv.length && argv[0].startsWith('--fake-')) {
  const k = argv.shift();
  fake[k] = argv.shift();
}
const args = argv;
const argAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (fake['--fake-args-file']) fs.appendFileSync(fake['--fake-args-file'], JSON.stringify(args) + '\n');

const home = fake['--fake-home'];
const mode = fake['--fake-mode'] || 'ok';
const dir = path.join(home, '.gemini', 'config', 'projects');
fs.mkdirSync(dir, { recursive: true });
const addDir = argAfter('--add-dir') || '';
const name = path.basename(addDir);
const logFile = argAfter('--log-file');

function create() {
  const id = crypto.randomUUID();
  const file = path.join(dir, id + '.json');
  fs.writeFileSync(file, JSON.stringify({
    id,
    name,
    projectResources: { resources: [{ folderUri: 'file://' + addDir.split(path.sep).join('/') }] },
  }, null, 2));
  return { id, file };
}

const made = [];
if (mode !== 'none') made.push(create());
if (mode === 'two') made.push(create());
if (logFile) {
  const lines = made.map((m) => {
    const logged = mode === 'mismatch' ? crypto.randomUUID() : m.id;
    return 'I0926 02:06:18.454415       1 project.go:77] project: created project "' + name + '" (id=' + logged + ') at ' + m.file;
  });
  fs.writeFileSync(logFile, lines.join('\n') + '\n');
}
process.stdout.write(JSON.stringify({ conversation_id: crypto.randomUUID(), status: 'SUCCESS', response: 'OK\n' }) + '\n');
process.exit(mode === 'fail' ? 3 : 0);
