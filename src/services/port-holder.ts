// Who holds a local TCP port: used by `apra-fleet start`, the server's own
// startup and `apra-fleet install` when the configured port is already bound.
//
// Two Unix users on one host can each have a member install, but not on the
// same port: the server binds 127.0.0.1:<port> with no fallback. When the
// port is held by ANOTHER user's process, the operator must be told who holds
// it and how to fix it (give this install its own port), instead of a generic
// "port in use" -- or worse, sessions silently reaching the other user's
// server. A port held by this user's own apra-fleet for THIS data dir is the
// existing already-running reuse path (checkRunningInstance), decided before
// any of this runs.
//
// Everything here runs locally on the machine that owns the port (install,
// start and the server run ON the member), so the probes are built in
// JavaScript and run through Node -- never a member-bound shell string:
//  - linux: /proc/net/tcp{,6} gives the listening socket's uid and inode for
//    ANY user; the pid is found by matching the inode in /proc/<pid>/fd,
//    which is only readable for this user's own processes (another user's pid
//    is reported as not visible, never guessed);
//  - macOS: lsof -iTCP:<port> -sTCP:LISTEN;
//  - windows: Get-NetTCPConnection + the owning process's GetOwner(), run as
//    an encoded PowerShell command (src/os/windows.ts wrapPowerShellEncoded).
// Every probe is best effort and never throws: an unknown holder falls back
// to the existing port-in-use message.

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { wrapPowerShellEncoded } from '../os/windows.js';

export interface PortHolder {
  /** Holding process id; absent when it is not visible to this user. */
  pid?: number;
  /** Login name of the holding process's owner, when known. */
  user?: string;
  /** Numeric uid of the owner (POSIX), when known. */
  uid?: number;
  /** Holding process's command name, when known. */
  command?: string;
}

export type PortHolderProbe = (port: number) => Promise<PortHolder | null>;

let probeOverride: PortHolderProbe | null = null;

/** Test hook: replace the platform probe (null restores it). */
export function _setPortHolderProbeOverride(fn: PortHolderProbe | null): void {
  probeOverride = fn;
}

const PROBE_TIMEOUT_MS = 8000;

/** The process holding a LISTEN socket on `port`, or null when unknown. Never throws. */
export async function findPortHolder(port: number): Promise<PortHolder | null> {
  try {
    if (probeOverride) return await probeOverride(port);
    if (process.platform === 'linux') return linuxPortHolder(port);
    if (process.platform === 'darwin') return lsofPortHolder(port);
    if (process.platform === 'win32') return windowsPortHolder(port);
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// linux
// ---------------------------------------------------------------------------

/** Parse /proc/net/tcp(6) text: the uid and inode of the LISTEN socket on `port`. */
export function parseProcNetTcp(text: string, port: number): { uid: number; inode: string } | null {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const local = f[1];
    const state = f[3];
    if (state !== '0A') continue; // TCP_LISTEN
    if (local.slice(local.lastIndexOf(':') + 1).toUpperCase() !== portHex) continue;
    const uid = Number(f[7]);
    if (!Number.isInteger(uid)) continue;
    return { uid, inode: f[9] };
  }
  return null;
}

/** Login name for a uid from /etc/passwd text, or undefined. */
export function userFromPasswd(text: string, uid: number): string | undefined {
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length >= 3 && Number(f[2]) === uid && f[0]) return f[0];
  }
  return undefined;
}

function linuxUserName(uid: number): string | undefined {
  try {
    const u = userFromPasswd(fs.readFileSync('/etc/passwd', 'utf8'), uid);
    if (u) return u;
  } catch { /* fall through to getent (LDAP/NSS users) */ }
  try {
    const out = execFileSync('getent', ['passwd', String(uid)], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    return userFromPasswd(String(out), uid);
  } catch {
    return undefined;
  }
}

function linuxPidForInode(inode: string): number | undefined {
  const target = `socket:[${inode}]`;
  let pids: string[];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch { return undefined; }
  for (const pid of pids) {
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; } // another user's process
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === target) return Number(pid);
      } catch { /* closed meanwhile */ }
    }
  }
  return undefined;
}

function linuxCommand(pid: number): string | undefined {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || undefined; } catch { return undefined; }
}

function linuxPortHolder(port: number): PortHolder | null {
  let hit: { uid: number; inode: string } | null = null;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { hit = parseProcNetTcp(fs.readFileSync(f, 'utf8'), port); } catch { hit = null; }
    if (hit) break;
  }
  if (!hit) return null;
  const pid = linuxPidForInode(hit.inode);
  const user = linuxUserName(hit.uid);
  const command = pid !== undefined ? linuxCommand(pid) : undefined;
  return { uid: hit.uid, ...(user ? { user } : {}), ...(pid !== undefined ? { pid } : {}), ...(command ? { command } : {}) };
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/** Parse `lsof -F pcLu` output: the first process record. */
export function parseLsofFields(out: string): PortHolder | null {
  const h: PortHolder = {};
  for (const line of out.split('\n')) {
    const tag = line[0];
    const v = line.slice(1).trim();
    if (!v) continue;
    if (tag === 'p') { if (h.pid !== undefined) break; h.pid = Number(v); }
    else if (tag === 'c' && !h.command) h.command = v;
    else if (tag === 'L' && !h.user) h.user = v;
    else if (tag === 'u' && h.uid === undefined) h.uid = Number(v);
  }
  return h.pid !== undefined || h.user ? h : null;
}

