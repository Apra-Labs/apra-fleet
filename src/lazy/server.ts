/**
 * The one background process: model proxy on every path, plus the local
 * settings page under /_lazy/. Binds to 127.0.0.1 only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { lazyDir, loadConfig, updateConfig, type LazyConfig } from './config.js';
import { createProxyHandler } from './proxy.js';
import { Redactor, type ScrubEvent } from './redact.js';
import { renderUi } from './ui-page.js';
import { Vault } from './vault.js';
import { getAllAgents } from '../services/registry.js';
import { isAutoMember } from '../services/member-reaper.js';
import { listSprints, sprintCode, sprintCommitDiff, sprintFileDiff, sprintLog, sprintTask, sprintView } from './sprints/index.js';
import { launchSprint, resumeSprintWatchers, stopSprint, type LaunchInput } from './sprints/launcher.js';
import { checkDesign, deleteDesign, designSteps, listDesigns, saveDesign, DEFAULT_DESIGN, type Design } from './sprints/designs.js';

export interface SprintDeps {
  launch: (input: LaunchInput) => Promise<{ runId: string }>;
  stop: (runId: string) => Promise<boolean>;
}

export interface ActivityItem {
  at: string;
  type: 'hidden' | 'caught' | 'error';
  name?: string;
  origin?: string;
  message?: string;
}

const MAX_ACTIVITY = 300;

export class Activity {
  items: ActivityItem[] = [];
  totals = { caught: 0, hidden: 0, requests: 0 };

  record(events: ScrubEvent[]): void {
    const at = new Date().toISOString();
    // Collapse repeats within one request -- one line per secret.
    const seen = new Map<string, ScrubEvent>();
    for (const e of events) if (!seen.has(e.name) || e.kind === 'new') seen.set(e.name, e);
    for (const e of seen.values()) {
      const item: ActivityItem = { at, type: e.kind === 'new' ? 'caught' : 'hidden', name: e.name, origin: e.origin };
      if (e.kind === 'new') {
        this.totals.caught++;
        this.push(item);
      } else {
        this.totals.hidden++;
        // Known secrets are re-hidden on every request; only log the first per minute.
        const recent = this.items.find(i => i.name === e.name && Date.parse(at) - Date.parse(i.at) < 60_000);
        if (!recent) this.push(item);
      }
    }
  }

  error(message: string): void {
    this.push({ at: new Date().toISOString(), type: 'error', message });
  }

  private push(item: ActivityItem): void {
    this.items.unshift(item);
    if (this.items.length > MAX_ACTIVITY) this.items.length = MAX_ACTIVITY;
    try {
      fs.appendFileSync(path.join(lazyDir(), 'activity.log'), JSON.stringify(item) + '\n', { mode: 0o600 });
    } catch {
      // Logging must never break the proxy.
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

function helpersSummary() {
  try {
    return getAllAgents().map(a => ({
      name: a.friendlyName,
      where: a.agentType === 'local' ? 'this machine' : a.host ?? 'remote',
      automatic: isAutoMember(a),
      lastUsed: a.lastUsed ?? a.createdAt,
    }));
  } catch {
    return [];
  }
}

export interface LazyServer {
  server: http.Server;
  vault: Vault;
  activity: Activity;
  config: () => LazyConfig;
}

const RUN_ID = '([A-Za-z0-9._-]{1,128})';

/** Sprint board API. Returns false when the path is not a sprint route. */
async function handleSprints(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: SprintDeps): Promise<boolean> {
  const p = url.pathname;
  if (p === '/_lazy/api/designs' && req.method === 'GET') {
    const repo = url.searchParams.get('repo') || undefined;
    json(res, 200, { default: DEFAULT_DESIGN, designs: listDesigns(repo).map(d => ({ ...d, steps: designSteps(d) })) });
    return true;
  }
  if (p === '/_lazy/api/designs' && req.method === 'POST') {
    const saved = await saveDesign((await readJson(req)) as Design);
    json(res, 200, { ok: true, design: { ...saved, steps: designSteps(saved) } });
    return true;
  }
  if (p === '/_lazy/api/designs/check' && req.method === 'POST') {
    const d = (await readJson(req)) as Design;
    try {
      await checkDesign(d);
      json(res, 200, { ok: true, steps: designSteps(d) });
    } catch (e) {
      json(res, 200, { ok: false, error: (e as Error).message, steps: designSteps(d) });
    }
    return true;
  }
  const dm = /^\/_lazy\/api\/designs\/([a-z0-9-]{1,40})$/.exec(p);
  if (dm && req.method === 'DELETE') {
    deleteDesign(dm[1]);
    json(res, 200, { ok: true });
    return true;
  }
  if (p === '/_lazy/api/sprints' && req.method === 'GET') {
    json(res, 200, { sprints: listSprints() });
    return true;
  }
  if (p === '/_lazy/api/sprints' && req.method === 'POST') {
    const rec = await deps.launch((await readJson(req)) as LaunchInput);
    json(res, 200, { ok: true, runId: rec.runId });
    return true;
  }
  let m = new RegExp(`^/_lazy/api/sprints/${RUN_ID}$`).exec(p);
  if (m && req.method === 'GET') {
    const view = sprintView(m[1]);
    json(res, view ? 200 : 404, view ?? { error: 'no such sprint' });
    return true;
  }
  m = new RegExp(`^/_lazy/api/sprints/${RUN_ID}/stop$`).exec(p);
  if (m && req.method === 'POST') {
    json(res, 200, { ok: await deps.stop(m[1]) });
    return true;
  }
  m = new RegExp(`^/_lazy/api/sprints/${RUN_ID}/tasks/([A-Za-z0-9._-]{1,128})$`).exec(p);
  if (m && req.method === 'GET') {
    const t = sprintTask(m[1], m[2]);
    json(res, t ? 200 : 404, t ?? { error: 'no such task' });
    return true;
  }
  m = new RegExp(`^/_lazy/api/sprints/${RUN_ID}/code$`).exec(p);
  if (m && req.method === 'GET') {
    json(res, 200, await sprintCode(m[1]));
    return true;
  }
  m = new RegExp(`^/_lazy/api/sprints/${RUN_ID}/code/file$`).exec(p);
  if (m && req.method === 'GET') {
    json(res, 200, await sprintFileDiff(m[1], url.searchParams.get('path') ?? ''));
    return true;
  }
  m = new RegExp(`^/_lazy/api/sprints/${RUN_ID}/code/commit/([0-9a-f]{7,40})$`).exec(p);
  if (m && req.method === 'GET') {
    json(res, 200, await sprintCommitDiff(m[1], m[2]));
    return true;
  }
  m = new RegExp(`^/_lazy/api/sprints/${RUN_ID}/log$`).exec(p);
  if (m && req.method === 'GET') {
    json(res, 200, { log: sprintLog(m[1], Number(url.searchParams.get('tail') ?? 200)) });
    return true;
  }
  return false;
}

