// Deterministic execute_command wrapper checks, run against a REAL member over
// its real transport (local linux/macOS/Git Bash, remote linux ssh, remote
// macOS zsh, remote Git Bash over Windows OpenSSH).
//
// Shared by .github/e2e/fleet-setup.mjs (remote + local e2e members on the
// self-hosted fleet-linux/fleet-macos/fleet-windows runners) and
// tests/execute-command-transport-integ.test.ts (local member, every OS in
// CI). Plain ESM, ASCII only, no repo imports -- fleet-setup.mjs runs it
// from a checkout without a build.
//
// `fleetApi` is anything with executeCommand({ member_name, command,
// timeout_s }) resolving to an MCP tool result ({ content, structuredContent })
// -- the apra-fleet-client ApraFleet instance, or a test adapter around the
// in-process tool.

function textOf(result) {
  if (typeof result === 'string') return result;
  return (result?.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function run(fleetApi, member, command, timeoutS = 60) {
  const result = await fleetApi.executeCommand({ member_name: member.name, command, timeout_s: timeoutS });
  const sc = typeof result === 'string' ? undefined : result?.structuredContent;
  return {
    exitCode: sc?.exitCode,
    stdout: (sc?.stdout ?? '').replace(/\r/g, ''),
    stderr: (sc?.stderr ?? '').replace(/\r/g, ''),
    text: textOf(result),
  };
}

/** UTF-16LE base64 for `powershell -EncodedCommand` -- shell-agnostic as a
 *  string, so it runs the same from bash.exe or powershell.exe. */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Regex alternation matching `sleep <n>` for each n, written so the
 *  checker's own command line can never match itself (`[3]1234` matches
 *  "31234" but does not contain it). */
export function selfSafeSleepPattern(nums) {
  return nums.map((n) => { const s = String(n); return `sleep [${s[0]}]${s.slice(1)}`; }).join('|');
}

/** Command printing how many `sleep <n>` processes are alive on the member. */
export function countSleepsCommand(os, nums) {
  if (os === 'windows') {
    const re = ` (${nums.join('|')})\\s*$`;
    const ps = `@(Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -match '${re}' }).Count`;
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(ps)}`;
  }
  return `pgrep -f '${selfSafeSleepPattern(nums)}' | wc -l`;
}

/** Best-effort cleanup of any `sleep <n>` left behind. */
export function killSleepsCommand(os, nums) {
  if (os === 'windows') {
    const re = ` (${nums.join('|')})\\s*$`;
    const ps = `Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -match '${re}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(ps)}`;
  }
  return `pkill -9 -f '${selfSafeSleepPattern(nums)}'; true`;
}

/** True when the member's shell speaks POSIX (linux/macOS always; windows only
 *  under Git Bash -- PowerShell leaves both variables empty). */
async function isPosixMember(fleetApi, member) {
  if (member.os !== 'windows') return true;
  const r = await run(fleetApi, member, 'echo "$BASH_VERSION$ZSH_VERSION"');
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

async function sleepFor(ms) { await new Promise((r) => setTimeout(r, ms)); }

/**
 * Run the wrapper checks on one member. Returns [{ id, status, notes }] with
 * status PASS | FAIL | SKIP | KNOWN_GAP. Never throws for a failed check.
 *
 * member: { name, os: 'linux'|'macos'|'windows', type: 'local'|'remote' }
 */
export async function runExecWrapperChecks(fleetApi, member, opts = {}) {
  const killWaitMs = opts.killWaitMs ?? 20000;
  const timeoutS = opts.timeoutS ?? 4;
  const results = [];
  const record = (id, ok, notes, failStatus = 'FAIL') => results.push({ id, status: ok ? 'PASS' : failStatus, notes });

  const posix = await isPosixMember(fleetApi, member);

  // exit codes propagate (every shell)
  {
    const r = await run(fleetApi, member, 'exit 3');
    record('exit-3', r.exitCode === 3, `exitCode=${r.exitCode}`);
  }

  if (!posix) {
    for (const id of ['heredoc-at-end', 'bg-then-pwd', 'timeout-tree-kill']) {
      results.push({ id, status: 'SKIP', notes: 'PowerShell member: POSIX wrapper checks do not apply' });
    }
    return results;
  }

  // heredoc as the very last thing in the command
  {
    const r = await run(fleetApi, member, 'cat <<EOF\nfleet-heredoc-ok\nEOF');
    record('heredoc-at-end', r.exitCode === 0 && r.stdout.trim() === 'fleet-heredoc-ok',
      `exitCode=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr.slice(0, 300))}`);
  }

  // `a & pwd`: the work-folder cd covers the whole command
  {
    const base = await run(fleetApi, member, 'pwd');
    const r = await run(fleetApi, member, 'true & pwd');
    record('bg-then-pwd', base.exitCode === 0 && r.exitCode === 0 && r.stdout.trim() === base.stdout.trim() && base.stdout.trim() !== '',
      `pwd=${JSON.stringify(base.stdout.trim())} "true & pwd"=${JSON.stringify(r.stdout.trim())} exitCode=${r.exitCode}`);
  }

  // timeout: the timed-out command's whole tree (bg + fg child) is killed
  {
    const n = 30000 + Math.floor(Math.random() * 9000) * 2; // unique per run
    const nums = [n, n + 1];
    let notes = '';
    let ok = false;
    try {
      const r = await run(fleetApi, member, `sleep ${n} & sleep ${n + 1}`, timeoutS);
      const timedOut = /timed out/i.test(r.text);
      let count = NaN;
      const deadline = Date.now() + killWaitMs;
      for (;;) {
        const c = await run(fleetApi, member, countSleepsCommand(member.os, nums));
        count = parseInt(c.stdout.trim(), 10);
        if (count === 0 || Date.now() >= deadline) break;
        await sleepFor(1000);
      }
      ok = timedOut && count === 0;
      notes = `timedOut=${timedOut} leftover sleep processes=${count} (${r.text.slice(0, 160).replace(/\s+/g, ' ')})`;
    } catch (err) {
      notes = `error: ${err?.message ?? err}`;
    } finally {
      try { await run(fleetApi, member, killSleepsCommand(member.os, nums)); } catch { /* best-effort */ }
    }
    // A LOCAL Windows member's timeout kill is Node's own taskkill /T of the
    // spawned shell, which cannot reach MSYS exec'd children (their Windows
    // parent has exited). That path is intentionally unchanged here, so it is
    // reported, not failed.
    const gap = member.type === 'local' && member.os === 'windows';
    record('timeout-tree-kill', ok, notes, gap ? 'KNOWN_GAP' : 'FAIL');
  }

  return results;
}