function lsofPortHolder(port: number): PortHolder | null {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-FpcLu'], {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseLsofFields(String(out));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

/** The PowerShell probe (wrapped with wrapPowerShellEncoded before it runs). */
export function windowsPortHolderScript(port: number): string {
  const p = Math.trunc(port);
  return `$c = Get-NetTCPConnection -State Listen -LocalPort ${p} -ErrorAction SilentlyContinue | Select-Object -First 1; `
    + `if ($c) { $procId = [int]$c.OwningProcess; $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId) -ErrorAction SilentlyContinue; `
    + `$owner = $null; if ($proc) { try { $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction Stop } catch { $owner = $null } }; `
    + `[Console]::Out.Write((@{ pid = $procId; name = $(if ($proc) { $proc.Name } else { $null }); user = $(if ($owner) { $owner.User } else { $null }) } | ConvertTo-Json -Compress)) }`;
}

/** Parse the PowerShell probe's JSON line. */
export function parseWindowsPortHolder(out: string): PortHolder | null {
  const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return null;
  try {
    const j = JSON.parse(line) as { pid?: unknown; name?: unknown; user?: unknown };
    const pid = typeof j.pid === 'number' && j.pid > 0 ? j.pid : undefined;
    const user = typeof j.user === 'string' && j.user ? j.user : undefined;
    const command = typeof j.name === 'string' && j.name ? j.name : undefined;
    if (pid === undefined && !user) return null;
    return { ...(pid !== undefined ? { pid } : {}), ...(user ? { user } : {}), ...(command ? { command } : {}) };
  } catch {
    return null;
  }
}

function windowsPortHolder(port: number): PortHolder | null {
  try {
    const out = execSync(wrapPowerShellEncoded(windowsPortHolderScript(port)), {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    return parseWindowsPortHolder(String(out ?? ''));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// classification and messages
// ---------------------------------------------------------------------------

/** This process's user (name and, on POSIX, uid). */
export function currentUser(): { user?: string; uid?: number } {
  let user: string | undefined;
  try { user = os.userInfo().username; } catch { /* unknown */ }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return { ...(user ? { user } : {}), ...(uid !== undefined ? { uid } : {}) };
}

/**
 * True when the holder belongs to a different user than `me`, false when it
 * is the same user, undefined when that cannot be told. uid wins over the
 * name when both sides have one; names compare case-insensitively (Windows).
 */
export function heldByOtherUser(holder: PortHolder, me: { user?: string; uid?: number } = currentUser()): boolean | undefined {
  if (holder.uid !== undefined && me.uid !== undefined) return holder.uid !== me.uid;
  if (holder.user && me.user) return holder.user.toLowerCase() !== me.user.toLowerCase();
  return undefined;
}

/** Machine-readable code on the refusal when another user holds the port. */
export const PORT_HELD_BY_OTHER_USER_CODE = 'E-PORT-HELD-BY-OTHER-USER';

function holderPhrase(holder: PortHolder): string {
  const who = holder.user ?? (holder.uid !== undefined ? `uid ${holder.uid}` : 'an unknown user');
  const pid = holder.pid !== undefined ? `pid ${holder.pid}` : 'pid not visible to this user';
  return `user "${who}" (${pid}${holder.command ? `, ${holder.command}` : ''})`;
}

/** The refusal when ANOTHER user's process holds the port: who, pid, remedy. */
export function portHeldByOtherUserMessage(port: number, holder: PortHolder, me: { user?: string; uid?: number } = currentUser()): string {
  const self = me.user ? ` (this is "${me.user}")` : '';
  return `${PORT_HELD_BY_OTHER_USER_CODE}: port ${port} on 127.0.0.1 is held by ${holderPhrase(holder)}, another user's process${self}. `
    + 'apra-fleet will not share or take over another user\'s server. '
    + 'Remedy: give this install its own port -- re-run "apra-fleet install --member --port <free port>" '
    + '(or set APRA_FLEET_PORT to a free port and re-run "apra-fleet install"); the fleet picks up the new port on its next fleet_install "auto" probe.';
}

/**
 * The full operator message for a configured port that is taken, given the
 * generic port-in-use text. Another user's holder -> the refusal above (with
 * `foreign: true`); otherwise the generic text plus the holder when known.
 */
export function describePortConflict(
  port: number,
  genericMessage: string,
  holder: PortHolder | null,
  me: { user?: string; uid?: number } = currentUser(),
): { foreign: boolean; message: string } {
  if (holder && heldByOtherUser(holder, me) === true) {
    return { foreign: true, message: portHeldByOtherUserMessage(port, holder, me) };
  }
  if (holder) return { foreign: false, message: `${genericMessage} Holder: ${holderPhrase(holder)}.` };
  return { foreign: false, message: genericMessage };
}