export function createLazyServer(opts: { config?: LazyConfig; sprints?: Partial<SprintDeps> } = {}): LazyServer {
  const sprintDeps: SprintDeps = { launch: launchSprint, stop: stopSprint, ...opts.sprints };
  let config = opts.config ?? loadConfig();
  const vault = new Vault();
  const activity = new Activity();
  const startedAt = new Date().toISOString();

  const proxy = createProxyHandler({
    upstream: config.upstream,
    redactor: () => new Redactor(vault, config.detection),
    onEvents: events => activity.record(events),
    onError: message => activity.error(message),
  });

  const allowedHosts = () => new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  async function handleUi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // DNS-rebinding guard: the page only answers to its own loopback name.
    if (!allowedHosts().has(String(req.headers.host))) {
      json(res, 403, { error: 'bad host' });
      return;
    }
    if (url.pathname === '/_lazy/health') {
      json(res, 200, { ok: true, startedAt });
      return;
    }

    const t = url.searchParams.get('t');
    if (t && safeEqual(t, config.uiToken)) {
      res.writeHead(302, {
        'set-cookie': `lazy_t=${encodeURIComponent(config.uiToken)}; HttpOnly; SameSite=Strict; Path=/_lazy`,
        location: '/_lazy/',
      });
      res.end();
      return;
    }
    const authed = safeEqual(cookie(req, 'lazy_t') ?? '', config.uiToken);
    if (!authed) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Open this page with `lazyfleet ui` so it can sign you in.\n');
      return;
    }

    if (url.pathname === '/_lazy/' || url.pathname === '/_lazy') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:",
      });
      res.end(renderUi());
      return;
    }

    // Everything below is the page's API. Writes need a custom header, which
    // a cross-site form cannot send.
    const write = req.method !== 'GET';
    if (write && req.headers['x-lazy'] !== '1') {
      json(res, 403, { error: 'missing header' });
      return;
    }

    try {
      if (url.pathname === '/_lazy/api/state' && req.method === 'GET') {
        const { uiToken: _hidden, ...publicConfig } = config;
        json(res, 200, {
          startedAt,
          config: publicConfig,
          vault: vault.list(),
          presetNote: new Redactor(vault, config.detection).systemNote(vault.presets()),
          activity: activity.items.slice(0, 100),
          totals: activity.totals,
          helpers: helpersSummary(),
        });
        return;
      }
      if (url.pathname === '/_lazy/api/config' && req.method === 'POST') {
        config = { ...updateConfig(await readJson(req)), uiToken: config.uiToken, port: config.port, upstream: config.upstream };
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/_lazy/api/vault' && req.method === 'POST') {
        const body = await readJson(req);
        const name = vault.add(String(body.name ?? ''), String(body.value ?? ''), String(body.description ?? ''), body.announce !== false);
        json(res, 200, { ok: true, name });
        return;
      }
      const m = /^\/_lazy\/api\/vault\/([a-zA-Z0-9_-]{1,64})(\/reveal)?$/.exec(url.pathname);
      if (m && req.method === 'PATCH' && !m[2]) {
        const body = await readJson(req);
        json(res, vault.describe(m[1], body) ? 200 : 404, { ok: true });
        return;
      }
      if (m && req.method === 'DELETE' && !m[2]) {
        json(res, vault.delete(m[1]) ? 200 : 404, { ok: true });
        return;
      }
      if (m && req.method === 'POST' && m[2]) {
        const value = vault.valueOf(m[1]);
        json(res, value === undefined ? 404 : 200, { value });
        return;
      }
      if (await handleSprints(req, res, url, sprintDeps)) return;
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    activity.totals.requests += url.pathname.startsWith('/_lazy') ? 0 : 1;
    if (url.pathname === '/_lazy' || url.pathname.startsWith('/_lazy/')) {
      handleUi(req, res, url).catch(e => json(res, 500, { error: (e as Error).message }));
      return;
    }
    proxy(req, res).catch(e => {
      activity.error(`proxy crashed: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { type: 'error', error: { type: 'api_error', message: 'lazyfleet proxy error' } });
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // streams can run for many minutes
  server.headersTimeout = 60_000;

  return { server, vault, activity, config: () => config };
}

export function startLazyServer(): Promise<LazyServer> {
  const s = createLazyServer();
  return new Promise((resolve, reject) => {
    s.server.once('error', reject);
    s.server.listen(s.config().port, '127.0.0.1', () => {
      // Sprints that kept running while this process was down still grow their pool.
      resumeSprintWatchers();
      resolve(s);
    });
  });
}
