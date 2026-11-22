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

/**
 * True when a command line, or the payload of a `Bash(...)`/`PowerShell(...)`
 * rule, names a process-killing command: the command token itself (path and
 * .exe stripped, any case; a wildcard prefix such as `kil*` that covers one),
 * a later token that IS one (`xargs kill`, `powershell -Command
 * Stop-Process`), or wmic in a form that can delete/terminate a process. A
 * token that merely contains a kill word (`kill-port.mjs`) does not match.
 * @param {string} payload
 */
export function payloadKillsProcesses(payload) {
    const spaced = String(payload || '').replace(/:/g, (_m, off, str) => {
        const driveLetter = off >= 1 && /[A-Za-z]/.test(str[off - 1]) && (off === 1 || /\s/.test(str[off - 2]));
        return driveLetter && /[\\/]/.test(str[off + 1] || '') ? ':' : ' ';
    });
    const tokens = spaced.replace(/[(){};|&]/g, ' ').trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
        const raw = tokens[i];
        const wildcard = raw.endsWith('*');
        const name = commandName(raw.replace(/\*+$/, ''));
        if (name === 'wmic') {
            if (wmicCanKill(tokens.slice(i + 1))) return true;
            continue;
        }
        if (KILL_TOKENS.has(name)) return true;
        if (i === 0 && wildcard && name) {
            if ([...KILL_TOKENS, 'wmic'].some((k) => k.startsWith(name))) return true;
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
