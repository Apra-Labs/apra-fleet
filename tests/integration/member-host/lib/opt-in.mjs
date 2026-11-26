// Disposable-machine opt-in for the member-host harness. Pure; unit-tested by
// tests/member-host-harness.test.ts. Same style as fresh-install/lib/host.mjs
// (hostRefusal): BOTH env CI=true and an explicit flag, a loud refusal never a
// warning. The setup script (setup-openssh-gitbash.ps1) mirrors this check and
// the unit test pins the two together.

export const DISPOSABLE_FLAG = '--i-am-disposable';
/** PowerShell spelling of the same flag on the setup script. */
export const DISPOSABLE_PS_SWITCH = '-IAmDisposable';

/**
 * Returns null when the run may proceed, else the refusal message.
 * `needWindows`: the setup script installs Windows OpenSSH and only runs there.
 */
export function disposableRefusal({ env = {}, optInFlag = false, platform = process.platform, needWindows = false } = {}) {
  const why = [];
  if (env.CI !== 'true') why.push('env CI is not "true"');
  if (!optInFlag) why.push(`${DISPOSABLE_FLAG} was not passed`);
  if (why.length) {
    return `REFUSED: the member-host harness installs an SSH server, creates a user and installs apra-fleet on THIS machine and never cleans up; it only runs on a disposable CI VM (${why.join('; ')}). Set CI=true and pass ${DISPOSABLE_FLAG} only on a throwaway machine.`;
  }
  if (needWindows && platform !== 'win32') {
    return `REFUSED: the OpenSSH + Git Bash member host is a Windows setup; this machine is ${platform}.`;
  }
  return null;
}
