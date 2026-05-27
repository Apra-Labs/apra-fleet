// agy-settings-merge.js -- writes per-workspace model override for Antigravity.
//
// Merges a model name into .gemini/antigravity-cli/settings.json (relative to cwd)
// without overwriting other fields (colorScheme, statusLine, permissions, etc.).
//
// argv[1] = model display name (e.g. "Gemini 3.5 Flash (Medium)")

const fs = require('fs');
const path = require('path');

const model = process.argv[2];
if (!model) {
  process.exit(0);
}

const sp = path.join('.gemini', 'antigravity-cli', 'settings.json');
fs.mkdirSync(path.dirname(sp), { recursive: true });

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
} catch {
  // file missing or malformed -- start fresh
}

settings.model = model;
fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
