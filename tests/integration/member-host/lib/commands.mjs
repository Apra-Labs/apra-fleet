// Quote-led command cases for the member-host harness: commands whose FIRST
// character is a quote, which a Windows sshd whose default shell is Git Bash
// used to mangle (every argv entry was lost and the bare binary ran). Pure.
// The orchestrator's memberCommandFor now delivers POSIX member commands as
// base64 + eval, so the member must receive the exact argv. Each case echoes
// its argv back so the driver can compare it byte for byte.

export const QUOTE_LED_CASES = Object.freeze([
  {
    id: 'single-quoted-path',
    title: 'command starting with a single-quoted path',
    command: "'/usr/bin/printf' '%s|%s|%s' alpha 'be ta' gamma",
    expected: 'alpha|be ta|gamma',
  },
  {
    id: 'embedded-double-quotes',
    title: 'command with a double-quoted program and embedded double quotes',
    command: '"/usr/bin/printf" "%s|%s" "a \\"quoted\\" b" c',
    expected: 'a "quoted" b|c',
  },
]);

/** Compare what the member echoed with the case's expected argv echo (trailing newlines ignored). */
export function verifyEcho(testCase, output) {
  const got = String(output ?? '').replace(/\r/g, '').replace(/\n+$/, '');
  const ok = got === testCase.expected;
  return { ok, got, expected: testCase.expected };
}

/**
 * A Windows path as Git Bash names it: C:\Users\x -> /c/Users/x. Anything
 * that is not a drive path is returned with forward slashes only.
 */
export function gitBashPath(winPath) {
  const p = String(winPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^([A-Za-z]):(\/.*)?$/.exec(p);
  return m ? `/${m[1].toLowerCase()}${m[2] || ''}` : p;
}

/**
 * The member's work folder (Git Bash form) under the profile folder the setup
 * script read from the registry (info.home). Falls back to C:\Users\<user>
 * only when the info file carries no home.
 */
export function memberWorkFolder(info) {
  const home = info && info.home ? String(info.home) : `C:\\Users\\${info && info.user}`;
  return `${gitBashPath(home)}/work`;
}

/**
 * The install arguments for the baseline (the previous release) a pass puts
 * on the member before replace-full. The supervisor passes (RFS, and RBS, which
 * rolls back from the RFS backup) need the fleet-sprint runtime the default
 * install ships (~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs), so they
 * install WITHOUT --workflows none; RF/RB never start a supervisor and keep
 * the core-only install.
 */
export function baselineInstallArgs(pass) {
  switch (pass) {
    case 'RFS':
    case 'RBS':
      return [];
    case 'RF':
    case 'RB':
      return ['--workflows', 'none'];
    default:
      throw new Error(`pass ${pass} installs no baseline`);
  }
}

// ---------------------------------------------------------------------------
// Supervisor and stand-in sprint on the member (RFS / RBS). Every command is
// a Git Bash string; Windows paths are resolved in JS from info.home.
// ---------------------------------------------------------------------------

export const SUPERVISOR_PORT = 8787;
/** The installed fleet-sprint supervisor entry (Git Bash form). */
export const SUPERVISOR_ENTRY = '$HOME/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs';
export const SUPERVISOR_MISSING_MARKER = 'SUPERVISOR-ENTRY-MISSING';
/**
 * Where RFS copies the baseline's installed workflows/ before its
 * replace-full: the member install that replaces the full install carries no
 * fleet-sprint, so RBS starts its supervisor from this copy.
 */
export const SUPERVISOR_COPY_DIR = 'supervisor-workflows';
/** The candidate installer, copied to the member home to run its read-only `fleet-se-check`. */
export const CHECK_BIN = 'candidate-check.exe';
export const SPRINT_LOCK_NAME = 'member-host-standin.lock';
/** In the stand-in sprint's command line: the guard counts a lock only when its pid's command line looks like a fleet-sprint run. */
export const STANDIN_SPRINT_TAG = 'fleet-sprint-member-host-standin';

const psq = s => `'${String(s).replace(/'/g, "''")}'`;
const winJoin = (...parts) => parts.map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, ''))).join('\\');

