import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { logError } from '../utils/log-helpers.js';

/**
 * Result of attempting to launch the local browser credential UI.
 * - 'launched'    : a server is listening and a browser was opened; the value
 *                   will arrive via the onSubmit callback. close() tears it down.
 * - 'unavailable' : no way to open a browser here (headless / no opener) — the
 *                   caller should fall through to the manual CLI instruction.
 */
export type AuthWebOutcome =
  | { kind: 'launched'; close: () => void }
  | { kind: 'unavailable' };

export type AuthWebMode = 'password' | 'api-key';

const TTL_MS = 2 * 60 * 1000; // single-use window before the server tears down
const MAX_BODY = 64 * 1024;   // reject oversized POST bodies

/**
 * Detect how to open the user's default browser. Returns null when there is no
 * graphical session or no opener available (e.g. headless / SSH).
 */
function findBrowserOpener(): { cmd: string; args: string[] } | null {
  if (process.platform === 'darwin') {
    // Over SSH there may be no Aqua console session for `open` to target; a
    // non-zero exit is swallowed by the detached spawn below, so guard here and
    // fall through to the manual CLI instruction. Mirrors the darwin SSH gate
    // in launchAuthTerminal (auth-socket.ts).
    if (process.env.SSH_TTY) return null;
    return { cmd: 'open', args: [] };
  }
  if (process.platform === 'win32') {
    // Headless Windows (SSH / service account) has no interactive desktop;
    // mirrors hasInteractiveDesktop() in auth-socket.ts so the caller falls
    // through to the manual CLI instruction instead of spawning a no-op opener.
    if (process.env.SESSIONNAME !== 'Console') return null;
    return { cmd: 'cmd', args: ['/c', 'start', ''] };
  }
  // Linux / BSD: needs a display and xdg-open
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  try {
    execSync('which xdg-open', { stdio: 'ignore' });
    return { cmd: 'xdg-open', args: [] };
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function formPage(prompt: string, isApiKey: boolean, token: string, error?: string): string {
  const errHtml = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  const placeholder = isApiKey ? 'Secure value' : 'Password';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>apra-fleet — secure entry</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f5f5f7; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f5f5f7; } }
  main { width: min(92vw, 420px); padding: 2rem; border-radius: 14px; background: Canvas; box-shadow: 0 8px 30px rgba(0,0,0,.12); }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; letter-spacing: .02em; }
  .prompt { margin: 0 0 1.25rem; opacity: .8; }
  input, button { width: 100%; box-sizing: border-box; font: inherit; padding: .7rem .8rem; border-radius: 9px; }
  input { border: 1px solid #8884; margin-bottom: .8rem; background: Field; color: FieldText; }
  button { border: 0; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .note { font-size: .8rem; opacity: .6; margin: 1rem 0 0; }
  .err { color: #dc2626; margin: 0 0 1rem; font-size: .85rem; }
</style>
</head><body>
<main>
  <h1>apra-fleet</h1>
  <p class="prompt">${escapeHtml(prompt)}</p>
  ${errHtml}
  <form method="POST" action="/${token}" autocomplete="off">
    <input type="password" name="value" placeholder="${placeholder}" autofocus required>
    <button type="submit">Submit</button>
  </form>
  <p class="note">Sent only to 127.0.0.1 on this machine and encrypted immediately. Close this tab after submitting.</p>
</main>
</body></html>`;
}

function donePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>apra-fleet</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f5f5f7; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f5f5f7; } }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 1.4rem; }
</style></head><body>
<main><h1>✓ Received</h1><p>Encrypted and stored. You can close this tab and return to your session.</p></main>
</body></html>`;
}

/**
 * Spin up a single-use, loopback-only web page that collects one credential and
 * hands it to onSubmit (which encrypts it immediately). Hardened against the
 * usual local-server pitfalls:
 *   - binds to 127.0.0.1 only (never 0.0.0.0)
 *   - the path carries a 256-bit unguessable token; other paths 404
 *   - validates the Host header (DNS-rebinding defense)
 *   - single submission, then tears down; hard TTL backstop
 *   - never logs the submitted value
 */
export function launchAuthWeb(
  memberName: string,
  mode: AuthWebMode,
  prompt: string,
  onSubmit: (value: string) => { ok: boolean; error?: string },
  _opts?: { openUrl?: (url: string) => void },
): AuthWebOutcome {
  // Resolve how to open the browser. An injected opener (tests) bypasses
  // environment detection; otherwise we require a real opener to exist.
  let openUrl: (url: string) => void;
  if (_opts?.openUrl) {
    openUrl = _opts.openUrl;
  } else {
    const opener = findBrowserOpener();
    if (!opener) return { kind: 'unavailable' };
    openUrl = (url) => {
      try {
        const child = spawn(opener.cmd, [...opener.args, url], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => logError('auth_web', `Failed to open browser for ${memberName}: ${err.message}`));
        child.unref();
      } catch (err: any) {
        logError('auth_web', `Failed to open browser for ${memberName}: ${err.message}`);
      }
    };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenPath = `/${token}`;
  const isApiKey = mode === 'api-key';

  let closed = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  const server = http.createServer((req, res) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    // DNS-rebinding defense: only accept loopback Host headers.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    if (pathname !== tokenPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(formPage(prompt, isApiKey, token));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      let tooBig = false;
      req.on('data', (c: Buffer) => {
        body += c.toString();
        if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) return;
        const value = new URLSearchParams(body).get('value') ?? '';
        if (!value) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(formPage(prompt, isApiKey, token, 'Value must not be empty.'));
          return;
        }
        const result = onSubmit(value);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(result.ok ? donePage() : formPage(prompt, isApiKey, token, result.error ?? 'Submission failed.'));
        if (result.ok) close(); // single-use
      });
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  });

  function close(): void {
    if (closed) return;
    closed = true;
    if (ttlTimer) clearTimeout(ttlTimer);
    try { server.close(); } catch { /* already closing */ }
  }

  server.on('error', (err) => {
    logError('auth_web', `Local auth web server error: ${err.message}`);
    close();
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    openUrl(`http://127.0.0.1:${port}${tokenPath}`);
  });

  ttlTimer = setTimeout(close, TTL_MS);

  return { kind: 'launched', close };
}
