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

export const SUPERVISOR_ENTRY = '$HOME/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs';
export const SUPERVISOR_MISSING_MARKER = 'SUPERVISOR-ENTRY-MISSING';

/**
 * Starts the fleet-sprint supervisor on the member and asks the fleet whether
 * it is running. When the entry script is absent (a core-only install) the
 * command says so, naming the path, instead of a generic failure.
 */
export function supervisorStartCommand(fleetBin) {
  return `if [ ! -f "${SUPERVISOR_ENTRY}" ]; then echo "${SUPERVISOR_MISSING_MARKER}: ${SUPERVISOR_ENTRY} does not exist on the member (the install shipped no fleet-sprint runtime; install without --workflows none)"; exit 1; fi; ` +
    `nohup node "${SUPERVISOR_ENTRY}" > "$HOME/supervisor.log" 2>&1 & sleep 8; "${fleetBin}" fleet-se-check`;
}

/** The record fields for the supervisor-started step: exit 0 only when the fleet reports it running; a missing entry script is reported with its path. */
export function supervisorStartOutcome(text) {
  const t = String(text ?? '');
  const missing = t.split(/\r?\n/).find(l => l.includes(SUPERVISOR_MISSING_MARKER));
  if (missing) return { exit: 1, observed: missing.trim() };
  return { exit: /FLEET_SE supervisor/.test(t) ? 0 : 1, observed: t.slice(-200) };
}
