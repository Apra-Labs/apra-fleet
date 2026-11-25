import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Extract a .tgz into `dest` in-process (no `tar` binary: GNU tar on Windows
 * reads "C:\..." as a remote host). Returns the extracted regular-file paths,
 * relative to `dest`, with forward slashes. Supports ustar prefix fields and
 * pax `path=` overrides, which is what npm pack emits.
 */
export function extractTgz(tgzPath: string, dest: string): string[] {
  const tar = gunzipSync(fs.readFileSync(tgzPath));
  const extracted: string[] = [];
  let paxPath: string | undefined;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const cstr = (a: number, b: number): string => {
      const s = header.subarray(a, b).toString('utf-8');
      const nul = s.indexOf(String.fromCharCode(0));
      return nul === -1 ? s : s.slice(0, nul);
    };
    const size = parseInt(cstr(124, 136).trim() || '0', 8);
    const type = header[156];
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === 120 /* 'x' pax header */) {
      for (const line of data.toString('utf-8').split(String.fromCharCode(10))) {
        const eq = line.indexOf('path=');
        if (eq !== -1) paxPath = line.slice(eq + 5);
      }
      continue;
    }
    if (type === 103 /* 'g' */) continue;
    const prefix = cstr(345, 500);
    let name = paxPath ?? (prefix ? `${prefix}/${cstr(0, 100)}` : cstr(0, 100));
    paxPath = undefined;
    if (type !== 48 && type !== 0) continue; // regular files only
    const out = path.join(dest, ...name.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    extracted.push(name);
  }
  return extracted;
}