/** A PowerShell script as a Git Bash command (UTF-16LE base64, -EncodedCommand). */
export function powershellEncoded(script) {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/**
 * Starts `commandLine` through WMI (Win32_Process.Create) and prints
 * `LAUNCHED rc=<n> pid=<pid>`. Windows sshd keeps a session's processes in a
 * job object that is closed with the session, so a background process started
 * from one execute_command does not reliably outlive it; a WMI-created process
 * is outside that job and survives into the next execute_command.
 */
export function wmiLaunchCommand(commandLine, cwd) {
  return powershellEncoded(
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psq(commandLine)}; CurrentDirectory = ${psq(cwd)} }; ` +
    `Write-Output ('LAUNCHED rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId); if ($r.ReturnValue -ne 0) { exit 1 }`,
  );
}

/** pid of a wmiLaunchCommand run, or null when it did not start. */
export function launchedPid(stdout) {
  const m = /^LAUNCHED rc=(\d+) pid=(\d+)\s*$/m.exec(String(stdout ?? '').replace(/\r/g, ''));
  return m && m[1] === '0' ? Number(m[2]) : null;
}

/** Prints the Windows path of node on the member (WMI needs a full path). */
export const NODE_PATH_COMMAND = 'cygpath -w "$(command -v node)"';

/** Windows path of serve.mjs: the installed tree, or RFS's copy of it. */
export function supervisorServePath(home, fromCopy) {
  return fromCopy
    ? winJoin(home, SUPERVISOR_COPY_DIR, 'fleet-sprint', 'bin', 'serve.mjs')
    : winJoin(home, '.apra-fleet', 'workflows', 'fleet-sprint', 'bin', 'serve.mjs');
}

/**
 * The supervisor's command line for wmiLaunchCommand. The member user's
 * profile variables are set explicitly (a WMI-created process does not get
 * the SSH session's environment), so it uses the member's own data dirs.
 * Output goes to <home>\supervisor.log.
 */
export function supervisorCommandLine({ node, serve, home }) {
  const env = {
    USERPROFILE: home, HOME: home,
    APPDATA: winJoin(home, 'AppData', 'Roaming'), LOCALAPPDATA: winJoin(home, 'AppData', 'Local'),
    TEMP: winJoin(home, 'AppData', 'Local', 'Temp'), TMP: winJoin(home, 'AppData', 'Local', 'Temp'),
  };
  const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join(' && ');
  return `cmd.exe /d /s /c "${sets} && "${node}" "${serve}" > "${winJoin(home, 'supervisor.log')}" 2>&1"`;
}

/**
 * Launches the supervisor detached from the SSH session. When the entry
 * script is absent (a core-only install, or no copy) it says so, naming the
 * path, instead of a generic failure.
 */
export function supervisorStartCommand({ node, home, fromCopy = false }) {
  const serve = supervisorServePath(home, fromCopy);
  const bashServe = gitBashPath(serve);
  return `if [ ! -f "${bashServe}" ]; then echo "${SUPERVISOR_MISSING_MARKER}: ${bashServe} does not exist on the member (the install shipped no fleet-sprint runtime; install without --workflows none)"; exit 1; fi; ` +
    wmiLaunchCommand(supervisorCommandLine({ node, serve, home }), home);
}

/**
 * The supervisor-started step: the launch printed a pid AND, in a LATER
 * execute_command (so it outlived the launching SSH session), the
 * candidate's fleet-se-check reports a supervisor. A missing entry script is
 * reported with its path.
 */
export function supervisorStartOutcome(launchText, checkText = '') {
  const t = String(launchText ?? '');
  const missing = t.split(/\r?\n/).find(l => l.includes(SUPERVISOR_MISSING_MARKER));
  if (missing) return { exit: 1, observed: missing.trim() };
  const pid = launchedPid(t);
  const found = parseFleetSe(checkText).supervisor;
  return {
    exit: pid && found ? 0 : 1,
    observed: pid ? `launched pid ${pid}; fleet-se-check: ${found ? `supervisor pid=${found.pid} port=${found.port}` : String(checkText ?? '').trim().slice(-200) || '(none)'}` : launchFailureLine(t),
  };
}

/**
 * Why a wmiLaunchCommand printed no pid: the PowerShell error MESSAGE line
 * (the tail of a PowerShell error is CategoryInfo / FullyQualifiedErrorId,
 * which hides it), else the LAUNCHED line with its WMI return code, else the tail.
 */
