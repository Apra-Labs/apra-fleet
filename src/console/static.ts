/**
 * Console static serving (apra-fleet-v6t7.2.2).
 *
 * The ONE index.html-serving implementation in src/. It is the migration
 * destination for the interim helpers that briefly lived in
 * src/services/http-transport.ts (uiContentType / serveUiAsset /
 * resolveDefaultShellDistDir); those are deleted, not duplicated.
 *
 * Two sources, one lookup:
 *   - disk: packages/apra-fleet-shell-ui/dist (a dev checkout or an npm
 *     install that shipped the built shell), overridable per call.
 *   - SEA: node:sea assets under the 'ui/' namespace, which is how the
 *     single-executable binary carries the shell -- there is no dist
 *     directory on disk next to a single-file binary.
 *
 * Both the disk root and the SEA asset reader are INJECTED parameters with
 * real defaults. Nothing below reads process.execPath or probes SEA state
 * on its own once a source is supplied, so a test can exercise either mode
 * with a temp directory or a fake getAsset and never build a binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import type { ConsoleStaticSource } from './server.js';

/** SEA asset namespace: 'ui/index.html', 'ui/assets/app-<hash>.js', ...
 *  Matches scripts/gen-sea-config.mjs's '<prefix>/<path>' key convention. */
export const UI_ASSET_PREFIX = 'ui/';

export type SeaGetAsset = (key: string) => ArrayBuffer | undefined;

/**
 * Where the built shell lives on disk when no override is supplied.
 *
 * Mirrors version.ts's resolveVersion() dual-path convention: under tsc/ESM
 * output (dist/console/static.js) derive the repo root from import.meta.url;
 * under the esbuild CJS/SEA bundle __dirname is a bundle-internal path with
 * no on-disk packages/ tree next to it, so this intentionally resolves to
 * nothing servable there -- the binary serves the shell from SEA assets
 * instead, and existsSync below simply finds no disk dist.
 */
export function resolveDefaultShellDistDir(): string {
  if (typeof __dirname !== 'undefined') {
    // CJS/SEA bundle: no repo checkout to walk up to from inside a
    // single-file binary.
    return path.join(__dirname, 'packages', 'apra-fleet-shell-ui', 'dist');
  }
  // ESM path (tsc output for npm): dist/console/static.js -> repo root is
  // two levels up.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return path.join(repoRoot, 'packages', 'apra-fleet-shell-ui', 'dist');
}

/** Real SEA asset reader, or null when this process is not a SEA binary.
 *  Probing lives HERE (the default), never inside the serving logic. */
export function defaultSeaGetAsset(): SeaGetAsset | null {
  try {
    const sea = require('node:sea');
    if (!sea.isSea()) return null;
    return (key: string) => {
      try {
        return sea.getAsset(key) as ArrayBuffer;
      } catch {
        return undefined;
      }
    };
  } catch {
    return null;
  }
}

const UI_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

export function uiContentType(assetPath: string): string {
  const ext = assetPath.slice(assetPath.lastIndexOf('.')).toLowerCase();
  return UI_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Normalises a request-relative path to forward slashes so one asset key
 * works identically on Windows and POSIX (SEA asset keys are always
 * forward-slashed; a Windows disk lookup re-joins with path.join below).
 */
function normalizeKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
}

/**
 * Traversal guard. Runs on the request-derived path BEFORE any lookup, so a
 * rejected path never reaches the filesystem at all.
 *
 * Rejects, with backslashes already normalised to '/' by the caller:
 *   - any '..' path segment          ('../../etc/passwd', '..%5C..%5Cx')
 *   - absolute POSIX paths           ('/etc/passwd')
 *   - Windows drive-letter prefixes  ('C:\Windows\win.ini', 'C:/...')
 *   - UNC prefixes                   ('\\\\server\\share', '//server/share')
 *   - NUL bytes (path truncation attacks)
 */
export function isSafeUiRelPath(rawRelPath: string): boolean {
  if (rawRelPath.includes('\0')) return false;
  const slashed = rawRelPath.replace(/\\/g, '/');
  if (slashed.startsWith('/')) return false; // absolute, and covers '//' UNC
  if (/^[a-zA-Z]:/.test(slashed)) return false; // drive letter, with or without a slash
  return !slashed.split('/').includes('..');
}

