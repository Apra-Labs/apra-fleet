/**
 * Claude -> agy permission conversion per member OS
 * (docs/compose-permissions-design.md section 8.9).
 *
 * Windows agy needs a character-for-character match for command lines
 * PowerShell/cmd cannot split into words, so a prefix grant maps to the bare
 * command plus `command(regex:<cmd> .*)`. Linux/macOS command rules are
 * unchanged: tests/fixtures/agy-compose-posix-before.json is the full composed
 * doer/reviewer config captured from the code BEFORE this change.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgyProvider,
  convertClaudeAllowToAgyPermissions,
  formatAgyPermissionRules,
  detectAgyPermissionDenial,
} from '../src/providers/agy.js';
import type { Agent } from '../src/types.js';

const agy = new AgyProvider();
const PROFILES = path.join(__dirname, '..', 'skills', 'fleet', 'profiles');
const load = (n: string) => JSON.parse(fs.readFileSync(path.join(PROFILES, `${n}.json`), 'utf-8'));
const EXTRAS = ['cpp', 'dotnet', 'go', 'jvm', 'node', 'python', 'rust', 'tag-devops', 'tag-gpu', 'tag-kb-reconciler'];

/** Every Claude grant the shipped profiles give a role (base + all stacks + all tags). */
function roleAllow(role: 'doer' | 'reviewer'): string[] {
  const key = role === 'doer' ? 'dev' : 'reviewer';
  const allow = new Set<string>(load(role === 'doer' ? 'base-dev' : 'base-reviewer').permissions.allow);
  for (const e of EXTRAS) for (const p of load(e)[key] ?? []) allow.add(p);
  return [...allow];
}

const agent = (os: 'linux' | 'macos' | 'windows') => ({ agyProjectId: 'p', os } as unknown as Agent);
const compose = (os: 'linux' | 'macos' | 'windows', role: 'doer' | 'reviewer', allow = roleAllow(role), opts = {}) =>
  agy.composePermissionConfig(role, allow, agent(os), opts)[0] as Record<string, any>;
const conv = (allow: string[], opts: Parameters<typeof convertClaudeAllowToAgyPermissions>[1] = {}) =>
  formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(allow, opts));

afterEach(() => vi.restoreAllMocks());

describe('Windows command grants', () => {
  const win = { os: 'windows' as const };

  it('Bash(git:*) yields exactly command(git) and command(regex:git .*)', () => {
    expect(conv(['Bash(git:*)'], win)).toEqual(['command(git)', 'command(regex:git .*)']);
  });

  it('Bash(<cmd> *) and Bash(<cmd>*) are prefix grants too', () => {
    expect(conv(['Bash(bd *)'], win)).toEqual(['command(bd)', 'command(regex:bd .*)']);
    expect(conv(['Bash(npm test*)'], win)).toEqual(['command(npm test)', 'command(regex:npm test .*)']);
  });

  it('multi-word prefixes keep their words', () => {
    expect(conv(['Bash(npm run:*)'], win)).toEqual(['command(npm run)', 'command(regex:npm run .*)']);
  });

  it('an exact grant stays exact (no widening)', () => {
    expect(conv(['Bash(npm test)'], win)).toEqual(['command(npm test)']);
    expect(conv(['Bash(git status --short --branch)'], win)).toEqual(['command(git status --short --branch)']);
  });

  it('escapes regex metacharacters in the command', () => {
    expect(conv(['Bash(a.b:*)'], win)).toEqual(['command(a.b)', 'command(regex:a\\.b .*)']);
    expect(conv(['Bash(g++:*)'], win)).toEqual(['command(g++)', 'command(regex:g\\+\\+ .*)']);
    expect(conv(['Bash(x(1)[2]$^|?{}\\:*)'], win)[1]).toBe('command(regex:x\\(1\\)\\[2\\]\\$\\^\\|\\?\\{\\}\\\\ .*)');
  });

  it('Bash and Bash(*) stay command(*)', () => {
    expect(conv(['Bash'], win)).toEqual(['command(*)']);
    expect(conv(['Bash(*)'], win)).toEqual(['command(*)']);
  });

  it('writes no command deny rules and no ask list', () => {
    const cfg = compose('windows', 'doer');
    expect(Object.keys(cfg.permissionGrants.permissionGrants).sort()).toEqual(['allow', 'deny']);
    expect((cfg.permissionGrants.permissionGrants.deny as string[]).every(r => r.startsWith('mcp('))).toBe(true);
  });
});

describe('Linux/macOS output is byte-identical to before (command, mcp, deny)', () => {
  const before = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-compose-posix-before.json'), 'utf-8'));
  // The one intended change on every OS: a path glob agy cannot express is
  // dropped (it was written verbatim before and matched nothing).
  const dropped = new Set(['write_file(feedback-*.md)']);

  for (const os of ['linux', 'macos'] as const) {
    for (const role of ['doer', 'reviewer'] as const) {
      it(`${os} ${role}`, () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const expected = structuredClone(before[role]);
        const g = expected.permissionGrants.permissionGrants;
        g.allow = (g.allow as string[]).filter(r => !dropped.has(r));
        expect(JSON.stringify(compose(os, role), null, 2)).toBe(JSON.stringify(expected, null, 2));
      });
    }
  }

  it('the fixture differs from today only by the dropped glob (reviewer) and not at all (doer)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(compose('linux', 'doer')).toEqual(before.doer);
    const now = compose('linux', 'reviewer').permissionGrants.permissionGrants.allow as string[];
    const was = before.reviewer.permissionGrants.permissionGrants.allow as string[];
    expect(was.filter(r => !now.includes(r))).toEqual(['write_file(feedback-*.md)']);
    expect(now.filter(r => !was.includes(r))).toEqual([]);
  });
});