export function launchFailureLine(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const pick = lines.find(l => /^LAUNCHED rc=/.test(l))
    ?? lines.find(l => /Invoke-CimMethod|denied|not recognized|cannot|error/i.test(l) && !/^(\+|CategoryInfo|FullyQualifiedErrorId)/.test(l));
  return (pick ?? lines.slice(-3).join(' | ') ?? '').slice(0, 300) || '(no output)';
}

/** A long-lived stand-in for a running sprint (no LLM): node idling, its command line tagged as fleet-sprint. */
export function standInSprintCommandLine({ node }) {
  return `"${node}" -e "setTimeout(function(){}, 3600000)" ${STANDIN_SPRINT_TAG}`;
}

function checkPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad pid ${pid}`);
  return n;
}

/**
 * Writes the stand-in's sprint lock where the install guard looks
 * (<os.tmpdir()>/apra-fleet-sprint-locks of the member SSH session, the same
 * environment fleet-se-check runs in).
 */
export function sprintLockCommand(pid) {
  const n = checkPid(pid);
  return `node -e "const fs=require('fs'),p=require('path'),d=p.join(require('os').tmpdir(),'apra-fleet-sprint-locks');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'${SPRINT_LOCK_NAME}'),'${n}')" && ${fleetSeCheckCommand()}`;
}

/** Ends the stand-in and removes its lock, then runs fleetSeCheckCommand. */
export function sprintStopCommand(pid) {
  const n = checkPid(pid);
  return `${powershellEncoded(`Stop-Process -Id ${n} -Force -ErrorAction SilentlyContinue; exit 0`)}; ` +
    `node -e "require('fs').rmSync(require('path').join(require('os').tmpdir(),'apra-fleet-sprint-locks','${SPRINT_LOCK_NAME}'),{force:true})" && ${fleetSeCheckCommand()}`;
}

/** The candidate's read-only fleet-se-check (the install guard's own detection), run from the copy in the member home. */
export function fleetSeCheckCommand() {
  return `"$HOME/${CHECK_BIN}" fleet-se-check`;
}

/** Waits (up to `seconds`) for the supervisor's /api/health, then runs fleetSeCheckCommand. */
export function waitSupervisorUpCommand(seconds = 90) {
  return `i=0; while [ "$i" -lt ${seconds} ] && ! curl -s -m 2 -o /dev/null http://127.0.0.1:${SUPERVISOR_PORT}/api/health; do sleep 1; i=$((i+1)); done; ${fleetSeCheckCommand()}`;
}

/** Graceful stop (POST /api/shutdown with a JSON body), wait until /api/health stops answering, then fleetSeCheckCommand. */
export function supervisorStopCommand() {
  const base = `http://127.0.0.1:${SUPERVISOR_PORT}/api`;
  return `curl -s -m 10 -o /dev/null -X POST ${base}/shutdown -H 'Content-Type: application/json' -d '{}'; ` +
    `i=0; while [ "$i" -lt 60 ] && curl -s -m 2 -o /dev/null ${base}/health; do sleep 1; i=$((i+1)); done; ${fleetSeCheckCommand()}`;
}

/** Parses fleet-se-check output: { ok, supervisor: {pid, port} | null, sprints: [pid] }. */
export function parseFleetSe(stdout) {
  const lines = String(stdout ?? '').replace(/\r/g, '').split('\n').map(l => l.trim());
  const sup = lines.map(l => /^FLEET_SE supervisor pid=(\d+) port=(\d+)/.exec(l)).find(Boolean);
  return {
    ok: lines.includes('FLEET_SE_CHECK ok'),
    supervisor: sup ? { pid: Number(sup[1]), port: Number(sup[2]) } : null,
    sprints: lines.map(l => /^FLEET_SE sprint pid=(\d+)/.exec(l)).filter(Boolean).map(m => Number(m[1])),
  };
}

/** Whether replace-full's result says it stopped the idle supervisor (src/services/member-fleet-install.ts). */
export function idleSupervisorStoppedNote(text, port = SUPERVISOR_PORT) {
  return String(text ?? '').includes(`the idle fleet-sprint supervisor (port ${port}) was stopped in step 0`);
}
