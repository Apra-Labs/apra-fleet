/**
 * Guards the F14 shell-selected env prefix builder
 * (src/utils/env-prefix.ts): buildEnvPrefix / buildEnvAssignments.
 *
 * One case per acceptance bullet of the parent feature:
 *   - POSIX and PowerShell forms for member.env
 *   - stored auth credentials are NEVER rendered inline (they travel in the
 *     staged owner-only file, src/services/member-secret-env.ts)
 *   - auth wins on a name collision (the member.env entry is dropped)
 *   - a gitbash Windows member gets the POSIX form (shell, not os, decides)
 *   - values containing ' $ ` \ spaces and newlines round-trip LITERALLY --
 *     asserted by actually executing the generated prefix in this platform's
 *     native shell (powershell on win32, sh elsewhere) and reading the value
 *     back out of the child process; the non-native form is asserted
 *     structurally in the same case
 *   - an invalid stored name throws
 *   - empty maps give ''
 *
 * Agents are built with the REAL encryptPassword, so the decryption path in
 * buildEnvAssignments is genuinely exercised rather than stubbed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildEnvPrefix, buildEnvAssignments } from '../src/utils/env-prefix.js';
import { encryptPassword } from '../src/utils/crypto.js';
import type { Agent } from '../src/types.js';
import type { MemberShell } from '../src/os/os-commands.js';

function makeAgent(opts: {
  env?: Record<string, string>;
  auth?: Record<string, string>;
  shell?: MemberShell;
  agentOs?: string;
}): Agent {
  return {
    id: 'test-member',
    friendlyName: 'test',
    host: 'localhost',
    username: 'user',
    encryptedPassword: '',
    workFolder: '/tmp',
    env: opts.env,
    encryptedEnvVars: opts.auth
      ? Object.fromEntries(Object.entries(opts.auth).map(([k, v]) => [k, encryptPassword(v)]))
      : undefined,
    shell: opts.shell,
    os: opts.agentOs,
  } as Agent;
}

// -- empty ------------------------------------------------------------------

describe('buildEnvPrefix - empty maps', () => {
  it('returns empty string when the member has neither env nor encryptedEnvVars', () => {
    const member = makeAgent({});
    expect(buildEnvPrefix(member, { os: 'linux' })).toBe('');
    expect(buildEnvPrefix(member, { os: 'macos' })).toBe('');
    expect(buildEnvPrefix(member, { os: 'windows' })).toBe('');
    expect(buildEnvAssignments(member, { os: 'linux' })).toEqual([]);
  });

  it('returns empty string when both maps are present but empty', () => {
    const member = makeAgent({ env: {}, auth: {} });
    expect(buildEnvPrefix(member, { os: 'linux' })).toBe('');
    expect(buildEnvPrefix(member, { os: 'windows' })).toBe('');
  });

  it('returns empty string when the member has ONLY stored auth credentials (never inline)', () => {
    const authOnly = makeAgent({ auth: { TOKEN: 'secret' } });
    expect(buildEnvPrefix(authOnly, { os: 'linux' })).toBe('');
    expect(buildEnvPrefix(authOnly, { os: 'windows' })).toBe('');
  });
});

// -- member.env only --------------------------------------------------------

describe('buildEnvPrefix - member.env only', () => {
  const member = makeAgent({ env: { FLEET_A: 'one', FLEET_B: 'two' } });
  const opts = {} as const;

  it('POSIX form: single-quoted export chain ending in " && "', () => {
    const prefix = buildEnvPrefix(member, { os: 'linux', ...opts });
    expect(prefix).toBe("export FLEET_A='one' && export FLEET_B='two' && ");
  });

  it('macos gets the same POSIX form as linux', () => {
    expect(buildEnvPrefix(member, { os: 'macos', ...opts }))
      .toBe(buildEnvPrefix(member, { os: 'linux', ...opts }));
  });

  it('PowerShell form: $env: assignment chain ending in "; "', () => {
    const prefix = buildEnvPrefix(member, { os: 'windows', ...opts });
    expect(prefix).toBe("$env:FLEET_A='one'; $env:FLEET_B='two'; ");
  });
});

// -- stored auth credentials never inline ----------------------------------

describe('buildEnvPrefix - stored auth credentials are never rendered inline', () => {
  // Credentials reach the member CLI through the staged owner-only file
  // (src/services/member-secret-env.ts), never through the command line.
  const member = makeAgent({
    env: { FLEET_A: 'one', FLEET_B: 'two' },
    auth: { API_TOKEN: 'sek-ret' },
  });

  it('POSIX: only member.env is rendered; the credential value never appears', () => {
    const prefix = buildEnvPrefix(member, { os: 'linux' });
    expect(prefix).toBe("export FLEET_A='one' && export FLEET_B='two' && ");
    expect(prefix).not.toContain('sek-ret');
    expect(prefix).not.toContain('API_TOKEN');
  });

  it('PowerShell: only member.env is rendered; the credential value never appears', () => {
    const prefix = buildEnvPrefix(member, { os: 'windows' });
    expect(prefix).toBe("$env:FLEET_A='one'; $env:FLEET_B='two'; ");
    expect(prefix).not.toContain('sek-ret');
  });

  it('auth WINS a name collision -- a member.env entry named like a credential is dropped', () => {
    const colliding = makeAgent({
      env: { API_TOKEN: 'member-supplied-impostor', FLEET_A: 'one' },
      auth: { API_TOKEN: 'the-real-credential' },
    });

    const assignments = buildEnvAssignments(colliding, { os: 'linux' });
    expect(assignments).toEqual([{ name: 'FLEET_A', value: 'one' }]);

    const posix = buildEnvPrefix(colliding, { os: 'linux' });
    expect(posix).toBe("export FLEET_A='one' && ");
    expect(posix).not.toContain('member-supplied-impostor');
    expect(posix).not.toContain('the-real-credential');

    const ps = buildEnvPrefix(colliding, { os: 'windows' });
    expect(ps).toBe("$env:FLEET_A='one'; ");
    expect(ps).not.toContain('member-supplied-impostor');
    expect(ps).not.toContain('the-real-credential');
  });
});

// -- shell selection --------------------------------------------------------

describe('buildEnvPrefix - shell selects the form, not the OS', () => {
  const member = makeAgent({ env: { FLEET_A: 'one' } });

  it('a gitbash Windows member gets the POSIX form', () => {
    expect(buildEnvPrefix(member, { os: 'windows', shell: 'gitbash' }))
      .toBe("export FLEET_A='one' && ");
  });

  it('a Windows member with no recorded shell still gets PowerShell', () => {
    expect(buildEnvPrefix(member, { os: 'windows' })).toBe("$env:FLEET_A='one'; ");
  });

  it.each(['pwsh7', 'powershell5'] as MemberShell[])(
    'a Windows member registered as %s gets PowerShell',
    (shell) => {
      expect(buildEnvPrefix(member, { os: 'windows', shell }))
        .toBe("$env:FLEET_A='one'; ");
    },
  );

  it('a non-Windows member is POSIX whatever shell is recorded', () => {
    expect(buildEnvPrefix(member, { os: 'linux', shell: 'gitbash' }))
      .toBe("export FLEET_A='one' && ");
  });
});

// -- invalid names ----------------------------------------------------------

describe('buildEnvPrefix - invalid stored names throw', () => {
  it.each([
    ['a name with a space', 'BAD NAME'],
    ['a name starting with a digit', '1BAD'],
    ['a name with a shell metacharacter', 'BAD;rm -rf /'],
    ['a name with a dollar sign', 'BAD$VAR'],
    ['an empty name', ''],
  ])('throws for %s', (_label, name) => {
    const member = makeAgent({ env: { [name]: 'value' } });
    expect(() => buildEnvPrefix(member, { os: 'linux' })).toThrow(/Invalid env variable name/);
    expect(() => buildEnvPrefix(member, { os: 'windows' })).toThrow(/Invalid env variable name/);
    expect(() => buildEnvAssignments(member, { os: 'linux' })).toThrow(/Invalid env variable name/);
  });

  it('does not render (or validate) the AUTH map -- that is the staged file\'s job', () => {
    // decryptAuthEnvVars (src/utils/auth-env.ts) rejects a bad stored auth
    // name when the file is staged; this builder never touches auth values.
    const member = makeAgent({ auth: { 'BAD NAME': 'value' } });
    expect(buildEnvPrefix(member, { os: 'linux' })).toBe('');
  });
});

// -- buildEnvAssignments is unescaped + shell-agnostic ----------------------

describe('buildEnvAssignments', () => {
  it('returns raw, UNESCAPED values regardless of os/shell', () => {
    const member = makeAgent({ env: { TRICKY: "a'b$c`d\\e\nf" } });
    const expected = [{ name: 'TRICKY', value: "a'b$c`d\\e\nf" }];
    expect(buildEnvAssignments(member, { os: 'linux' })).toEqual(expected);
    expect(buildEnvAssignments(member, { os: 'windows' })).toEqual(expected);
    expect(buildEnvAssignments(member, { os: 'windows', shell: 'gitbash' })).toEqual(expected);
  });

  it('returns member.env only, never a stored auth credential', () => {
    const member = makeAgent({ env: { FLEET_A: 'one' }, auth: { API_TOKEN: 'sek-ret' } });
    expect(buildEnvAssignments(member, { os: 'linux' }))
      .toEqual([{ name: 'FLEET_A', value: 'one' }]);
  });
});

// -- escaping round-trip ----------------------------------------------------

/**
 * Values chosen so every character class the two quoting rules must survive
 * is represented: single quote (the only character either form escapes),
 * dollar, backtick, backslash, double quote, leading/trailing spaces,
 * embedded newline, and shell control operators.
 */
