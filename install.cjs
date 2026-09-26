#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const distIndex = path.join(__dirname, "dist", "index.js");

if (!fs.existsSync(distIndex)) {
  console.error("Error: dist/index.js not found. Build project first ('npm run build') or install from an extracted release tarball.");
  process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [distIndex, "install", ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? 0);
