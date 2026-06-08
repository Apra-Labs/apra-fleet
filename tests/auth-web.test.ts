import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { launchAuthWeb } from '../src/services/auth-web.js';

interface Resp { status: number; body: string }

function request(url: string, opts: { method?: string; host?: string; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    if (opts.host !== undefined) headers.Host = opts.host;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Launch with an injected opener that captures the URL once the server is listening. */
function launchCaptured(onSubmit: (v: string) => { ok: boolean; error?: string }) {
  let resolveUrl!: (u: string) => void;
  const urlPromise = new Promise<string>((r) => { resolveUrl = r; });
  const handle = launchAuthWeb('test-member', 'password', 'Enter password for test-member', onSubmit, {
    openUrl: (u) => resolveUrl(u),
  });
  return { handle, urlPromise };
}

describe('auth-web (local browser credential UI)', () => {
  it('launches, binds to loopback, and serves a masked form on the token path', async () => {
    const { handle, urlPromise } = launchCaptured(() => ({ ok: true }));
    expect(handle.kind).toBe('launched');

    const url = await urlPromise;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/);

    const res = await request(url);
    expect(res.status).toBe(200);
    expect(res.body).toContain('apra-fleet');
    expect(res.body).toContain('type="password"');

    if (handle.kind === 'launched') handle.close();
  });

  it('returns 404 for an unguessable-token mismatch', async () => {
    const { handle, urlPromise } = launchCaptured(() => ({ ok: true }));
    const url = await urlPromise;
    const port = new URL(url).port;

    const res = await request(`http://127.0.0.1:${port}/not-the-token`);
    expect(res.status).toBe(404);

    if (handle.kind === 'launched') handle.close();
  });

  it('rejects non-loopback Host headers (DNS-rebinding defense)', async () => {
    const { handle, urlPromise } = launchCaptured(() => ({ ok: true }));
    const url = await urlPromise;

    const res = await request(url, { host: 'evil.example.com' });
    expect(res.status).toBe(403);

    if (handle.kind === 'launched') handle.close();
  });

  it('accepts a submitted value, calls onSubmit once, then tears down (single-use)', async () => {
    const onSubmit = vi.fn(() => ({ ok: true }));
    const { handle, urlPromise } = launchCaptured(onSubmit);
    const url = await urlPromise;

    const res = await request(url, { method: 'POST', body: 'value=hunter2' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Received');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hunter2');

    // Single-use: the server should have closed; a follow-up request is refused.
    await new Promise((r) => setTimeout(r, 30));
    await expect(request(url)).rejects.toThrow();
  });

  it('rejects an empty value with 400 and does not call onSubmit', async () => {
    const onSubmit = vi.fn(() => ({ ok: true }));
    const { handle, urlPromise } = launchCaptured(onSubmit);
    const url = await urlPromise;

    const res = await request(url, { method: 'POST', body: 'value=' });
    expect(res.status).toBe(400);
    expect(onSubmit).not.toHaveBeenCalled();

    if (handle.kind === 'launched') handle.close();
  });

  it('surfaces an onSubmit failure to the page without closing', async () => {
    const onSubmit = vi.fn(() => ({ ok: false, error: 'No pending auth' }));
    const { handle, urlPromise } = launchCaptured(onSubmit);
    const url = await urlPromise;

    const res = await request(url, { method: 'POST', body: 'value=whatever' });
    expect(res.status).toBe(400);
    expect(res.body).toContain('No pending auth');

    // Still open after a failed submit — the user can retry.
    const retry = await request(url);
    expect(retry.status).toBe(200);

    if (handle.kind === 'launched') handle.close();
  });

  // These exercise the REAL findBrowserOpener() (no injected openUrl), which is
  // bypassed by every test above. They cover the platform-specific headless
  // guards that decide whether to fall through to the manual CLI instruction.
  describe('findBrowserOpener headless detection', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const origSession = process.env.SESSIONNAME;
    const origSshTty = process.env.SSH_TTY;

    function setPlatform(p: NodeJS.Platform) {
      Object.defineProperty(process, 'platform', { value: p, configurable: true });
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', origPlatform);
      if (origSession === undefined) delete process.env.SESSIONNAME;
      else process.env.SESSIONNAME = origSession;
      if (origSshTty === undefined) delete process.env.SSH_TTY;
      else process.env.SSH_TTY = origSshTty;
    });

    it('returns unavailable on headless Windows (SESSIONNAME != Console)', () => {
      setPlatform('win32');
      process.env.SESSIONNAME = 'RDP-Tcp#0';
      const handle = launchAuthWeb('m', 'password', 'Enter password for m', () => ({ ok: true }));
      expect(handle.kind).toBe('unavailable');
      if (handle.kind === 'launched') handle.close();
    });

    it('launches on interactive Windows (SESSIONNAME == Console)', () => {
      setPlatform('win32');
      process.env.SESSIONNAME = 'Console';
      const handle = launchAuthWeb('m', 'password', 'Enter password for m', () => ({ ok: true }));
      expect(handle.kind).toBe('launched');
      if (handle.kind === 'launched') handle.close();
    });

    it('returns unavailable on macOS over SSH (SSH_TTY set)', () => {
      setPlatform('darwin');
      process.env.SSH_TTY = '/dev/ttys000';
      const handle = launchAuthWeb('m', 'password', 'Enter password for m', () => ({ ok: true }));
      expect(handle.kind).toBe('unavailable');
      if (handle.kind === 'launched') handle.close();
    });

    it('launches on local macOS (no SSH_TTY)', () => {
      setPlatform('darwin');
      delete process.env.SSH_TTY;
      const handle = launchAuthWeb('m', 'password', 'Enter password for m', () => ({ ok: true }));
      expect(handle.kind).toBe('launched');
      if (handle.kind === 'launched') handle.close();
    });
  });
});