const ROUND_TRIP: Record<string, string> = {
  FLEET_RT_PLAIN: 'plain-value-123',
  FLEET_RT_QUOTE: "it's got 'single' quotes",
  FLEET_RT_DOLLAR: '$HOME ${BRACED} $env:PATH $1',
  // The letter after the bare backtick is deliberately 'q': the repo's
  // pre-commit portability guard rejects literal PowerShell backtick-n/t/r
  // escape sequences anywhere in source, and which letter follows is
  // irrelevant to what this value proves -- that a backtick survives both
  // quoting forms unexpanded.
  FLEET_RT_BACKTICK: 'a `backtick` and `q and $(whoami)',
  FLEET_RT_BACKSLASH: 'C:\\path\\to\\thing and \\n and \\\\',
  FLEET_RT_SPACES: '  leading and trailing  ',
  FLEET_RT_NEWLINE: 'line1\nline2',
  FLEET_RT_OPERATORS: 'a && b; c | d > e & f',
  FLEET_RT_DQUOTE: 'has "double" quotes',
  FLEET_RT_MIXED: 'mix\'s $VAR `tick` \\slash "dq" & end',
};

describe('buildEnvPrefix - escaping round-trip', () => {
  const member = makeAgent({ env: ROUND_TRIP });
  const isWin = process.platform === 'win32';

  it(`executes the ${isWin ? 'PowerShell' : 'POSIX'} (native) form and reads every value back literally`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-prefix-'));
    try {
      const names = Object.keys(ROUND_TRIP);

      if (isWin) {
        const prefix = buildEnvPrefix(member, { os: 'windows' });
        const reads = names
          .map((n) => `[IO.File]::WriteAllText('${dir.replace(/'/g, "''")}\\${n}.out', $env:${n})`)
          .join('; ');
        // -EncodedCommand (utf16le base64) rather than -Command: the script
        // carries a literal newline inside one of the values, which argv
        // quoting on Windows cannot be trusted to deliver intact.
        const encoded = Buffer.from(prefix + reads, 'utf16le').toString('base64');
        execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
          stdio: 'pipe',
          timeout: 60_000,
        });
      } else {
        const prefix = buildEnvPrefix(member, { os: 'linux' });
        const reads = names
          .map((n) => `printf '%s' "$${n}" > '${dir}/${n}.out'`)
          .join(' && ');
        execFileSync('sh', ['-c', prefix + reads], { stdio: 'pipe', timeout: 60_000 });
      }

      for (const name of names) {
        const observed = fs.readFileSync(path.join(dir, `${name}.out`), 'utf-8');
        expect(observed, `${name} did not round-trip literally`).toBe(ROUND_TRIP[name]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`asserts the ${isWin ? 'POSIX' : 'PowerShell'} (non-native) form structurally`, () => {
    if (isWin) {
      const prefix = buildEnvPrefix(member, { os: 'linux' });
      // POSIX single-quote escaping: the ONLY transform is ' -> '\''; every
      // other character sits literally inside the single quotes.
      expect(prefix).toContain(`export FLEET_RT_QUOTE='it'\\''s got '\\''single'\\'' quotes'`);
      expect(prefix).toContain(`export FLEET_RT_DOLLAR='$HOME \${BRACED} $env:PATH $1'`);
      expect(prefix).toContain('export FLEET_RT_BACKTICK=\'a `backtick` and `q and $(whoami)\'');
      expect(prefix).toContain(`export FLEET_RT_BACKSLASH='C:\\path\\to\\thing and \\n and \\\\'`);
      expect(prefix).toContain(`export FLEET_RT_SPACES='  leading and trailing  '`);
      expect(prefix).toContain(`export FLEET_RT_NEWLINE='line1\nline2'`);
      expect(prefix.endsWith(' && ')).toBe(true);
    } else {
      const prefix = buildEnvPrefix(member, { os: 'windows' });
      // PowerShell single-quote escaping: the ONLY transform is ' -> ''.
      expect(prefix).toContain(`$env:FLEET_RT_QUOTE='it''s got ''single'' quotes'`);
      expect(prefix).toContain(`$env:FLEET_RT_DOLLAR='$HOME \${BRACED} $env:PATH $1'`);
      expect(prefix).toContain('$env:FLEET_RT_BACKTICK=\'a `backtick` and `q and $(whoami)\'');
      expect(prefix).toContain(`$env:FLEET_RT_BACKSLASH='C:\\path\\to\\thing and \\n and \\\\'`);
      expect(prefix).toContain(`$env:FLEET_RT_SPACES='  leading and trailing  '`);
      expect(prefix).toContain(`$env:FLEET_RT_NEWLINE='line1\nline2'`);
      expect(prefix.endsWith('; ')).toBe(true);
    }
  });
});
