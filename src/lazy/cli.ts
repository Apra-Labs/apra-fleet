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
import { installService, uninstallService } from './service.js';
import fs from 'node:fs';
import path from 'node:path';

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

  lazyfleet flow ...     Fixed jobs made of blocks (see: lazyfleet flow help)
`;

const FLOW_HELP = `lazyfleet flow - jobs made of blocks, run in a fixed order

  lazyfleet flow check <file.json>     Validate a flow; prints problems, warnings and its steps
  lazyfleet flow save <file.json>      Save it (after the same checks) and print its review link
  lazyfleet flow try <id> [--input "..."]
                                       Trial run: read-only tools, nothing changed; waits and prints each step
  lazyfleet flow run <id> [--input "..."] [--no-wait]
                                       Run for real (needs the person's approval on the Flows page)
  lazyfleet flow schedule <id> (--at HH:MM [--days mon-fri|1,3,5] | --every <hours>)
                           [--name "..."] [--input "..."] [--per-day N] [--usd X]
                                       Run it on a schedule (runs only while approved)
  lazyfleet flow list                  Every flow, its approval and its last run
  lazyfleet flow show <id>             Its blocks, edges, approval and recent runs
  lazyfleet flow log <run-id>          Every step of one run, with outputs
  lazyfleet flow delete <id>

The file format and how to design one: the fleet skill's flows.md.
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
  process.env.APRA_FLEET_INSTALL_QUIET = '1';
  try {
    const { runInstall } = await import('../cli/install.js');
    await runInstall(['--llm', 'claude', '--skill', 'fleet']);
  } catch (e) {
    console.log = origLog;
    dump();
    throw e;
  } finally {
    delete process.env.APRA_FLEET_INSTALL_QUIET;
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
  const service = installService();
  fs.writeFileSync(path.join(lazyDir(), 'service.json'), JSON.stringify({ autostart: service.autostart, note: service.note ?? null }) + '\n');
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

  const page = `${baseUrl(cfg)}/_lazy/`;
  const firstRun = !fs.existsSync(path.join(lazyDir(), 'welcome.json'));
  console.log(`
Welcome to lazyfleet. It is running now${service.autostart ? ', starts again when you log in,' : ''} and
Claude Code goes through it. Restart any open Claude Code sessions, then just
work as usual:

  - Paste keys and passwords straight into chat. Claude never sees them.
  - Ask for a bigger job and Claude offers to hand it to helpers (a sprint).

  Your dashboard:  ${page}
                   (open it any time with: lazyfleet ui)
  Check it is on:  lazyfleet status
  Turn it off:     lazyfleet off
`);
  if (service.note) console.log(`Note: ${service.note}\n`);
  if (firstRun && !process.argv.includes('--no-open')) {
    console.log('Opening the dashboard for a one-minute setup (connect GitHub, optional)...');
    console.log(`If no browser opens, visit: ${page}?t=${cfg.uiToken}\n`);
    openBrowser(`${page}?t=${cfg.uiToken}`);
  }
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
    return;
  }
  if (!up) return;
  console.log(`Dashboard:          ${baseUrl(cfg)}/_lazy/  (lazyfleet ui)`);
  try {
    const home = await pageApi(cfg, 'home');
    console.log(`GitHub:             ${home.github.signedIn ? `connected as ${home.github.login}` : 'not connected (optional: Issues tab)'}`);
    console.log(`Sprints:            ${home.running.length} running, ${home.week.sprints} this week`);
    const next = home.next[0];
    console.log(`Schedules:          ${home.schedulesTotal ? `${home.schedulesTotal}${next ? `, next "${next.name}" at ${new Date(next.nextAt).toLocaleString()}` : ''}` : 'none'}`);
  } catch {
    // The basics above are what matter; the rest is a bonus.
  }
}

