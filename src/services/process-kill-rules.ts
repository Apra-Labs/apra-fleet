/**
 * Process-killing commands: never granted to a member, and denied in every
 * permission config compose_permissions writes.
 *
 * Why: a local member shares its host with the fleet server, the supervisor
 * and other sprint engines. A dispatched role that "cleans up" by killing
 * processes by name (taskkill /F /IM node.exe, pkill node, ...) takes all of
 * them down. A role may only stop a process it started itself, by the pid it
 * recorded -- and that goes through the target's own scripts, not a broad
 * kill grant.
 *
 * Honesty note: the deny rules REDUCE the risk; they cannot make a kill
 * impossible while a member is allowed other interpreters (Bash(bash:*),
 * Bash(sh:*), Bash(node:*), powershell, ...) that can run the same command
 * indirectly. The grant refusal and the role prompts are the other layers.
 *
 * The fleet-sprint engine keeps its own copy of the command set
 * (packages/apra-fleet-se/fleet-sprint/process-kill-rules.mjs, a package that
 * cannot import this TypeScript); a parity test keeps the two in step.
 */

/** The commands, in their canonical spelling (matching is case-insensitive). */
export const PROCESS_KILL_COMMANDS: readonly string[] = Object.freeze([
  'kill',
  'pkill',
  'killall',
  'taskkill',
  'tskill',
  'Stop-Process',
  'spps',
  'wmic process',
]);

/** Single-token kill commands (wmic is handled separately: only its process
 *  delete/terminate forms kill). */
const KILL_TOKENS = new Set(['kill', 'pkill', 'killall', 'taskkill', 'tskill', 'stop-process', 'spps']);

/** Tools whose payload is a command line. */
const COMMAND_TOOLS = new Set(['bash', 'powershell']);

/** Lower-cased command name of one token: path and a trailing .exe stripped
 *  (`/usr/bin/kill` -> kill, `C:\Windows\System32\taskkill.exe` -> taskkill). */
function commandName(token: string): string {
  const base = token.replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** True when a wmic invocation (the tokens after `wmic`) can kill a process:
 *  no arguments (interactive console), a wildcard first argument (covers
 *  `process`), or a `process` alias together with delete, terminate or any
 *  wildcard. `wmic process list` (read-only) stays grantable. */
function wmicCanKill(args: string[]): boolean {
  if (args.length === 0) return true;
  const lower = args.map(a => a.toLowerCase());
  const first = lower[0]!;
  if (first.includes('*')) return 'process'.startsWith(first.replace(/\*+$/, ''));
  const hasProcess = lower.some(a => a.replace(/\*+$/, '') === 'process' || a.includes('win32_process'));
  if (!hasProcess) return false;
  return lower.some(a => a.includes('*') || a === 'delete' || a === 'terminate');
}

/**
 * True when a command-line payload (the part inside `Bash(...)` or
 * `PowerShell(...)`) names a process-killing command. The ':' that separates
 * a command prefix from its argument pattern counts as a space, and
 * whitespace is collapsed, so `kill:*`, `kill *` and ` kill  -9 *` are the
 * same request.
 *  - the first token (the command) matches by name, and a wildcard prefix
 *    that covers a kill command (`kil*`, `task*`) matches too;
 *  - any later token that IS a kill command matches (`xargs kill`,
 *    `powershell -Command Stop-Process`, `cmd /c taskkill`);
 *  - wmic matches only in a form that can delete/terminate a process.
 * A token that merely contains a kill word (`kill-port.mjs`) does not match.
 */
export function payloadKillsProcesses(payload: string): boolean {
  // Every ':' counts as a separator except a drive letter's (`C:/...`,
  // `C:\...` at the start of a token).
  const spaced = payload.replace(/:/g, (_m, off: number, str: string) => {
    const driveLetter = off >= 1 && /[A-Za-z]/.test(str[off - 1]!) && (off === 1 || /\s/.test(str[off - 2]!));
    return driveLetter && /[\\/]/.test(str[off + 1] ?? '') ? ':' : ' ';
  });
  const tokens = spaced.replace(/[(){};|&]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!;
    const wildcard = raw.endsWith('*');
    const name = commandName(raw.replace(/\*+$/, ''));
    if (name === 'wmic') {
      if (wmicCanKill(tokens.slice(i + 1))) return true;
      continue;
    }
    if (KILL_TOKENS.has(name)) return true;
    if (i === 0 && wildcard && name) {
      if ([...KILL_TOKENS, 'wmic'].some(k => k.startsWith(name))) return true;
    }
  }
  return false;
}

/** True when a permission rule (`Bash(kill:*)`, `PowerShell(Stop-Process *)`)
 *  grants a process-killing command. Bare tool names and non-command tools
 *  never match. */
export function isProcessKillGrant(permission: string): boolean {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\(([\s\S]*)\)\s*$/.exec(permission);
  if (!m) return false;
  if (!COMMAND_TOOLS.has(m[1]!.toLowerCase())) return false;
  return payloadKillsProcesses(m[2]!.replace(/\s+/g, ' '));
}

/** The command prefixes the deny rules name, per provider form below. Covers
 *  the common spellings a role reaches for; `xargs kill` catches the usual
 *  `ps ... | xargs kill` pipeline. */
const DENY_COMMAND_PREFIXES: readonly string[] = Object.freeze([
  'kill',
  'pkill',
  'killall',
  'xargs kill',
  'taskkill',
  'taskkill.exe',
  'tskill',
  'tskill.exe',
  'Stop-Process',
  'wmic process',
  'wmic.exe process',
]);

/** Claude permissions.deny rules (Bash prefix form) for process-killing
 *  commands. Also the form copilot's tools.deny takes (its allow list is the
 *  same Claude-form rules). */
export function claudeProcessKillDenyRules(): string[] {
  return DENY_COMMAND_PREFIXES.map(p => `Bash(${p}:*)`);
}

/** agy permissionGrants.deny rules for the same prefixes. `buildCommandRules`
 *  is agyCommandRules (passed in to keep this module free of provider
 *  imports): the bare command plus a full-line regex, so the deny matches
 *  command lines agy cannot split into words. */
export function agyProcessKillDenyRules(buildCommandRules: (cmd: string) => string[]): string[] {
  const out: string[] = [];
  for (const p of DENY_COMMAND_PREFIXES) {
    for (const t of buildCommandRules(p)) {
      const rule = `command(${t})`;
      if (!out.includes(rule)) out.push(rule);
    }
  }
  return out;
}