describe('path grants (all OSes)', () => {
  it('resolves a leading ~ to the member home and a trailing /** to the directory', () => {
    expect(conv(['Read(~/x/**)'], { os: 'linux', homeDir: '/home/u' })).toEqual(['read_file(/home/u/x)']);
    expect(conv(['Write(~/x/*)'], { os: 'macos', homeDir: '/Users/u/' })).toEqual(['write_file(/Users/u/x)']);
    expect(conv(['Read(~/x/**)'], { os: 'windows', homeDir: 'C:\\Users\\u' })).toEqual(['read_file(C:/Users/u/x)']);
    expect(conv(['Read(~)'], { os: 'linux', homeDir: '/home/u' })).toEqual(['read_file(/home/u)']);
  });

  it('drops a ~ path when the home directory is unknown, with a warning', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnings: string[] = [];
    expect(conv(['Read(~/x/**)'], { os: 'linux', warnings })).toEqual([]);
    expect(warnings).toEqual(['agy: dropped "Read(~/x/**)" -- the member home directory is unknown, so ~ cannot be resolved; grant a directory or an exact path instead.']);
  });

  it('drops a glob it cannot express and reports it; never emits * except the global wildcard', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnings: string[] = [];
    const out = conv(['Write(feedback-*.md)', 'Edit(src/*/x.ts)', 'Write(a/b?c)', 'Read(foo*)', 'Read', 'Write(*)', 'Read(docs/**)'], { os: 'linux', warnings });
    expect(out).toEqual(['read_file(*)', 'write_file(*)', 'read_file(docs)']);
    expect(warnings.map(w => /"(.*?)"/.exec(w)![1])).toEqual(['Write(feedback-*.md)', 'Edit(src/*/x.ts)', 'Write(a/b?c)', 'Read(foo*)']);
  });

  it('compose surfaces the dropped reviewer globs through opts.warnings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const os of ['linux', 'windows'] as const) {
      const warnings: string[] = [];
      const cfg = compose(os, 'reviewer', roleAllow('reviewer'), { warnings, memberHomeDir: '/home/u' });
      expect(warnings.some(w => w.includes('"Write(feedback-*.md)"'))).toBe(true);
      expect(warnings.some(w => w.includes('"Edit(feedback-*.md)"'))).toBe(true);
      const paths = (cfg.permissionGrants.permissionGrants.allow as string[]).filter(r => /^(read|write)_file\(/.test(r));
      expect(paths.filter(r => r.includes('*'))).toEqual(['read_file(*)']);
    }
  });
});

describe('Windows doer/reviewer composed output', () => {
  it('every Bash prefix grant becomes the bare command plus its regex; POSIX keeps the bare command', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const role of ['doer', 'reviewer'] as const) {
      const win = compose('windows', role).permissionGrants.permissionGrants.allow as string[];
      const lin = compose('linux', role).permissionGrants.permissionGrants.allow as string[];
      const expected = lin.flatMap(r => {
        const m = /^command\((.+)\)$/.exec(r);
        if (!m || m[1] === '*') return [r];
        return [r, `command(regex:${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*)`];
      });
      expect(win).toEqual(expected);
      expect(win).toContain('command(regex:git .*)');
    }
  });
});

describe('permission-denial hint by member OS', () => {
  const denial = (target: string) => ({
    stdout: '{"conversation_id":"c","status":"SUCCESS","response":"","denied_actions":[{"action":"command"}]}\n'
      + `FLEET_TRANSCRIPT_START\n{"type":"USER_INPUT"}\n{"status":"ERROR","error":"permission check failed for command \\"${target}\\": user denied permission to run command"}\nFLEET_TRANSCRIPT_END`,
    stderr: '',
    code: 0,
  });

  it('Windows: the prefix grant first, the exact command as the narrow alternative', () => {
    const d = detectAgyPermissionDenial(denial('git status --short --branch'), 'windows')!;
    expect(d.suggestedGrants).toEqual(['Bash(git:*)', 'Bash(git status --short --branch)']);
    expect(d.hint).toContain('compose_permissions grant: ["Bash(git:*)"]');
    expect(d.hint).toContain('Narrower alternative (this exact command line only): ["Bash(git status --short --branch)"]');
    expect(d.hint).toContain('command(regex:<bin> .*)');
  });

  it('Windows: a $(...) command gets the prefix grant only (the regex matches the full line)', () => {
    const d = detectAgyPermissionDenial(denial('git log -1 --format=%h $(git rev-parse HEAD)'), 'windows')!;
    expect(d.suggestedGrants).toEqual(['Bash(git:*)']);
  });

  it('Windows: a chained command gets no suggestion', () => {
    expect(detectAgyPermissionDenial(denial('git status && rm x'), 'windows')!.suggestedGrants).toEqual([]);
  });

  it('POSIX and unknown OS: unchanged (exact command only)', () => {
    for (const os of ['linux', 'macos', undefined] as const) {
      const d = detectAgyPermissionDenial(denial('git status --short --branch'), os)!;
      expect(d.suggestedGrants).toEqual(['Bash(git status --short --branch)']);
      expect(d.hint).toContain('allows only the bare binary');
      expect(d.hint).not.toContain('Narrower alternative');
    }
  });

  it('parseResponse passes the OS through', () => {
    expect(agy.parseResponse(denial('git status'), { agentOs: 'windows' }).permissionDenial!.suggestedGrants)
      .toEqual(['Bash(git:*)', 'Bash(git status)']);
    expect(agy.parseResponse(denial('git status')).permissionDenial!.suggestedGrants).toEqual(['Bash(git status)']);
  });
});