async function on(): Promise<void> {
  const cfg = loadConfig();
  if (!(await healthy(cfg))) {
    // Rewrite the service, not just restart it: the recorded command may point
    // at a path that no longer exists (a vanished per-shell node link, a move).
    installService();
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

function pageUrl(cfg: LazyConfig, hash: string): string {
  return `${baseUrl(cfg)}/_lazy/?t=${cfg.uiToken}#${hash}`;
}

async function pageApiMethod(cfg: LazyConfig, method: string, p: string): Promise<any> {
  if (!(await healthy(cfg))) {
    console.error('lazyfleet is not running. Start it with `lazyfleet on`.');
    process.exit(1);
  }
  const r = await fetch(`${baseUrl(cfg)}/_lazy/api/${p}`, { method, headers: { cookie: `lazy_t=${encodeURIComponent(cfg.uiToken)}`, 'x-lazy': '1', host: `127.0.0.1:${cfg.port}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function readFlowFile(file: string | undefined): unknown {
  if (!file) throw new Error('Name the flow file: lazyfleet flow check flow.json');
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf-8'));
  } catch (e) {
    throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
}

function printGraph(graph: any): void {
  graph.blocks.forEach((b: any, i: number) => {
    const how = b.kind === 'command' ? `command: ${b.command}` : `${b.model}${b.tools?.length ? `, tools: ${b.tools.join(' ')}` : ', no tools'}`;
    console.log(`  ${i + 1}. ${b.id}${b.id === graph.start ? ' (start)' : ''} - ${how}`);
    console.log(`     pass -> ${b.edges.pass}, fail -> ${b.retries ? `retry ${b.retries}x, then ` : ''}${b.edges.fail}${b.input?.length ? `; reads ${b.input.join(', ')}` : ''}`);
  });
}

const RUN_MARK: Record<string, string> = { pass: '[pass]', fail: '[FAIL]', skipped: '[skip]', running: '[....]' };

function printRun(run: any, full: boolean): void {
  console.log(`${run.trial ? 'Trial run' : 'Run'} ${run.runId}: ${run.status}${run.error ? ` - ${run.error}` : ''} ($${(run.cost || 0).toFixed(2)})`);
  for (const s of run.steps) {
    console.log(`  ${RUN_MARK[s.status] ?? s.status} ${s.block}${s.attempt > 1 ? ` (try ${s.attempt})` : ''}${s.model ? ` [${s.model}]` : ''}${s.cost ? ` $${s.cost.toFixed(3)}` : ''}${s.next ? ` -> ${s.next}` : ''}`);
    if (s.error) console.log(`       error: ${s.error}`);
    if (s.notes) console.log(`       notes: ${s.notes}`);
    if (full && s.output) console.log(s.output.split('\n').map((l: string) => `       | ${l}`).join('\n'));
  }
}

async function waitRun(cfg: LazyConfig, runId: string): Promise<any> {
  for (;;) {
    const run = await pageApi(cfg, `flow-runs/${runId}`);
    if (run.status !== 'running') return run;
    await new Promise(r => setTimeout(r, 2000));
  }
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function parseDays(spec: string | undefined): number[] {
  if (!spec) return [];
  const s = spec.toLowerCase().trim();
  if (s === 'weekdays') return [1, 2, 3, 4, 5];
  if (s === 'weekends') return [0, 6];
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(x => x.trim());
    const n = (x: string) => (/^\d$/.test(x) ? Number(x) : DAY_NAMES.indexOf(x.slice(0, 3)));
    const from = n(a), to = b === undefined ? from : n(b);
    if (from < 0 || to < 0 || from > 6 || to > 6) throw new Error(`Days look like mon-fri, 1,3,5 or weekdays (got "${spec}")`);
    for (let d = from; ; d = (d + 1) % 7) { out.add(d); if (d === to) break; }
  }
  return [...out].sort();
}

async function flow(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];
  const cfg = loadConfig();
  if (!sub || sub === 'help' || sub === '--help') { process.stdout.write(FLOW_HELP); return; }
  if (sub === 'check') {
    const r = await pageApi(cfg, 'flows/check', { flow: readFlowFile(args[1]) });
    if (!r.ok) {
      console.log('Problems:');
      for (const p of r.problems) console.log(`  - ${p}`);
      process.exit(1);
    }
    console.log('OK. Steps:');
    printGraph(r.graph);
    if (r.warnings.length) { console.log('Warnings:'); for (const w of r.warnings) console.log(`  - ${w}`); }
    return;
  }
  if (sub === 'save') {
    const r = await pageApi(cfg, 'flows', { flow: readFlowFile(args[1]) });
    console.log(`Saved "${r.flow.name}" (${r.flow.id}).`);
    for (const w of r.warnings) console.log(`  warning: ${w}`);
    console.log(r.approval.state === 'approved'
      ? 'Unchanged from the version the person approved.'
      : `It runs for real only after the person approves it: ${pageUrl(cfg, `flows/${r.flow.id}`)}`);
    return;
  }
  if (sub === 'try' || sub === 'run') {
    const id = args[1];
    if (!id) throw new Error(`Name the flow: lazyfleet flow ${sub} <id>`);
    const input = flag(args, '--input');
    const r = await pageApi(cfg, `flows/${id}/run`, { trial: sub === 'try', ...(input !== undefined ? { input } : {}) });
    console.log(`${sub === 'try' ? 'Trial run' : 'Run'} started: ${pageUrl(cfg, `flows/${id}/${r.runId}`)}`);
    if (args.includes('--no-wait')) return;
    const run = await waitRun(cfg, r.runId);
    printRun(run, true);
    if (run.status !== 'passed') process.exit(1);
    return;
  }
  if (sub === 'schedule') {
    const id = args[1];
    if (!id) throw new Error('Name the flow: lazyfleet flow schedule <id> --at 18:30 --days mon-fri');
    const every = flag(args, '--every');
    const at = flag(args, '--at');
    if (!every && !at) throw new Error('Say when: --at HH:MM (with optional --days) or --every <hours>');
    const f = await pageApi(cfg, `flows/${id}`);
    const perDay = flag(args, '--per-day');
    const usd = flag(args, '--usd');
    const r = await pageApi(cfg, 'schedules', {
      name: flag(args, '--name') ?? f.flow.name,
      repo: '',
      source: { type: 'flow', flow: id, input: flag(args, '--input') },
      when: every ? { type: 'interval', hours: Number(every) } : { type: 'daily', time: at, days: parseDays(flag(args, '--days')) },
      limits: { perDay: perDay ? Number(perDay) : 1, ...(usd ? { usagePerDay: Number(usd) } : {}) },
    });
    console.log(`Scheduled "${r.schedule.name}": ${r.schedule.whenText}. Next: ${new Date(r.schedule.nextAt).toLocaleString()}.`);
    if (f.approval.state !== 'approved') console.log(`It skips until the person approves the flow: ${pageUrl(cfg, `flows/${id}`)}`);
    return;
  }
  if (sub === 'list') {
    const { flows } = await pageApi(cfg, 'flows');
    if (!flows.length) { console.log('No flows yet.'); return; }
    for (const v of flows) {
      const last = v.lastRun ? `last ${v.lastRun.trial ? 'trial ' : ''}${v.lastRun.status} ${new Date(v.lastRun.startedAt).toLocaleString()}` : 'never run';
      console.log(`${v.flow.id.padEnd(28)} ${v.approval.state.padEnd(9)} ${v.flow.blocks.length} blocks  ${last}${v.schedules.length ? `  [${v.schedules.map((s: any) => s.whenText).join('; ')}]` : ''}`);
    }
    return;
  }
  if (sub === 'show') {
    const v = await pageApi(cfg, `flows/${args[1] ?? ''}`);
    console.log(`${v.flow.name} (${v.flow.id}): ${v.flow.purpose}`);
    console.log(`Folder: ${v.flow.folder ?? '(its own scratch folder)'}`);
    console.log(`Approval: ${v.approval.state}${v.approval.changed?.length ? ` (changed: ${v.approval.changed.join(', ')})` : ''}`);
    printGraph(v.graph);
    for (const s of v.schedules) console.log(`Schedule: ${s.name} - ${s.whenText}${s.enabled ? '' : ' (off)'}`);
    for (const r of v.runs.slice(0, 8)) console.log(`Run ${r.runId}: ${r.trial ? 'trial, ' : ''}${r.status}, $${(r.cost || 0).toFixed(2)}, ${new Date(r.startedAt).toLocaleString()}`);
    console.log(`Review page: ${pageUrl(cfg, `flows/${v.flow.id}`)}`);
    return;
  }
  if (sub === 'log') {
    printRun(await pageApi(cfg, `flow-runs/${args[1] ?? ''}`), true);
    return;
  }
  if (sub === 'delete') {
    await pageApiMethod(cfg, 'DELETE', `flows/${args[1] ?? ''}`);
    console.log('Deleted.');
    return;
  }
  throw new Error(`Unknown flow command "${sub}". See: lazyfleet flow help`);
}

const commands: Record<string, () => Promise<void>> = { install, uninstall, status, on, off, ui, serve, sprint, sprints, schedules, flow };

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
