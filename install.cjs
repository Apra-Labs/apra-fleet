#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const home = process.env.HOME || process.env.USERPROFILE;
const installDir = path.join(home, ".apra-fleet");
const skillsDir = path.join(home, ".claude", "skills");
const settingsFile = path.join(home, ".claude", "settings.json");
const scriptDir = __dirname;

function run(cmd, opts) {
  execSync(cmd, { stdio: "inherit", ...opts });
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

console.log("Installing Apra Fleet...");

// --- Step 1: Copy from tarball ---
if (!fs.existsSync(path.join(scriptDir, "dist"))) {
  console.error("Error: dist/ not found. Run install from an extracted tarball.");
  console.error("Download from: https://github.com/Apra-Labs/apra-fleet/releases");
  process.exit(1);
}

console.log(`Installing from tarball to ${installDir}`);
fs.mkdirSync(installDir, { recursive: true });

for (const dir of ["dist", "skills", "hooks", "scripts"]) {
  copyDirSync(path.join(scriptDir, dir), path.join(installDir, dir));
}
for (const file of ["package.json", "package-lock.json", "version.json"]) {
  fs.copyFileSync(path.join(scriptDir, file), path.join(installDir, file));
}

// --- Step 2: Install production dependencies ---
console.log("Installing dependencies...");
run("npm ci --omit=dev --no-fund --no-audit", { cwd: installDir });

// --- Step 3: Copy PM skill ---
console.log("Installing PM skill...");
const pmDest = path.join(skillsDir, "pm");
copyDirSync(path.join(installDir, "skills", "pm"), pmDest);

// --- Step 4: Install PostToolUse hook ---
console.log("Installing hooks...");
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

const hookConfigPath = path.join(installDir, "hooks", "hooks-config.json");
const hookConfig = JSON.parse(fs.readFileSync(hookConfigPath, "utf-8"));

if (fs.existsSync(settingsFile)) {
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  settings.hooks = settings.hooks || {};
  settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];

  const newHook = hookConfig.hooks.PostToolUse[0];
  const idx = settings.hooks.PostToolUse.findIndex(
    (h) => h.matcher === newHook.matcher
  );

  if (idx >= 0) {
    settings.hooks.PostToolUse[idx] = newHook;
  } else {
    settings.hooks.PostToolUse.push(newHook);
  }

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
} else {
  fs.copyFileSync(hookConfigPath, settingsFile);
}

// --- Step 5: Configure statusline ---
console.log("Configuring statusline...");
const statuslineScript = path.join(installDir, "scripts", "fleet-statusline.sh");
{
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  settings.statusLine = {
    type: "command",
    command: statuslineScript,
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
}

// --- Step 6: Register MCP server ---
console.log("Registering MCP server...");
try {
  run("claude mcp remove fleet", { stdio: "ignore" });
} catch (_) {
  // ignore if not registered
}
const indexJs = path.join(installDir, "dist", "index.js");
run(`claude mcp add --scope user fleet -- node "${indexJs}"`);

// --- Step 7: Print version ---
const version = JSON.parse(
  fs.readFileSync(path.join(installDir, "version.json"), "utf-8")
).version;

console.log("");
console.log(`Apra Fleet v${version} installed successfully.`);
console.log(`  Install dir:  ${installDir}`);
console.log(`  PM skill:     ${pmDest}`);
console.log(`  Statusline:   ${statuslineScript}`);
console.log("");
console.log("Run /mcp in Claude Code to load the server.");
