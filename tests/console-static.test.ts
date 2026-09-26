/**
 * Console static serving (apra-fleet-v6t7.2.2): src/console/static.ts is the
 * single index.html-serving code path in the tree, fed by either a disk dist
 * or SEA assets. Both sources are injected here -- a temp directory and a
 * fake getAsset -- so nothing in this file builds a binary or probes SEA
 * state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveUiAsset,
  serveUiAsset,
  uiContentType,
  isSafeUiRelPath,
  UI_ASSET_PREFIX,
  defaultSeaGetAsset,
} from '../src/console/static.js';
import type http from 'node:http';

const INDEX_HTML = '<html><body>shell</body></html>';
const APP_JS = 'console.log("hi");';
const APP_CSS = 'body{color:red}';

describe('console static: disk mode', () => {
  let shellDistDir: string;

  beforeEach(() => {
    shellDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-dist-'));
    fs.writeFileSync(path.join(shellDistDir, 'index.html'), INDEX_HTML);
    fs.mkdirSync(path.join(shellDistDir, 'assets'));
    fs.writeFileSync(path.join(shellDistDir, 'assets', 'app-abc123.js'), APP_JS);
    fs.writeFileSync(path.join(shellDistDir, 'assets', 'app-abc123.css'), APP_CSS);
  });

  afterEach(() => {
    fs.rmSync(shellDistDir, { recursive: true, force: true });
  });

  it('serves index.html for /ui and /ui/', () => {
    for (const pathname of ['/ui', '/ui/']) {
      const asset = resolveUiAsset(pathname, { shellDistDir, getAsset: null });
      expect(asset?.status).toBe(200);
      expect(asset?.contentType).toBe('text/html');
      expect(asset?.body.toString('utf8')).toBe(INDEX_HTML);
    }
  });

  it('serves a real asset from the dist with the right content-type', () => {
    const js = resolveUiAsset('/ui/assets/app-abc123.js', { shellDistDir, getAsset: null });
    expect(js?.status).toBe(200);
    expect(js?.contentType).toBe('application/javascript');
    expect(js?.body.toString('utf8')).toBe(APP_JS);

    const css = resolveUiAsset('/ui/assets/app-abc123.css', { shellDistDir, getAsset: null });
    expect(css?.status).toBe(200);
    expect(css?.contentType).toBe('text/css');
    expect(css?.body.toString('utf8')).toBe(APP_CSS);
  });

  it('falls back to index.html for an unknown client-side route', () => {
    const asset = resolveUiAsset('/ui/members/detail', { shellDistDir, getAsset: null });
    expect(asset?.status).toBe(200);
    expect(asset?.contentType).toBe('text/html');
    expect(asset?.body.toString('utf8')).toBe(INDEX_HTML);
  });

  it('404s a missing hashed asset instead of handing back the SPA shell', () => {
    const asset = resolveUiAsset('/ui/assets/missing-hash.js', { shellDistDir, getAsset: null });
    expect(asset?.status).toBe(404);
    expect(asset?.body.toString('utf8')).not.toContain('shell');
  });

  it('returns null when there is no shell dist and no SEA assets at all', () => {
    const missing = path.join(os.tmpdir(), 'no-such-console-dist-' + Date.now());
    expect(resolveUiAsset('/ui/', { shellDistDir: missing, getAsset: null })).toBeNull();
  });

  it('rejects every traversal shape without reading outside the root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-DO-NOT-SERVE');
    try {
      const attempts = [
        '/ui/../../etc/passwd',
        '/ui/' + encodeURIComponent('../../../../etc/passwd'),
        '/ui/' + encodeURIComponent('C:\\Windows\\win.ini'),
        '/ui/' + encodeURIComponent('\\\\server\\share\\secret.txt'),
        '/ui/' + encodeURIComponent('//server/share/secret.txt'),
        '/ui/' + encodeURIComponent('..\\..\\secret.txt'),
        '/ui/' + encodeURIComponent('/etc/passwd'),
        '/ui/' + encodeURIComponent(outside + '/secret.txt'),
      ];
      for (const attempt of attempts) {
        const asset = resolveUiAsset(attempt, { shellDistDir, getAsset: null });
        // Either the SPA shell or an honest 404 -- never content from
        // outside shellDistDir.
        expect(asset).not.toBeNull();
        expect([200, 404]).toContain(asset?.status);
        const body = asset?.body.toString('utf8') ?? '';
        expect(body).not.toContain('SECRET-DO-NOT-SERVE');
        expect(body).not.toContain('root:');
        if (asset?.status === 200) expect(body).toBe(INDEX_HTML);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('isSafeUiRelPath names the rejected shapes directly', () => {
    expect(isSafeUiRelPath('assets/app.js')).toBe(true);
    expect(isSafeUiRelPath('members/detail')).toBe(true);
    expect(isSafeUiRelPath('../../etc/passwd')).toBe(false);
    expect(isSafeUiRelPath('..\\..\\etc\\passwd')).toBe(false);
    expect(isSafeUiRelPath('/etc/passwd')).toBe(false);
    expect(isSafeUiRelPath('C:\\Windows\\win.ini')).toBe(false);
    expect(isSafeUiRelPath('C:/Windows/win.ini')).toBe(false);
    expect(isSafeUiRelPath('\\\\server\\share')).toBe(false);
    expect(isSafeUiRelPath('//server/share')).toBe(false);
    expect(isSafeUiRelPath('assets/app.js\0.txt')).toBe(false);
  });

  it('serveUiAsset writes the response and reports handled/unhandled', () => {
    const written: { status?: number; headers?: Record<string, string>; body: string } = { body: '' };
    const res = {
      writeHead(status: number, headers?: Record<string, string>) {
        written.status = status;
        written.headers = headers;
        return res;
      },
      end(chunk?: Buffer | string) {
        if (chunk !== undefined) written.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      },
    } as unknown as http.ServerResponse;

    expect(serveUiAsset('/ui/', res, { shellDistDir, getAsset: null })).toBe(true);
    expect(written.status).toBe(200);
    expect(written.headers?.['Content-Type']).toBe('text/html');
    expect(written.body).toBe(INDEX_HTML);

    const missing = path.join(os.tmpdir(), 'no-such-console-dist-' + Date.now());
    expect(serveUiAsset('/ui/', res, { shellDistDir: missing, getAsset: null })).toBe(false);
  });
});

describe('console static: SEA mode (injected fake getAsset)', () => {
  const assets: Record<string, string> = {
    [UI_ASSET_PREFIX + 'index.html']: INDEX_HTML,
    [UI_ASSET_PREFIX + 'assets/app-abc123.js']: APP_JS,
  };
  const reads: string[] = [];
  const getAsset = (key: string): ArrayBuffer | undefined => {
    reads.push(key);
    const value = assets[key];
    if (value === undefined) return undefined;
    const buf = Buffer.from(value, 'utf8');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };
  // A disk root that does not exist, so only the SEA source can answer.
  const shellDistDir = path.join(os.tmpdir(), 'no-such-sea-dist-' + Date.now());

  it('serves index.html through the injected asset reader', () => {
    const asset = resolveUiAsset('/ui/', { shellDistDir, getAsset });
    expect(asset?.status).toBe(200);
    expect(asset?.contentType).toBe('text/html');
    expect(asset?.body.toString('utf8')).toBe(INDEX_HTML);
  });

  it('serves an asset under the ui/ namespace with the right content-type', () => {
    reads.length = 0;
    const asset = resolveUiAsset('/ui/assets/app-abc123.js', { shellDistDir, getAsset });
    expect(asset?.status).toBe(200);
    expect(asset?.contentType).toBe('application/javascript');
    expect(asset?.body.toString('utf8')).toBe(APP_JS);
    expect(reads).toContain('ui/assets/app-abc123.js');
  });

  it('falls back to the shell for a client route and 404s a missing asset', () => {
    const route = resolveUiAsset('/ui/members', { shellDistDir, getAsset });
    expect(route?.status).toBe(200);
    expect(route?.body.toString('utf8')).toBe(INDEX_HTML);

    const missing = resolveUiAsset('/ui/assets/missing-hash.js', { shellDistDir, getAsset });
    expect(missing?.status).toBe(404);
  });

  it('returns null when the binary carries no ui/index.html', () => {
    expect(resolveUiAsset('/ui/', { shellDistDir, getAsset: () => undefined })).toBeNull();
  });

  it('normalises backslashed keys to forward slashes so Windows and POSIX agree', () => {
    reads.length = 0;
    const asset = resolveUiAsset('/ui/' + encodeURIComponent('assets/app-abc123.js'), { shellDistDir, getAsset });
    expect(asset?.status).toBe(200);
    expect(reads.every((k) => !k.includes('\\'))).toBe(true);
  });
});

describe('console static: MIME map', () => {
  it('maps the shell build outputs', () => {
    expect(uiContentType('index.html')).toBe('text/html');
    expect(uiContentType('assets/app.js')).toBe('application/javascript');
    expect(uiContentType('assets/app.css')).toBe('text/css');
    expect(uiContentType('data.json')).toBe('application/json');
    expect(uiContentType('icon.svg')).toBe('image/svg+xml');
    expect(uiContentType('logo.png')).toBe('image/png');
    expect(uiContentType('font.woff2')).toBe('font/woff2');
    expect(uiContentType('unknown.bin')).toBe('application/octet-stream');
  });
});

// ---------------------------------------------------------------------------
// Production defaults, NOT injected: resolveDefaultShellDistDir() and
// defaultSeaGetAsset(). Every test above injects shellDistDir/getAsset, so
// without this block the branches the npm-installed tree and the SEA binary
// depend on would never execute.
//
// Why a child process: vitest injects CJS-style module-scope shims
// (__dirname, and a require-less ESM scope) into every transformed module,
// so an in-process call to resolveDefaultShellDistDir() takes the
// `typeof __dirname !== 'undefined'` (CJS/SEA bundle) branch and never the
// ESM branch the tsc/npm layout uses. The child runs the REAL
// src/console/static.ts as a genuine ES module (type stripping, module
// input type -- plain `node -e` would be CJS eval, which defines
// __dirname/require as globals and silently selects the wrong branch). The
// src layout (src/console/static.ts) mirrors the tsc output layout
// (dist/console/static.js): both are two directories below the repo root,
// which is exactly what the ESM branch walks up.
// ---------------------------------------------------------------------------
describe('console static: production defaults (no injection)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const staticModuleUrl = pathToFileURL(path.join(repoRoot, 'src', 'console', 'static.ts')).href;
  const CHILD_SCRIPT = [
    'const m = await import(process.env.STATIC_MODULE_URL);',
    'let seaThrew = null; let sea;',
    'try { sea = m.defaultSeaGetAsset(); } catch (e) { seaThrew = String(e); }',
    'process.stdout.write(JSON.stringify({',
    '  dirnameType: typeof __dirname,',
    '  requireType: typeof require,',
    '  shellDistDir: m.resolveDefaultShellDistDir(),',
    '  seaIsNull: sea === null,',
    '  seaThrew,',
    '}));',
  ].join('\n');

  let tempHome: string;
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'console-static-defaults-home-'));
  });
  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function runEsmChild(): { dirnameType: string; requireType: string; shellDistDir: string; seaIsNull: boolean; seaThrew: string | null } {
    // The child only imports static.ts (fs/path/url -- no fleet state), but
    // it is still pointed at a throwaway home/data dir so nothing it could
    // ever touch lands under the real user home.
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', CHILD_SCRIPT],
      {
        cwd: tempHome,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          STATIC_MODULE_URL: staticModuleUrl,
          HOME: tempHome,
          USERPROFILE: tempHome,
          APRA_FLEET_DATA_DIR: path.join(tempHome, 'data'),
        },
      },
    );
    return JSON.parse(out);
  }

  function norm(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  it('resolveDefaultShellDistDir() under the ESM layout is <repoRoot>/packages/apra-fleet-shell-ui/dist', () => {
    const result = runEsmChild();
    // Non-vacuity guard: the child really is a genuine ES module scope, so
    // the ESM branch (not the CJS/SEA-bundle branch) is what ran.
    expect(result.dirnameType).toBe('undefined');
    expect(result.requireType).toBe('undefined');
    expect(path.isAbsolute(result.shellDistDir)).toBe(true);
    expect(norm(result.shellDistDir)).toBe(norm(path.join(repoRoot, 'packages', 'apra-fleet-shell-ui', 'dist')));
  });

  it('defaultSeaGetAsset() outside a SEA binary returns null for a ui/ key and never throws (ESM scope)', () => {
    const result = runEsmChild();
    expect(result.requireType).toBe('undefined');
    expect(result.seaThrew).toBeNull();
    expect(result.seaIsNull).toBe(true);
  });

  it('defaultSeaGetAsset() in-process is also null, and the real default resolver serves nothing for a ui/ key', () => {
    let reader: ReturnType<typeof defaultSeaGetAsset> | undefined;
    expect(() => { reader = defaultSeaGetAsset(); }).not.toThrow();
    expect(reader).toBeNull();
    // With getAsset left undefined, resolveUiAsset falls back to the real
    // defaultSeaGetAsset(); pointed at an empty disk root, there is nothing
    // to serve at all.
    expect(resolveUiAsset('/ui/', { shellDistDir: tempHome })).toBeNull();
  });
});
