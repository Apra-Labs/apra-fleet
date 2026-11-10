/**
 * Minimal ustar writer for tests: builds a .tar (optionally gzip-compressed)
 * from in-memory files, so archive tests need no tar binary on the host.
 * Names longer than 100 bytes go into the ustar prefix field.
 */
import { gzipSync } from 'node:zlib';

function header(name: string, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let short = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut);
    short = name.slice(cut + 1);
  }
  h.write(short, 0, 100, 'utf-8');
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf-8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** Build a tar of files (path -> content); folders are added for every parent path. */
export function makeTar(files: Record<string, string | Buffer>, opts: { gzip?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const name of Object.keys(files)) {
    const segs = name.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/') + '/');
  }
  for (const d of [...dirs].sort()) parts.push(header(d, 0, '5'));
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
    parts.push(header(name, data.length, '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(parts);
  return opts.gzip ? gzipSync(tar) : tar;
}
