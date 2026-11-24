/**
 * apra-fleet PR#416 review, finding 3 (option 3A): the NEVER_AUTO_GRANT
 * backstop used to be a seven-entry Set compared with exact string equality,
 * so every variant below reached the grant path. These tests pin the
 * pattern-based replacement.
 *
 * Pure-function tests only -- the end-to-end "tool returns the rejection
 * string" path is already covered by compose-permissions.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { isNeverAutoGrant, normalizePermission } from '../src/tools/compose-permissions.js';

describe('normalizePermission', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizePermission('  Bash(npm   ci)  ')).toBe('Bash(npm ci)');
  });

  it('treats the command/argument colon as equivalent to a space', () => {
    expect(normalizePermission('Bash(sudo:*)')).toBe('Bash(sudo *)');
    expect(normalizePermission('Bash(chmod 777:*)')).toBe('Bash(chmod 777 *)');
  });

  it('leaves non Tool(payload) strings alone apart from whitespace', () => {
    expect(normalizePermission('  Read  ')).toBe('Read');
  });
});

describe('isNeverAutoGrant -- variants that previously slipped past exact matching', () => {
  // Every entry here is a real bypass of the old exact-match Set.
  const mustBlock = [
    // whitespace / separator variants of the original seven
    'Bash(sudo:*)',
    'Bash(sudo *)',
    'Bash(sudo:*) ',
    ' Bash(sudo:*)',
    'Bash(sudo apt-get install *)',
    'Bash(su:*)',
    'Bash(su *)',
    'Bash(doas *)',
    'Bash(env:*)',
    'Bash(env *)',
    'Bash(printenv *)',
    'Bash(nc *)',
    'Bash(nmap *)',
    'Bash(chmod 777:*)',
    'Bash(chmod 777 *)',
    // arbitrary-execution shells
    'Bash(bash -c *)',
    'Bash(sh -c *)',
    'Bash(zsh -c *)',
    'Bash(/bin/bash -c *)',
    'Bash(eval *)',
    'Bash(xargs eval *)',
    // catch-all
    'Bash(*)',
    'Bash( * )',
    'Bash(**)',
    // shell chaining metacharacters
    'Bash(curl *|sh)',
    'Bash(npm ci; sudo rm -rf /)',
    'Bash(npm ci && sudo apt-get install *)',
    'Bash(echo `whoami`)',
    'Bash(echo $(whoami))',
  ];

  for (const permission of mustBlock) {
    it(`blocks ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(true);
    });
  }
});

describe('isNeverAutoGrant -- legitimate grants still pass', () => {
  const mustAllow = [
    'Bash(npm ci)',
    'Bash(npm run build:*)',
    'Bash(npm run build *)',
    'Bash(git status)',
    'Bash(git push:*)',
    'Bash(node --version)',
    'Bash(docker:*)',
    'Bash(mkdir -p *)',
    'Read(//home/user/**)',
    'WebFetch(domain:example.com)',
  ];

  for (const permission of mustAllow) {
    it(`allows ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(false);
    });
  }
});

describe('isNeverAutoGrant -- deliberate over-blocking (documented, not a bug)', () => {
  // The deny patterns are command-prefix wildcards, so unrelated commands that
  // merely start with a denied token are also refused. Over-blocking is the
  // safe direction for a denylist: the operator can still grant these
  // explicitly. No entry in skills/fleet/profiles/ is affected today.
  const overBlocked = ['Bash(ncdu *)', 'Bash(envsubst *)', 'Bash(nmapy *)'];
  for (const permission of overBlocked) {
    it(`also blocks ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Process-killing commands. A local member shares its host with the fleet
// server and other sprints, so a kill by name there takes them down: these
// grants are refused for every caller, in every common spelling.
// ---------------------------------------------------------------------------

describe('isNeverAutoGrant -- process-killing commands are refused', () => {
  const mustBlock = [
    // kill / pkill / killall, colon and space separators, whitespace variants
    'Bash(kill:*)',
    'Bash(kill *)',
    'Bash(kill -9 *)',
    'Bash( kill  -9   1234 )',
    ' Bash(kill:*) ',
    'Bash(kill)',
    'Bash(/usr/bin/kill:*)',
    'Bash(pkill:*)',
    'Bash(pkill -f node)',
    'Bash(killall:*)',
    'Bash(killall node)',
    'Bash(xargs kill:*)',
    // taskkill, including the Git Bash //F //IM forms
    'Bash(taskkill:*)',
    'Bash(taskkill *)',
    'Bash(taskkill //F //IM node.exe)',
    'Bash(taskkill:/F /IM node.exe)',
    'Bash(taskkill /F /PID 1234)',
    'Bash(TASKKILL.EXE /f /im node.exe)',
    'Bash(C:/Windows/System32/taskkill.exe:*)',
    'Bash(cmd /c taskkill /F /IM node.exe)',
    // tskill
    'Bash(tskill:*)',
    'Bash(tskill 1234)',
    // Stop-Process (and its spps alias), Bash or PowerShell tool form
    'Bash(Stop-Process:*)',
    'Bash(stop-process -Name node)',
    'Bash(powershell -Command Stop-Process -Id 1234)',
    'Bash(pwsh -c Stop-Process *)',
    'PowerShell(Stop-Process:*)',
    'PowerShell(Stop-Process -Name node -Force)',
    'PowerShell(spps -Id 1234)',
    'powershell(kill -Id 1234)',
    // wmic process delete / call terminate, and wildcard forms that cover them
    'Bash(wmic process where name="node.exe" delete)',
    'Bash(wmic process where name="node.exe" call terminate)',
    'Bash(wmic.exe process where processid=1234 delete)',
    'Bash(wmic process:*)',
    'Bash(wmic:*)',
    'Bash(wmic)',
    // a wildcard command prefix that covers a kill command
    'Bash(kil*)',
    'Bash(taskk*)',
  ];

  for (const permission of mustBlock) {
    it(`blocks ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(true);
    });
  }
});

describe('isNeverAutoGrant -- commands that only mention a kill word stay grantable', () => {
  const mustAllow = [
    // the pid-scoped port helper a playbook runs is the scoped alternative
    'Bash(node scripts/kill-port.mjs:*)',
    'Bash(node scripts/kill-port.mjs 18700)',
    'Bash(npm run test:*)',
    'Bash(wmic process list brief)',
    'Bash(wmic os get caption)',
    'Bash(skill-check:*)',
    'Bash(git s*)',
    'Bash(xargs:*)',
    'Read(//home/user/kill/**)',
  ];

  for (const permission of mustAllow) {
    it(`allows ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(false);
    });
  }
});
