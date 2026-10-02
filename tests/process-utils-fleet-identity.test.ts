import { describe, it, expect, vi } from 'vitest';
import {
  isApraFleetCommandLine, processCommandLine, isApraFleetProcess,
  processImageName, parseTasklistImage, isApraFleetImage,
} from '../src/utils/process-utils.js';

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

  describe('Windows tasklist fallback (Get-CimInstance gave no command line)', () => {
    const noCmd = () => null;
    const win = (image: string | null) => ({ platform: 'win32' as const, commandLine: noCmd, imageName: () => image });

    it('accepts the apra-fleet.exe and node.exe images', () => {
      expect(isApraFleetProcess(42, win('apra-fleet.exe'))).toBe(true);
      expect(isApraFleetProcess(42, win('node.exe'))).toBe(true);
      expect(isApraFleetProcess(42, win('NODE.EXE'))).toBe(true);
    });

    it('rejects any other image and stays inconclusive when tasklist is too', () => {
      expect(isApraFleetProcess(42, win('notepad.exe'))).toBe(false);
      expect(isApraFleetProcess(42, win(null))).toBeNull();
    });

    it('is not consulted when the command line is readable, nor off Windows', () => {
      const imageName = vi.fn(() => 'node.exe');
      expect(isApraFleetProcess(42, { platform: 'win32', commandLine: () => 'notepad.exe', imageName })).toBe(false);
      expect(isApraFleetProcess(42, { platform: 'linux', commandLine: noCmd, imageName })).toBeNull();
      expect(imageName).not.toHaveBeenCalled();
    });

    it('parses tasklist CSV output and ignores the no-match INFO line', () => {
      expect(parseTasklistImage('"node.exe","1234","Console","1","45,000 K"\r\n', 1234)).toBe('node.exe');
      expect(parseTasklistImage('"node.exe","1234","Console","1","45,000 K"\r\n', 99)).toBeNull();
      expect(parseTasklistImage('INFO: No tasks are running which match the specified criteria.\r\n', 1234)).toBeNull();
    });

    it.runIf(process.platform === 'win32')('reads the real image name of this process', () => {
      expect(isApraFleetImage(processImageName(process.pid) ?? '')).toBe(true);
      expect(processImageName(2147483646)).toBeNull();
    }, 30_000);
  });
});
