import { describe, it, expect } from 'vitest';
import { isApraFleetCommandLine, processCommandLine, isApraFleetProcess } from '../src/utils/process-utils.js';

// GitHub #584 review: stop only force-kills a pid that is still apra-fleet.
describe('apra-fleet process identity', () => {
  it('recognizes the SEA binary and a node dist/index.js build', () => {
    expect(isApraFleetCommandLine('"C:\\Users\\u\\bin\\apra-fleet.exe" --transport http')).toBe(true);
    expect(isApraFleetCommandLine('/home/u/bin/apra-fleet --transport http')).toBe(true);
    expect(isApraFleetCommandLine('node /opt/x/dist/index.js --transport http')).toBe(true);
    expect(isApraFleetCommandLine('"C:\\nodejs\\node.exe" C:\\repo\\dist\\index.js run')).toBe(true);
  });

  it('rejects unrelated processes', () => {
    expect(isApraFleetCommandLine('C:\\Windows\\System32\\notepad.exe')).toBe(false);
    expect(isApraFleetCommandLine('/usr/sbin/nginx -g daemon off;')).toBe(false);
  });

  it('reads a real command line for a live pid, and returns null for a dead/invalid one', () => {
    const own = processCommandLine(process.pid);
    expect(own).not.toBeNull();
    expect(own!.toLowerCase()).toContain('node');
    expect(processCommandLine(2147483646)).toBeNull();
    expect(isApraFleetProcess(-1)).toBeNull();
  }, 30_000);
});
