#!/usr/bin/env node
/**
 * lazyfleet: install once, then forget about it.
 *
 *   lazyfleet            set everything up (same as `install`)
 *   lazyfleet ui         open the vault and settings page
 *   lazyfleet status     is it running, is Claude routed through it
 *   lazyfleet off | on   temporarily bypass / re-enable secret hiding
 *   lazyfleet uninstall  undo everything install did
 *   lazyfleet serve      run the background process in the foreground
 *   lazyfleet sprint "<job>"   hand a job to helpers from the terminal
 *   lazyfleet sprints | schedules   what is running, finished and coming up
 */
import { execFile } from 'node:child_process';
import { claudeSettingsPath, clearBaseUrl, currentBaseUrl, setBaseUrl } from './claude-settings.js';
import { lazyDir, loadConfig, saveConfig, type LazyConfig } from './config.js';
import { helperSettingsPath, writeHelperSettings } from './mode.js';
import { installService, restartService, uninstallService } from './service.js';
import fs from 'node:fs';

const HELP = `lazyfleet - Claude, minus the babysitting

Usage:
  lazyfleet              Set everything up (run once)
  lazyfleet ui           Open the vault and settings page
  lazyfleet status       Show whether secret hiding is active
  lazyfleet off          Send Claude traffic directly (secrets NOT hidden)
  lazyfleet on           Route Claude traffic through lazyfleet again
  lazyfleet uninstall    Remove lazyfleet and undo every change it made
  lazyfleet serve        Run the background process in this terminal

  lazyfleet sprint "<job>" [--design <id>] [--folder <dir>] [--dry-run]
                         Hand a job to helpers in this project (or --folder).
                         Without --design, lazyfleet picks one and says why.
  lazyfleet sprints      Running and recent sprints
  lazyfleet schedules    Schedules and when each runs next
`;

function baseUrl(cfg: LazyConfig): string {
  return `http://127.0.0.1:${cfg.port}`;
}

async function healthy(cfg: LazyConfig, timeoutMs = 0): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const r = await fetch(`${baseUrl(cfg)}/_lazy/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    if (timeoutMs) await new Promise(r => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return false;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args as string[], () => {
    // No browser available (SSH session etc.) -- the URL is printed anyway.
  });
}

/** Run the underlying Claude integration installer quietly; show output only if it fails. */
async function installIntegration(): Promise<void> {
  const captured: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  const grab = (...a: unknown[]) => captured.push(a.map(String).join(' '));
  const dump = () => {
    for (const line of captured) process.stderr.write(line + '\n');
  };
  process.once('exit', code => {
    if (code !== 0) dump();
  });
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    const { runInstall } = await import('../cli/install.js');
    await runInstall(['--llm', 'claude', '--skill', 'fleet']);
  } catch (e) {
    console.log = origLog;
    dump();
    throw e;
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
}

async function install(): Promise<void> {
  console.log('\nSetting up lazyfleet...\n');

  process.stdout.write('  [1/3] Connecting to Claude Code ........ ');
  await installIntegration();
  console.log('ok');

  const cfg = loadConfig();
  writeHelperSettings(cfg); // the integration step just refreshed the skill folder
  const ours = baseUrl(cfg);
  const existing = currentBaseUrl();
  if (existing && existing !== ours && !cfg.previousBaseUrl) {
    // Someone already routes Claude somewhere (a corporate gateway, say).
    // Chain through it instead of around it, and remember it for uninstall.
    cfg.previousBaseUrl = existing;
    cfg.upstream = existing;
    saveConfig(cfg);
  }

  process.stdout.write('  [2/3] Starting the background helper ... ');
  installService();
  if (!(await healthy(cfg, 15_000))) {
    console.log('failed');
    console.error(`\nThe background helper did not start. Claude was NOT changed and still works as before.`);
    console.error(`Details: ${lazyDir()}/server.log`);
    process.exit(1);
  }
  console.log('ok');

  process.stdout.write('  [3/3] Routing Claude through it ........ ');
  setBaseUrl(ours);
  console.log('ok');

  console.log(`
Done. Restart any open Claude Code sessions and just work as usual:

  - Paste keys and passwords straight into chat. Claude never sees them;
    it gets a stand-in, and the real value is used when commands run.
  - Big jobs get split up and run in parallel on their own.

  Vault and settings:  lazyfleet ui
  Turn it off:         lazyfleet off
`);
}

async function uninstall(): Promise<void> {
  const cfg = loadConfig();
  clearBaseUrl(baseUrl(cfg), cfg.previousBaseUrl);
  console.log(`  Claude routing restored (${claudeSettingsPath()})`);
  uninstallService();
  fs.rmSync(helperSettingsPath(), { force: true });
  console.log('  Background helper stopped and removed');
  console.log(`\nYour vault is kept in ${lazyDir()} and the encrypted store. Run \`lazyfleet ui\` after reinstalling to see it.`);
}

async function status(): Promise<void> {
  const cfg = loadConfig();
  const up = await healthy(cfg);
  const routed = currentBaseUrl() === baseUrl(cfg);
  console.log(`Background helper:  ${up ? 'running' : 'NOT running'} (${baseUrl(cfg)})`);
  console.log(`Claude routed:      ${routed ? 'yes - secrets are hidden' : 'no - secrets are NOT hidden'}`);
  if (routed && !up) {
    console.log('\nClaude is pointed at lazyfleet but it is not running, so Claude cannot connect.');
    console.log('Fix: `lazyfleet on` (restarts it) or `lazyfleet off` (bypass).');
  }
}

