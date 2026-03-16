#!/usr/bin/env node
/**
 * scripts/gen-ico.mjs
 *
 * Generates assets/icons/apra-fleet.ico with multi-size embedding:
 *   16×16, 32×32, 48×48, 256×256
 *
 * Requires only Node.js built-ins — no npm deps.
 * Source: assets/icons/icon-512.png (must be 512×512 RGBA PNG)
 *
 * Usage:
 *   node scripts/gen-ico.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SIZES = [16, 32, 48, 256];
const SOURCE = resolve(ROOT, "assets/icons/icon-512.png");
const OUT_ICO = resolve(ROOT, "assets/icons/apra-fleet.ico");

function resizePng(srcPath, size) {
  const tmpOut = `/tmp/apra-ico-${size}.png`;
  if (process.platform === "darwin") {
    execSync(`sips -z ${size} ${size} "${srcPath}" --out "${tmpOut}"`, { stdio: "pipe" });
  } else if (hasCommand("convert")) {
    execSync(`convert "${srcPath}" -resize ${size}x${size} "${tmpOut}"`, { stdio: "pipe" });
  } else if (hasCommand("magick")) {
    execSync(`magick "${srcPath}" -resize ${size}x${size} "${tmpOut}"`, { stdio: "pipe" });
  } else {
    throw new Error("No image resizing tool found (need sips, ImageMagick convert, or magick)");
  }
  return readFileSync(tmpOut);
}

function hasCommand(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function packIco(pngBuffers) {
  const count = pngBuffers.length;
  const HEADER_SIZE = 6;
  const ENTRY_SIZE = 16;
  const dataOffset = HEADER_SIZE + ENTRY_SIZE * count;

  const sizes = pngBuffers.map((buf) => buf.length);
  const offsets = [];
  let cur = dataOffset;
  for (const s of sizes) {
    offsets.push(cur);
    cur += s;
  }

  const totalSize = dataOffset + sizes.reduce((a, b) => a + b, 0);
  const ico = Buffer.alloc(totalSize);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(count, 4);

  for (let i = 0; i < count; i++) {
    const size = SIZES[i];
    const off = HEADER_SIZE + ENTRY_SIZE * i;
    ico.writeUInt8(size >= 256 ? 0 : size, off);
    ico.writeUInt8(size >= 256 ? 0 : size, off + 1);
    ico.writeUInt8(0, off + 2);
    ico.writeUInt8(0, off + 3);
    ico.writeUInt16LE(1, off + 4);
    ico.writeUInt16LE(32, off + 6);
    ico.writeUInt32LE(sizes[i], off + 8);
    ico.writeUInt32LE(offsets[i], off + 12);
  }

  let writePos = dataOffset;
  for (const buf of pngBuffers) {
    buf.copy(ico, writePos);
    writePos += buf.length;
  }

  return ico;
}

console.log(`[gen-ico] Source: ${SOURCE}`);
console.log(`[gen-ico] Generating sizes: ${SIZES.join(", ")}`);

const pngBuffers = [];
for (const size of SIZES) {
  process.stdout.write(`[gen-ico]   ${size}x${size}... `);
  const buf = resizePng(SOURCE, size);
  pngBuffers.push(buf);
  console.log(`${buf.length} bytes`);
}

const ico = packIco(pngBuffers);
writeFileSync(OUT_ICO, ico);
console.log(`[gen-ico] Written: ${OUT_ICO} (${ico.length} bytes, ${SIZES.length} sizes)`);