/**
 * Asset-looking paths 404 when missing; route-looking paths fall back to the
 * SPA shell. Without this split a mistyped hashed bundle would answer 200
 * text/html and the browser would fail with a confusing MIME error instead
 * of an honest 404. The rule is "the last segment has an extension".
 */
function looksLikeAsset(key: string): boolean {
  const last = key.slice(key.lastIndexOf('/') + 1);
  return last.includes('.');
}

export interface UiAsset {
  status: number;
  contentType: string;
  body: Buffer;
}

interface ResolvedSource {
  /** Reads one 'ui/'-relative key, or undefined when absent. */
  read(key: string): Buffer | undefined;
}

function diskSource(root: string): ResolvedSource | null {
  if (!fs.existsSync(path.join(root, 'index.html'))) return null;
  return {
    read(key: string): Buffer | undefined {
      const resolved = path.resolve(root, ...key.split('/'));
      // Belt-and-braces: isSafeUiRelPath already rejected traversal, so this
      // only ever fires on a symlink/edge case -- never on a normal asset.
      const rootResolved = path.resolve(root);
      if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return undefined;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return undefined;
      return fs.readFileSync(resolved);
    },
  };
}

function seaSource(getAsset: SeaGetAsset): ResolvedSource | null {
  const probe = getAsset(UI_ASSET_PREFIX + 'index.html');
  if (!probe) return null;
  return {
    read(key: string): Buffer | undefined {
      const raw = getAsset(UI_ASSET_PREFIX + key);
      return raw ? Buffer.from(raw) : undefined;
    },
  };
}

/**
 * Resolves one /ui request to a response.
 *
 * Returns null when there is NO shell to serve at all (neither a disk dist
 * nor SEA assets), so the caller answers its existing 404 and a checkout
 * without a built shell behaves exactly as it did before /ui existed.
 */
export function resolveUiAsset(pathname: string, source: ConsoleStaticSource = {}): UiAsset | null {
  const diskRoot = source.shellDistDir ?? resolveDefaultShellDistDir();
  const getAsset = source.getAsset === undefined ? defaultSeaGetAsset() : source.getAsset;

  const resolved = diskSource(diskRoot) ?? (getAsset ? seaSource(getAsset) : null);
  if (!resolved) return null;

  const indexKey = 'index.html';
  const spaIndex = (): UiAsset => {
    const body = resolved.read(indexKey);
    // index.html is what made this source exist, so this is effectively
    // unreachable; answering 404 rather than throwing keeps a dist deleted
    // mid-request from taking the server down.
    if (!body) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found') };
    return { status: 200, contentType: uiContentType(indexKey), body };
  };

  const rawRel = pathname === '/ui' || pathname === '/ui/' ? '' : pathname.slice('/ui/'.length);
  if (!rawRel) return spaIndex();

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRel);
  } catch {
    decoded = rawRel;
  }

  if (!isSafeUiRelPath(decoded)) {
    // Rejected before any lookup: nothing outside the root is ever read.
    // An asset-looking traversal attempt gets an honest 404; a route-looking
    // one gets the SPA shell, same as any other unknown client route.
    return looksLikeAsset(decoded.replace(/\\/g, '/')) ? notFound() : spaIndex();
  }

  const key = normalizeKey(decoded);
  if (!key) return spaIndex();

  const body = resolved.read(key);
  if (body) return { status: 200, contentType: uiContentType(key), body };

  // Unknown path: a missing hashed asset is a real 404; a client-side route
  // (no extension) falls back to the SPA shell.
  return looksLikeAsset(key) ? notFound() : spaIndex();
}

function notFound(): UiAsset {
  return { status: 404, contentType: 'text/plain', body: Buffer.from('not found') };
}

/**
 * The ConsoleStaticHandler the console seam calls. Returns false (having
 * written nothing) when there is no shell to serve at all, so the seam falls
 * back to the server's existing 404.
 */
export function serveUiAsset(
  pathname: string,
  res: http.ServerResponse,
  source: ConsoleStaticSource = {},
): boolean {
  const asset = resolveUiAsset(pathname, source);
  if (!asset) return false;
  res.writeHead(asset.status, { 'Content-Type': asset.contentType });
  res.end(asset.body);
  return true;
}