async function on(): Promise<void> {
  const cfg = loadConfig();
  if (!(await healthy(cfg))) {
    restartService();
    if (!(await healthy(cfg, 10_000))) {
      console.error(`Background helper will not start; see ${lazyDir()}/server.log. Claude left unchanged.`);
      process.exit(1);
    }
  }
  setBaseUrl(baseUrl(cfg));
  console.log('On. Restart open Claude Code sessions to pick it up.');
}

async function off(): Promise<void> {
  const cfg = loadConfig();
  clearBaseUrl(baseUrl(cfg), cfg.previousBaseUrl);
  console.log('Off. Claude now talks to the API directly and secrets are NOT hidden.');
  console.log('Restart open Claude Code sessions to pick it up. `lazyfleet on` to switch back.');
}

async function ui(): Promise<void> {
  const cfg = loadConfig();
  if (!(await healthy(cfg))) {
    console.error('lazyfleet is not running. Start it with `lazyfleet on`.');
    process.exit(1);
  }
  const url = `${baseUrl(cfg)}/_lazy/?t=${cfg.uiToken}`;
  console.log(`Opening ${baseUrl(cfg)}/_lazy/`);
  console.log(`(If no browser opens, visit: ${url})`);
  openBrowser(url);
}

async function serve(): Promise<void> {
  const { startLazyServer } = await import('./server.js');
  const s = await startLazyServer();
  const cfg = s.config();
  console.log(`[${new Date().toISOString()}] lazyfleet listening on ${baseUrl(cfg)} -> ${cfg.upstream}`);
  const stop = () => {
    s.vault.flushNow();
    s.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** Call the running background process's page API, signed in with the UI token. */
async function pageApi(cfg: LazyConfig, path: string, body?: unknown): Promise<any> {
  if (!(await healthy(cfg))) {
    console.error('lazyfleet is not running. Start it with `lazyfleet on`.');
    process.exit(1);
  }
  const r = await fetch(`${baseUrl(cfg)}/_lazy/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: `lazy_t=${encodeURIComponent(cfg.uiToken)}`, 'x-lazy': '1', 'content-type': 'application/json', host: `127.0.0.1:${cfg.port}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function sprint(): Promise<void> {
  const args = process.argv.slice(3);
  const valued = new Set(['--design', '--folder']);
  const words = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
  const ask = words.join(' ').trim();
  if (ask.length < 8) {
    console.error('Say what should get done, in quotes: lazyfleet sprint "Add a CSV export to the reports page, with tests"');
    process.exit(1);
  }
  const cfg = loadConfig();
  let folder = flag(args, '--folder');
  if (!folder) {
    folder = await new Promise<string>(resolve => execFile('git', ['rev-parse', '--show-toplevel'], (err, out) => resolve(err ? '' : String(out).trim())));
    if (!folder) {
      console.error('Run this inside a git project, or pass --folder <dir>.');
      process.exit(1);
    }
  }
  let design = flag(args, '--design');
  if (!design) {
    const r = await pageApi(cfg, 'advisor/recommend', { ask, repo: folder });
    design = r.designId;
    console.log(`Design: ${r.designName}`);
    for (const reason of r.reasons) console.log(`  - ${reason}`);
  }
  if (args.includes('--dry-run')) return;
  const r = await pageApi(cfg, 'sprints', { repo: folder, ask, design });
  console.log(`Started. Watch it: ${baseUrl(cfg)}/_lazy/?t=${cfg.uiToken}#sprints/${r.runId}`);
}

async function sprints(): Promise<void> {
  const { sprints: list } = await pageApi(loadConfig(), 'sprints');
  if (!list.length) { console.log('No sprints yet. Start one: lazyfleet sprint "..."'); return; }
  for (const x of list.slice(0, 15)) {
    const state = x.live ? `${x.status}, ${x.progress.done}/${x.progress.total} done` : `${x.status}${x.verdict ? `, ${x.verdict}` : ''}`;
    console.log(`${x.title.slice(0, 60).padEnd(60)}  ${state}${x.design ? `  [${x.design}]` : ''}`);
  }
}

async function schedules(): Promise<void> {
  const { schedules: list } = await pageApi(loadConfig(), 'schedules');
  if (!list.length) { console.log('No schedules. Create one on the Schedules page: lazyfleet ui'); return; }
  for (const s of list) {
    const next = !s.enabled ? 'off' : s.nextAt ? `next ${new Date(s.nextAt).toLocaleString()}` : '';
    console.log(`${s.name.padEnd(30)}  ${s.whenText}  (${next})`);
    const last = s.log[0];
    if (last) console.log(`  last: ${last.text}`);
  }
}

const commands: Record<string, () => Promise<void>> = { install, uninstall, status, on, off, ui, serve, sprint, sprints, schedules };

const cmd = process.argv[2] ?? 'install';
if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(HELP);
} else if (commands[cmd]) {
  commands[cmd]().catch(e => {
    console.error(`lazyfleet: ${(e as Error).message}`);
    process.exit(1);
  });
} else {
  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exit(1);
}
