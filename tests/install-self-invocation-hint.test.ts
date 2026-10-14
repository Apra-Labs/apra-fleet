import { describe, it, expect } from 'vitest';
import { selfInvocationLines } from '../src/cli/install-guard.js';

// The install refusal's --force hint must re-run THIS executable (a downloaded
// installer is usually not on PATH), quoted for the user's shell on each OS.
describe('selfInvocationLines', () => {
  const args = ['install', '--force'];

  it('Windows SEA, path with spaces -> PowerShell & form plus cmd form', () => {
    const lines = selfInvocationLines({
      platform: 'win32', sea: true, args,
      execPath: 'C:\\Users\\Jo Smith\\Downloads\\apra-fleet-installer-win-x64.exe',
    });
    expect(lines).toEqual([
      "PowerShell: & 'C:\\Users\\Jo Smith\\Downloads\\apra-fleet-installer-win-x64.exe' install --force",
      'cmd:        "C:\\Users\\Jo Smith\\Downloads\\apra-fleet-installer-win-x64.exe" install --force',
    ]);
  });

  it('Windows SEA, path without spaces -> one bare line valid in cmd and PowerShell', () => {
    const lines = selfInvocationLines({
      platform: 'win32', sea: true, args,
      execPath: 'C:\\Users\\x\\Downloads\\apra-fleet-installer-win-x64.exe',
    });
    expect(lines).toEqual(['C:\\Users\\x\\Downloads\\apra-fleet-installer-win-x64.exe install --force']);
  });

  it("Windows, PowerShell single quote in path is doubled", () => {
    const lines = selfInvocationLines({ platform: 'win32', sea: true, args, execPath: "C:\\O'Brien\\a.exe" });
    expect(lines[0]).toBe("PowerShell: & 'C:\\O''Brien\\a.exe' install --force");
  });

  it('Windows npm/dev -> node plus the entry script', () => {
    const lines = selfInvocationLines({
      platform: 'win32', sea: false, args,
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\apra-fleet\\dist\\index.js',
    });
    expect(lines[0]).toBe("PowerShell: & 'C:\\Program Files\\nodejs\\node.exe' C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\apra-fleet\\dist\\index.js install --force");
    expect(lines[1]).toBe('cmd:        "C:\\Program Files\\nodejs\\node.exe" C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\apra-fleet\\dist\\index.js install --force');
  });

  it('Linux SEA, path without spaces -> bare', () => {
    expect(selfInvocationLines({ platform: 'linux', sea: true, args, execPath: '/home/u/Downloads/apra-fleet-installer-linux-x64' }))
      .toEqual(['/home/u/Downloads/apra-fleet-installer-linux-x64 install --force']);
  });

  it("macOS SEA, path with spaces and a quote -> POSIX single quotes with '\\'' escaping", () => {
    expect(selfInvocationLines({ platform: 'darwin', sea: true, args, execPath: "/Users/Jo's Mac/Downloads/apra-fleet-installer-darwin-arm64" }))
      .toEqual(["'/Users/Jo'\\''s Mac/Downloads/apra-fleet-installer-darwin-arm64' install --force"]);
  });

  it('Linux npm/dev -> node plus the entry script; SEA ignores the script path', () => {
    expect(selfInvocationLines({ platform: 'linux', sea: false, args, execPath: '/usr/bin/node', scriptPath: '/usr/lib/node_modules/apra-fleet/dist/index.js' }))
      .toEqual(['/usr/bin/node /usr/lib/node_modules/apra-fleet/dist/index.js install --force']);
    expect(selfInvocationLines({ platform: 'linux', sea: true, args, execPath: '/opt/af', scriptPath: '/opt/af' }))
      .toEqual(['/opt/af install --force']);
  });
});
