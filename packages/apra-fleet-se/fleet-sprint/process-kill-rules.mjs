// Process-killing commands the sprint engine never grants a member.
//
// A local member shares its host with the fleet server, the supervisor and
// other sprint engines, so a role that kills processes by name there takes
// them down. compose_permissions refuses these grants and denies the commands
// in every composed config (src/services/process-kill-rules.ts on the server
// side); this is the engine's copy of the same command set, so the engine
// never even asks for such a grant -- neither from a permission heal nor from
// a deploy.md Permissions section. A parity test keeps the two in step.

/** The commands, in their canonical spelling (matching is case-insensitive). */
export const PROCESS_KILL_COMMANDS = Object.freeze([
    'kill',
    'pkill',
    'killall',
    'taskkill',
    'tskill',
    'Stop-Process',
    'spps',
    'wmic process',
]);

/** Typed reason the engine logs and returns for a refused process-kill grant. */
export const PROCESS_KILL_REFUSED = 'process_kill_refused';

const KILL_TOKENS = new Set(['kill', 'pkill', 'killall', 'taskkill', 'tskill', 'stop-process', 'spps']);
const COMMAND_TOOLS = new Set(['bash', 'powershell']);

function commandName(token) {
    const base = String(token).replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop() || '';
    return base.toLowerCase().replace(/\.exe$/, '');
}

function wmicCanKill(args) {
    if (args.length === 0) return true;
    const lower = args.map((a) => a.toLowerCase());
    const first = lower[0];
    if (first.includes('*')) return 'process'.startsWith(first.replace(/\*+$/, ''));
    const hasProcess = lower.some((a) => a.replace(/\*+$/, '') === 'process' || a.includes('win32_process'));
    if (!hasProcess) return false;
    return lower.some((a) => a.includes('*') || a === 'delete' || a === 'terminate');
}

/** Words after which the next word is itself a command to run. */
const LAUNCHERS = new Set([
  'xargs', 'sudo', 'doas', 'env', 'nohup', 'timeout', 'time', 'command', 'exec', 'nice', 'setsid', 'stdbuf',
  'builtin', 'watch', 'busybox', 'parallel', 'then', 'do', 'else', '!',
  'cmd', 'start', 'call', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'powershell', 'pwsh',
]);

/** A launcher's own option (`-r`, `-n1`, `/c`, `5`, `FOO=bar`), skipped to reach the command. */
function isLauncherOption(token) {
  return /^-/.test(token) || /^\/[a-z]$/i.test(token) || /^\d+$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Options that make a launcher run the next (quoted) word as a command line. */
const SHELL_COMMAND_FLAG = /^(-[a-z]*c|-command|\/[ck])$/i;

/** Split a command line into segments at `| ; & ( ) { }`, backtick and
 *  newline, each a list of words with a quoted flag. */
function segmentWords(spaced) {
  const segments = [[]];
  const re = /"([^"]*)"|'([^']*)'|([|;&(){}`\n]+)|([^\s"'|;&(){}`]+)/g;
  let m;
  while ((m = re.exec(spaced)) !== null) {
    if (m[3] !== undefined) { segments.push([]); continue; }
    segments[segments.length - 1].push({ text: m[1] ?? m[2] ?? m[4], quoted: m[4] === undefined });
  }
  return segments.filter((s) => s.length > 0);
}

/**
 * True when a command line, or the payload of a `Bash(...)`/`PowerShell(...)`
 * rule, runs a process-killing command. The ':' that separates a command
 * prefix from its argument pattern counts as a space, and whitespace is
 * collapsed, so `kill:*`, `kill *` and ` kill  -9 *` are the same request.
 *  - a kill command matches only at a COMMAND position: the first word of a
 *    segment (split at `| ; & ( )`), or the word a launcher runs
 *    (`xargs kill`, `sudo kill`, `cmd /c taskkill`);
 *  - a launcher's quoted command line is checked too (`bash -c "kill 1"`,
 *    `powershell -Command "Stop-Process -Id 1"`); any other quoted text, and
 *    any argument, is not (`git commit -m "fix kill race"`, `grep -rn kill`);
 *  - a wildcard prefix that covers a kill command (`kil*`, `task*`) matches
 *    as the payload's first word;
 *  - wmic matches only in a form that can delete/terminate a process.
 * A word that merely contains a kill word (`kill-port.mjs`) does not match.
 */
