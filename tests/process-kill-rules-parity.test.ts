/**
 * The fleet-sprint engine keeps its own copy of the process-killing command
 * set (it cannot import the server's TypeScript). Both copies must refuse and
 * allow exactly the same grants, and name the same commands.
 */
import { describe, it, expect } from 'vitest';
import {
  PROCESS_KILL_COMMANDS,
  isProcessKillGrant,
  payloadKillsProcesses,
  claudeProcessKillDenyRules,
  agyProcessKillDenyRules,
} from '../src/services/process-kill-rules.js';
import { agyCommandRules } from '../src/providers/agy.js';
import * as engine from '../packages/apra-fleet-se/fleet-sprint/process-kill-rules.mjs';

const SAMPLES = [
  'Bash(kill:*)', 'Bash(kill *)', 'Bash(pkill -f node)', 'Bash(killall:*)', 'Bash(xargs kill:*)',
  'Bash(taskkill //F //IM node.exe)', 'Bash(TASKKILL.EXE /f)', 'Bash(C:/Windows/System32/taskkill.exe:*)',
  'Bash(tskill 12)', 'PowerShell(Stop-Process:*)', 'Bash(powershell -Command Stop-Process -Id 1)',
  'Bash(wmic process where name="node.exe" delete)', 'Bash(wmic process where name="x" call terminate)',
  'Bash(wmic:*)', 'Bash(wmic process list brief)', 'Bash(kil*)',
  'Bash(node scripts/kill-port.mjs:*)', 'Bash(npm run test:*)', 'Bash(git:*)', 'Read', 'Bash(skill-check:*)',
];

describe('process-kill rules: server and engine parity', () => {
  it('both name the same commands', () => {
    expect([...engine.PROCESS_KILL_COMMANDS]).toEqual([...PROCESS_KILL_COMMANDS]);
  });

  for (const sample of SAMPLES) {
    it(`agree on ${JSON.stringify(sample)}`, () => {
      expect(engine.isProcessKillGrant(sample)).toBe(isProcessKillGrant(sample));
    });
  }

  it('agree on raw command lines', () => {
    for (const line of ['taskkill /F /IM node.exe', 'ps aux | xargs kill -9', 'node scripts/kill-port.mjs 1', 'npm test']) {
      expect(engine.payloadKillsProcesses(line)).toBe(payloadKillsProcesses(line));
    }
  });

  it('every deny rule compose writes names a command the matcher refuses', () => {
    for (const rule of claudeProcessKillDenyRules()) expect(isProcessKillGrant(rule)).toBe(true);
    for (const rule of agyProcessKillDenyRules(agyCommandRules)) {
      // command(<cmd>) is a word-prefix match and command(regex:<cmd> .*) a
      // full-line one: both mean "<cmd>, then anything".
      const m = /^command\((regex:)?(.*)\)$/.exec(rule)!;
      const inner = m[1] ? m[2]!.replace(/\\/g, '').replace(/ \.\*$/, ' *') : `${m[2]} *`;
      expect(payloadKillsProcesses(inner)).toBe(true);
    }
  });
});
