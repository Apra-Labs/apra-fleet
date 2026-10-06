import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { getOsCommands } from '../src/os/index.js';
import { escapeShellArg } from '../src/utils/shell-escape.js';
import { findRealBash, runBash } from './helpers/real-bash.js';

// Executes WindowsGitBashCommands.killPid for real against a live execute_command
// wrapper running in Git Bash: the pid handed to killPid is the FLEET_PID
// marker value (an MSYS pid), exactly what ssh.ts killRemoteTree / tryKillPid
// pass. Asserts every process of the timed-out command dies -- MSYS children
// (whose Windows parent chain is broken by MSYS fork+exec) AND a native
// Windows grandchild -- while an unrelated Git Bash process survives.

const bash = process.platform === 'win32' ? findRealBash() : { reason: 'Git Bash tree-kill is Windows-only' };
if (!bash.path) console.warn(`[gitbash-killpid-tree.test] skipping: ${bash.reason}`);

function alive(winpid: number): boolean {
  try { process.kill(winpid, 0); return true; } catch (e: any) { return e?.code !== 'ESRCH'; }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe.skipIf(!bash.path)('gitbash killPid kills the whole timed-out command tree', () => {
  it('MSYS children and native grandchildren die; an unrelated bash survives', async () => {
    const cmds = getOsCommands('windows', 'gitbash');
    const nodeExe = process.execPath.replace(/\\/g, '/');
    const grand = `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},300000)'],{stdio:'ignore'});console.log('G:'+c.pid);setTimeout(()=>{},300000)`;
    const payload = [
      'sleep 3011 & p1=$!',
      `"${nodeExe}" -e ${escapeShellArg(grand)} & p2=$!`,
      'sleep 3012 & p3=$!',
      // Give the MSYS execs time to settle, then report each child's CURRENT winpid.
      'sleep 1',
      'for p in $p1 $p2 $p3; do read -r w < /proc/$p/winpid; echo "W:$w"; done',
      'wait',
    ].join('\n');
    const wrapped = cmds.wrapPidCapture(cmds.wrapInWorkFolder(process.cwd(), 'eval ' + escapeShellArg(payload)));

    const sentinel = spawn(bash.path!, ['-c', 'sleep 3099'], { stdio: 'ignore', windowsHide: true });
    const wrapper: ChildProcess = spawn(bash.path!, ['-c', wrapped], { windowsHide: true });
    let out = '';
    wrapper.stdout!.on('data', (d) => { out += d.toString(); });
    let wrapperExited = false;
    wrapper.on('exit', () => { wrapperExited = true; });
    const winpids: number[] = [];

    try {
      const ready = await waitFor(() => (out.match(/^W:\d+/gm) ?? []).length === 3 && /^G:\d+/m.test(out), 15000);
      expect(ready, `wrapper output so far: ${JSON.stringify(out)}`).toBe(true);
      const msysPid = Number(/^FLEET_PID:(\d+)/.exec(out)![1]);
      for (const m of out.matchAll(/^[WG]:(\d+)/gm)) winpids.push(Number(m[1]));
      expect(winpids).toHaveLength(4);
      for (const w of winpids) expect(alive(w), `winpid ${w} alive before kill`).toBe(true);
      expect(alive(sentinel.pid!)).toBe(true);

      const k = runBash(bash.path!, cmds.killPid(msysPid));
      expect(k.status).toBe(0);

      const allDead = await waitFor(() => winpids.every((w) => !alive(w)), 10000);
      expect(allDead, `still alive: ${winpids.filter(alive).join(',')}`).toBe(true);
      expect(await waitFor(() => wrapperExited, 10000)).toBe(true);
      // Nothing unrelated was killed.
      expect(alive(sentinel.pid!)).toBe(true);
      expect(sentinel.exitCode).toBeNull();
    } finally {
      for (const w of winpids) { try { process.kill(w, 'SIGKILL'); } catch { /* gone */ } }
      for (const p of [wrapper.pid, sentinel.pid]) {
        if (p) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(p)], { stdio: 'ignore', windowsHide: true });
      }
    }
  }, 60000);

  it('a recycled pid that is its own group leader kills only that pid, not its group', async () => {
    // Shape of an unrelated process that may have inherited a stale stored
    // pid: a group leader (here a bash with a child in its group). Only the
    // leader itself may die; the rest of its group must survive.
    const cmds = getOsCommands('windows', 'gitbash');
    const leader = spawn(bash.path!, ['-c', 'sleep 3097 & c=$!; sleep 1; read -r w < /proc/$c/winpid; echo "L:$$ W:$w"; wait'], { windowsHide: true });
    let out = '';
    leader.stdout!.on('data', (d) => { out += d.toString(); });
    let childWin: number | undefined;
    try {
      expect(await waitFor(() => /L:\d+ W:\d+/.test(out), 15000), out).toBe(true);
      const [, lp, w] = /L:(\d+) W:(\d+)/.exec(out)!;
      childWin = Number(w);
      const k = runBash(bash.path!, cmds.killPid(Number(lp)));
      expect(k.status).toBe(0);
      await new Promise((r) => setTimeout(r, 1500));
      expect(alive(childWin), 'group member of a leader pid must survive').toBe(true);
    } finally {
      if (childWin) { try { process.kill(childWin, 'SIGKILL'); } catch { /* gone */ } }
      if (leader.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(leader.pid)], { stdio: 'ignore', windowsHide: true });
    }
  }, 60000);

  it('a pid with no /proc entry is a harmless no-op (exit 0)', () => {
    const cmds = getOsCommands('windows', 'gitbash');
    const r = runBash(bash.path!, cmds.killPid(999999));
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });
});