export function payloadKillsProcesses(payload, depth = 0) {
  // Every ':' counts as a separator except a drive letter's (`C:/...`,
  // `C:\...` at the start of a word).
  const spaced = String(payload || '').replace(/:/g, (_m, off, str) => {
    const driveLetter = off >= 1 && /[A-Za-z]/.test(str[off - 1]) && (off === 1 || /\s/.test(str[off - 2]));
    return driveLetter && /[\\/]/.test(str[off + 1] || '') ? ':' : ' ';
  });
  let firstWord = true;
  for (const words of segmentWords(spaced)) {
    let state = 'cmd';
    let shellFlag = false;
    for (let i = 0; i < words.length; i++) {
      const { text, quoted } = words[i];
      const isFirst = firstWord;
      firstWord = false;
      if (state === 'args') continue;
      if (shellFlag && quoted) {
        shellFlag = false;
        if (depth < 3 && payloadKillsProcesses(text, depth + 1)) return true;
        continue;
      }
      shellFlag = false;
      // Leading NAME=value assignments precede the command word (`FOO=1 kill 1`).
      if (state === 'cmd' && !quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) continue;
      // A leading wildcard word can stand for a launcher (`Bash(* kill:*)`).
      if (state === 'cmd' && !quoted && text === '*') { state = 'launcher'; continue; }
      if (state === 'launcher' && !quoted && isLauncherOption(text)) {
        shellFlag = SHELL_COMMAND_FLAG.test(text);
        continue;
      }
      const wildcard = !quoted && text.endsWith('*');
      const name = commandName(text.replace(/\*+$/, ''));
      if (name === 'wmic') {
        if (wmicCanKill(words.slice(i + 1).map((w) => w.text))) return true;
        break;
      }
      if (KILL_TOKENS.has(name)) return true;
      if (isFirst && wildcard && name && [...KILL_TOKENS, 'wmic'].some((k) => k.startsWith(name))) return true;
      state = LAUNCHERS.has(name) ? 'launcher' : 'args';
    }
  }
  return false;
}

/**
 * True when a permission rule (`Bash(kill:*)`, `PowerShell(Stop-Process *)`)
 * grants a process-killing command. Bare tool names and non-command tools
 * never match.
 * @param {string} permission
 */
export function isProcessKillGrant(permission) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\(([\s\S]*)\)\s*$/.exec(String(permission || ''));
    if (!m) return false;
    if (!COMMAND_TOOLS.has(m[1].toLowerCase())) return false;
    return payloadKillsProcesses(m[2].replace(/\s+/g, ' '));
}

/**
 * True when one refused tool call (a permission denial entry: `{ action,
 * target, suggestedGrants }`) is a process-killing command: a shell call
 * whose command line kills processes, or a call whose suggested grants are
 * process-kill grants.
 * @param {{ action?: string, target?: string, suggestedGrants?: string[] }} call
 */
export function isProcessKillCall(call) {
    if (!call || typeof call !== 'object') return false;
    const action = String(call.action || '');
    const shell = action === 'Bash' || action === 'PowerShell' || action === 'command' || action === 'unsandboxed';
    if (shell && typeof call.target === 'string' && payloadKillsProcesses(call.target.replace(/\s+/g, ' '))) return true;
    const grants = Array.isArray(call.suggestedGrants) ? call.suggestedGrants : [];
    return grants.some((g) => isProcessKillGrant(g));
}
