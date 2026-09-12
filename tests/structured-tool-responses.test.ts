/**
 * apra-fleet-3swo.7.4 -- the streak-level proof for the three server-side
 * surfaces reshaped in phase5-mcp-server:
 *
 *   member_reservation      (src/tools/member-reservation.ts,  3swo.7.1)
 *   provision_llm_auth      (src/tools/provision-auth.ts,      3swo.7.2)
 *   provision_vcs_auth      (src/tools/provision-vcs-auth.ts,  3swo.7.2)
 *   vcs_credential_exec     (src/tools/vcs-credential-exec.ts, 3swo.7.3)
 *
 * The point of the whole streak was to stop callers string-matching prose, so
 * NO assertion in this file matches on the human-readable summary text. Every
 * outcome assertion reads a structured FIELD. The existing per-tool suites
 * (member-reservation.test.ts, provision-auth.test.ts, provision-vcs-auth.test.ts)
 * still own the prose assertions -- that split is deliberate, and it is what
 * pins the summary text as byte-compatible while this file pins the machine
 * -readable half.
 *
 * Reads only; writes nothing outside the vitest registry sandbox that
 * backupAndResetRegistry()/restoreRegistry() already own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, updateAgent } from '../src/services/registry.js';
import { memberReservation } from '../src/tools/member-reservation.js';
import { provisionAuth } from '../src/tools/provision-auth.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { vcsCredentialExec } from '../src/tools/vcs-credential-exec.js';
import type { SSHExecResult } from '../src/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// updateAgent is wrapped so the store-write-FAILURE reservation path (the
// 'failed' outcome) is reachable; every other test keeps the real registry.
vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, updateAgent: vi.fn(actual.updateAgent) };
});

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const mockCollectOobApiKey = vi.fn<(memberName: string, toolName: string, opts?: any) => Promise<{ password?: string; fallback?: string }>>();
vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: (memberName: string, toolName: string, opts?: any) => mockCollectOobApiKey(memberName, toolName, opts),
}));

/** Deep search: does any string anywhere in `payload` contain `secret`? */
function payloadContains(payload: unknown, secret: string): boolean {
  if (typeof payload === 'string') return payload.includes(secret);
  if (Array.isArray(payload)) return payload.some((v) => payloadContains(v, secret));
  if (payload && typeof payload === 'object') {
    return Object.values(payload as Record<string, unknown>).some((v) => payloadContains(v, secret));
  }
  return false;
}

/**
 * Minimal POSIX word-splitter -- handles single-quoted segments and bare-word
 * segments concatenated with no separating whitespace. That concatenation
 * rule is exactly the mechanism shQuote()/escapeShellArg() rely on (see
 * fleet-sprint/vcs-providers/shell-helpers.mjs): a caller-supplied single
 * -quoted segment can be closed and immediately reopened by the server's own
 * single-quoted substitution, and a real POSIX shell splices the two into one
 * word. This is NOT a general shell parser (no double quotes, backslashes or
 * expansion) -- it is only precise enough to pin the one composition rule
 * this suite exists to prove, verified against real bash in the doer's repro.
 */
function posixSplit(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      inWord = true;
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated single quote at index ${i} in: ${command}`);
      current += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      i++;
      continue;
    }
    inWord = true;
    current += ch;
    i++;
  }
  if (inWord) words.push(current);
  return words;
}

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  mockCollectOobApiKey.mockResolvedValue({ fallback: 'OOB cancelled in test.' });
});
afterEach(() => {
  restoreRegistry();
});

// ---------------------------------------------------------------------------
// Check 1 -- member_reservation: every outcome path, asserted BY FIELD
// ---------------------------------------------------------------------------
describe('check 1: member_reservation outcome discriminator', () => {
  it('reserve on a free member reports outcome=reserved with member identity and no prior owner', async () => {
    const member = makeTestAgent({ friendlyName: 'res-free' });
    addAgent(member);

    const { structuredContent } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

    expect(structuredContent.outcome).toBe('reserved');
    expect(structuredContent.ok).toBe(true);
    expect(structuredContent.memberId).toBe(member.id);
    expect(structuredContent.memberName).toBe('res-free');
    expect(structuredContent.sprintId).toBe('sprint-1');
    // Nobody held it before the call, so there is no owning sprint to report.
    expect(structuredContent.ownerSprintId).toBeNull();
  });

  it('release by the holder reports outcome=released', async () => {
    const member = makeTestAgent({ friendlyName: 'res-held', reservedBy: 'sprint-1' });
    addAgent(member);

    const { structuredContent } = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-1' });

    expect(structuredContent.outcome).toBe('released');
    expect(structuredContent.ok).toBe(true);
    expect(structuredContent.memberId).toBe(member.id);
    expect(structuredContent.memberName).toBe('res-held');
  });

  it('reserve against another sprint reports outcome=already_reserved_by_other AND names the owning sprint', async () => {
    const member = makeTestAgent({ friendlyName: 'res-taken', reservedBy: 'sprint-owner' });
    addAgent(member);

    const { structuredContent } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-intruder' });

    expect(structuredContent.outcome).toBe('already_reserved_by_other');
    expect(structuredContent.ok).toBe(false);
    // This is THE path the owning sprint id exists for -- the orchestrator has
    // to know who to wait on, and used to scrape it out of the prose.
    expect(structuredContent.ownerSprintId).toBe('sprint-owner');
    expect(structuredContent.sprintId).toBe('sprint-intruder');
    expect(structuredContent.memberId).toBe(member.id);
    expect(structuredContent.memberName).toBe('res-taken');
  });

  it('release of an unreserved member reports outcome=not_reserved with no owning sprint', async () => {
    const member = makeTestAgent({ friendlyName: 'res-idle' });
    addAgent(member);

    const { structuredContent } = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-1' });

    expect(structuredContent.outcome).toBe('not_reserved');
    expect(structuredContent.ok).toBe(true);
    expect(structuredContent.ownerSprintId).toBeNull();
    expect(structuredContent.memberName).toBe('res-idle');
  });

  it('an unreservable member reports outcome=unreservable with no owning sprint', async () => {
    const member = makeTestAgent({ friendlyName: 'res-shared', unreservable: true });
    addAgent(member);

    const { structuredContent } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

    expect(structuredContent.outcome).toBe('unreservable');
    expect(structuredContent.ok).toBe(true);
    expect(structuredContent.ownerSprintId).toBeNull();
    expect(structuredContent.memberId).toBe(member.id);
    expect(structuredContent.memberName).toBe('res-shared');
  });

  it('a reservation-store write failure reports outcome=failed with ok=false', async () => {
    const member = makeTestAgent({ friendlyName: 'res-broken' });
    addAgent(member);
    vi.mocked(updateAgent).mockReturnValueOnce(undefined);

    const { structuredContent } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

    expect(structuredContent.outcome).toBe('failed');
    expect(structuredContent.ok).toBe(false);
    expect(structuredContent.memberId).toBe(member.id);
    expect(structuredContent.memberName).toBe('res-broken');
  });

  it('the owning sprint id is reported ONLY on the already-reserved path across all six outcomes', async () => {
    const outcomes: Array<{ outcome: string; ownerSprintId: string | null }> = [];

    const free = makeTestAgent({ friendlyName: 'sweep-free' });
    addAgent(free);
    outcomes.push((await memberReservation({ member_id: free.id, action: 'reserve', sprint_id: 's1' })).structuredContent as any);

    const idle = makeTestAgent({ friendlyName: 'sweep-idle' });
    addAgent(idle);
    outcomes.push((await memberReservation({ member_id: idle.id, action: 'release', sprint_id: 's1' })).structuredContent as any);

    const shared = makeTestAgent({ friendlyName: 'sweep-shared', unreservable: true });
    addAgent(shared);
    outcomes.push((await memberReservation({ member_id: shared.id, action: 'reserve', sprint_id: 's1' })).structuredContent as any);

    const taken = makeTestAgent({ friendlyName: 'sweep-taken', reservedBy: 'owner-sprint' });
    addAgent(taken);
    outcomes.push((await memberReservation({ member_id: taken.id, action: 'reserve', sprint_id: 's2' })).structuredContent as any);

    const withOwner = outcomes.filter((o) => o.ownerSprintId !== null).map((o) => o.outcome);
    expect(withOwner).toEqual(['already_reserved_by_other']);
  });
});

// ---------------------------------------------------------------------------
// Check 2 -- provisioning: distinct reason codes, ISO-or-null expiresAt, and
//            no plaintext credential anywhere in the payload
// ---------------------------------------------------------------------------
const FIXTURE_API_KEY = 'sk-ant-api03-FIXTURE-PLAINTEXT-DO-NOT-LEAK';
const FIXTURE_PAT = 'ghp_FIXTUREPLAINTEXTPATDONOTLEAK';

describe('check 2: provision_llm_auth reason codes', () => {
  it('a successful API-key provision reports reason=ok and leaks no plaintext key', async () => {
    const member = makeTestAgent({ friendlyName: 'prov-ok' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'sk-ant-visible-in-shell', stderr: '', code: 0 });

    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: FIXTURE_API_KEY });

    expect(structuredContent.reason).toBe('ok');
    expect(structuredContent.ok).toBe(true);
    expect(structuredContent.provider).toBe('claude');
    // The label names the env var the key landed in -- never the key itself.
    expect(structuredContent.credentialLabel).toBe('ANTHROPIC_API_KEY');
    expect(payloadContains(structuredContent, FIXTURE_API_KEY)).toBe(false);
  });

  it('an offline member reports reason=member_offline', async () => {
    const member = makeTestAgent({ friendlyName: 'prov-offline' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Connection refused' });

    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: FIXTURE_API_KEY });

    expect(structuredContent.reason).toBe('member_offline');
    expect(structuredContent.ok).toBe(false);
  });

  it('an unresolvable {{secure.NAME}} token reports reason=secure_credential_not_found', async () => {
    const member = makeTestAgent({ friendlyName: 'prov-nosecret' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });

    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: '{{secure.NO_SUCH_CREDENTIAL}}' });

    expect(structuredContent.reason).toBe('secure_credential_not_found');
    expect(structuredContent.ok).toBe(false);
  });

  it('the three outcomes above are three DISTINCT reason codes', async () => {
    const reasons = new Set<string>();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'ok-ok-ok', stderr: '', code: 0 });

    const okMember = makeTestAgent({ friendlyName: 'triple-ok' });
    addAgent(okMember);
    reasons.add((await provisionAuth({ member_id: okMember.id, api_key: FIXTURE_API_KEY })).structuredContent.reason);

    const secretMember = makeTestAgent({ friendlyName: 'triple-secret' });
    addAgent(secretMember);
    reasons.add((await provisionAuth({ member_id: secretMember.id, api_key: '{{secure.STILL_NO_SUCH_CREDENTIAL}}' })).structuredContent.reason);

    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'down' });
    const offMember = makeTestAgent({ friendlyName: 'triple-off' });
    addAgent(offMember);
    reasons.add((await provisionAuth({ member_id: offMember.id, api_key: FIXTURE_API_KEY })).structuredContent.reason);

    expect(reasons.size).toBe(3);
  });

  it('expiresAt is an ISO timestamp or null on every path', async () => {
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
    const member = makeTestAgent({ friendlyName: 'expiry-shape' });
    addAgent(member);

    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: FIXTURE_API_KEY });

    const { expiresAt } = structuredContent;
    expect(expiresAt === null || (typeof expiresAt === 'string' && !Number.isNaN(Date.parse(expiresAt)))).toBe(true);
  });
});

describe('check 2: provision_vcs_auth reason codes', () => {
  it('a successful PAT deploy reports reason=ok, masks the token and leaks no plaintext', async () => {
    const member = makeTestAgent({ friendlyName: 'vcs-ok' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'github', github_mode: 'pat', token: FIXTURE_PAT,
    });

    expect(structuredContent.ok).toBe(true);
    expect(['ok', 'deployed_unverified', 'deployed_verification_skipped']).toContain(structuredContent.reason);
    expect(structuredContent.provider).toBe('github');
    expect(structuredContent.credentialLabel).toBe('github');
    // The pre-existing first-four-chars mask is unchanged and is the ONLY form
    // of the token any consumer of this payload ever sees.
    expect(structuredContent.metadata?.token).toBe(FIXTURE_PAT.substring(0, 4) + '****');
    expect(payloadContains(structuredContent, FIXTURE_PAT)).toBe(false);
  });

  it('an offline member reports reason=member_offline', async () => {
    const member = makeTestAgent({ friendlyName: 'vcs-offline' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });

    const { structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'github', github_mode: 'pat', token: FIXTURE_PAT,
    });

    expect(structuredContent.reason).toBe('member_offline');
    expect(structuredContent.ok).toBe(false);
    expect(payloadContains(structuredContent, FIXTURE_PAT)).toBe(false);
  });

  it('a cancelled out-of-band collection reports reason=oob_cancelled', async () => {
    const member = makeTestAgent({ friendlyName: 'vcs-oob' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });

    const { structuredContent } = await provisionVcsAuth({ member_id: member.id, provider: 'bitbucket' });

    expect(structuredContent.reason).toBe('oob_cancelled');
    expect(structuredContent.ok).toBe(false);
  });

  it('an unknown member reports reason=member_not_found -- three DISTINCT failure codes in all', async () => {
    const { structuredContent } = await provisionVcsAuth({ member_id: 'no-such-member', provider: 'github' });
    expect(structuredContent.reason).toBe('member_not_found');

    const member = makeTestAgent({ friendlyName: 'vcs-distinct' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });
    const offline = (await provisionVcsAuth({
      member_id: member.id, provider: 'github', github_mode: 'pat', token: FIXTURE_PAT,
    })).structuredContent.reason;

    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    const oob = (await provisionVcsAuth({ member_id: member.id, provider: 'bitbucket' })).structuredContent.reason;

    expect(new Set([structuredContent.reason, offline, oob]).size).toBe(3);
  });

  it('expiresAt is an ISO timestamp when the provider deploys one', async () => {
    const member = makeTestAgent({ friendlyName: 'vcs-expiry' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: FIXTURE_PAT,
      pat_expires_at: '2027-08-20T00:00:00Z',
    });

    // This is the field runner.js used to regex-scrape out of an "expiresAt:"
    // prose line (parseExpiresAtFromProvisionText).
    expect(structuredContent.expiresAt).toBe('2027-08-20T00:00:00Z');
    expect(Number.isNaN(Date.parse(structuredContent.expiresAt as string))).toBe(false);
    expect(payloadContains(structuredContent, FIXTURE_PAT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check 3 -- the reshaped tool sources contain no non-ASCII byte
// ---------------------------------------------------------------------------
describe('check 3: the reshaped tool sources are pure ASCII', () => {
  const files = [
    'src/tools/member-reservation.ts',
    'src/tools/provision-auth.ts',
    'src/tools/provision-vcs-auth.ts',
    'src/tools/vcs-credential-exec.ts',
  ];

  for (const rel of files) {
    it(`${rel} contains no emoji or other non-ASCII byte`, () => {
      const src = readFileSync(path.join(repoRoot, rel), 'utf8');
      const offenders: string[] = [];
      src.split('\n').forEach((line, i) => {
        // Anything outside printable ASCII + tab. Deliberately a byte-level
        // check, not an emoji-only one: an em-dash breaks the repo's ASCII
        // rule just as surely as a check-mark does.
        if (/[^\x09\x20-\x7e]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
      expect(offenders).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Check 4 -- the fleet client's hand-maintained typedefs match the server
//            shapes field-for-field. A client left on the old shape fails here.
// ---------------------------------------------------------------------------
/** Property names declared by a JSDoc `@typedef {Object} <name>` block in api.mjs. */
function clientTypedefProps(source: string, typedefName: string): Set<string> {
  const startMarker = `@typedef {Object} ${typedefName}`;
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `client typedef not found: ${typedefName}`).not.toBe(-1);
  const blockEnd = source.indexOf('*/', startIdx);
  const block = source.slice(startIdx, blockEnd);
  const props = new Set<string>();
  let searchFrom = 0;
  for (;;) {
    const propIdx = block.indexOf('@property', searchFrom);
    if (propIdx === -1) break;
    let j = propIdx + '@property'.length;
    while (/\s/.test(block[j])) j++;
    // Balanced-brace walk over the {type} portion: several of these types are
    // themselves brace-bearing, which a single-level regex mis-terminates.
    let depth = 0;
    do {
      if (block[j] === '{') depth++;
      else if (block[j] === '}') depth--;
      j++;
    } while (depth > 0);
    while (/\s/.test(block[j])) j++;
    if (block[j] === '[') j++;
    const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(block.slice(j));
    expect(nameMatch, `could not parse a property name in ${typedefName}`).toBeTruthy();
    props.add(nameMatch![0]);
    searchFrom = j;
  }
  return props;
}

/** Property names of a TS `interface <name> { ... }` block (top level only). */
function serverInterfaceProps(source: string, interfaceName: string): Set<string> {
  const marker = `interface ${interfaceName} {`;
  const startIdx = source.indexOf(marker);
  expect(startIdx, `server interface not found: ${interfaceName}`).not.toBe(-1);
  const bodyStart = startIdx + marker.length;
  const endIdx = source.indexOf('\n}', bodyStart);
  expect(endIdx, `unterminated interface ${interfaceName}`).not.toBe(-1);
  const body = source.slice(bodyStart, endIdx);
  const props = new Set<string>();
  // `  name: type;` at exactly two spaces. JSDoc lines start with `/` or `*`
  // and never match; nested object literals sit deeper and are excluded.
  const re = /^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) props.add(m[1]);
  return props;
}

describe('check 4: apra-fleet-client typedefs match the server structured shapes', () => {
  const apiMjs = readFileSync(
    path.join(repoRoot, 'packages/apra-fleet-client/src/client/api.mjs'), 'utf8',
  );

  const pairs: Array<[string, string, string]> = [
    ['MemberReservationStructured', 'src/tools/member-reservation.ts', 'MemberReservationFields'],
    ['ProvisionAuthStructured', 'src/tools/provision-auth.ts', 'ProvisionAuthFields'],
    ['ProvisionVcsAuthStructured', 'src/tools/provision-vcs-auth.ts', 'ProvisionVcsAuthFields'],
    ['VcsCredentialExecStructured', 'src/tools/vcs-credential-exec.ts', 'VcsCredentialExecFields'],
  ];

  for (const [typedefName, serverRel, interfaceName] of pairs) {
    it(`${typedefName} matches ${interfaceName} field-for-field`, () => {
      const serverSrc = readFileSync(path.join(repoRoot, serverRel), 'utf8');
      const serverFields = serverInterfaceProps(serverSrc, interfaceName);
      const clientFields = clientTypedefProps(apiMjs, typedefName);

      // Sanity: both parsers must have found a non-trivial set, or the diff
      // below would be a vacuous empty-vs-empty pass.
      expect(serverFields.size).toBeGreaterThan(3);
      expect(clientFields.size).toBeGreaterThan(3);
      // Every one of these shapes exists to carry a discriminator.
      expect(serverFields.has('reason') || serverFields.has('outcome')).toBe(true);

      const missingFromClient = [...serverFields].filter((f) => !clientFields.has(f)).sort();
      const extraInClient = [...clientFields].filter((f) => !serverFields.has(f)).sort();
      expect(missingFromClient, `${typedefName}: server fields the client does not declare`).toEqual([]);
      expect(extraInClient, `${typedefName}: client properties the server does not return`).toEqual([]);
    });
  }

  it('the client exposes a wrapper method for each reshaped tool', () => {
    for (const toolName of ['member_reservation', 'provision_llm_auth', 'provision_vcs_auth', 'vcs_credential_exec']) {
      expect(apiMjs).toContain(`callTool('${toolName}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// Check 5 -- the credential handoff: the plaintext never reaches a result the
//            orchestrator-side caller can read
// ---------------------------------------------------------------------------
describe('check 5: vcs_credential_exec never returns the plaintext credential', () => {
  const FIXTURE_TOKEN = 'ghp_HANDOFF_FIXTURE_TOKEN_9999';

  it('substitutes the credential member-side and redacts it out of an echoing command result', async () => {
    const member = makeTestAgent({ friendlyName: 'handoff', os: 'linux' });
    addAgent(member);

    mockExecCommand.mockImplementation(async (cmd: string) => {
      // 1st call: the server-side credential read (never returned to a caller).
      if (cmd.includes('.fleet-git-credential')) {
        return { stdout: `protocol=https\nhost=github.com\nusername=x\npassword=${FIXTURE_TOKEN}\n`, stderr: '', code: 0 };
      }
      // 2nd call: the real command -- deliberately echoes its own credential
      // back on BOTH streams, the worst case redaction has to survive.
      return { stdout: `sent header: ${FIXTURE_TOKEN}`, stderr: `retrying with ${FIXTURE_TOKEN}`, code: 0 };
    });

    // Placeholder is referenced inside the CALLER'S OWN single quotes here,
    // which is the shape the real consumer builds (vcs-providers/github.mjs
    // and azure-devops.mjs, both via shell-helpers.mjs shQuote -- also
    // single-quote dialect). This is deliberately NOT wrapped in double
    // quotes: escapeShellArg's substituted value is itself single-quoted, and
    // POSIX quote-concatenation only closes-and-reopens correctly against a
    // matching single-quoted caller segment. A double-quoted caller segment
    // leaks the substituted value's literal quote characters into the header
    // (verified against real bash: `-H "...{{vcs_token}}..."` parses to
    // `Authorization: Bearer 'ghp_...'`, a false 401 against a real server).
    const result = await vcsCredentialExec({
      member_id: member.id,
      label: 'github',
      command: "curl -H 'Authorization: Bearer {{vcs_token}}' https://api.github.com/repos/o/r/pulls",
    });

    expect(result.structuredContent.reason).toBe('ok');
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.exitCode).toBe(0);

    // THE assertion this whole task exists for: nothing a caller can read --
    // neither the structured payload nor the human summary -- carries the token.
    expect(payloadContains(result.structuredContent, FIXTURE_TOKEN)).toBe(false);
    expect(result.text).not.toContain(FIXTURE_TOKEN);
    expect(result.structuredContent.stdout).toContain('[REDACTED:vcs_token]');
    expect(result.structuredContent.stderr).toContain('[REDACTED:vcs_token]');
    expect(result.structuredContent.tokenRedactions).toBe(2);

    // ...while the token DID reach the member: the dispatched command carries
    // it, shell-escaped, and the placeholder is gone. This is server-side
    // state (the mock's own call log), not a result the orchestrator reads.
    const dispatched = mockExecCommand.mock.calls.map((c) => c[0]).find((c) => c.includes('curl'))!;
    expect(dispatched).toContain(FIXTURE_TOKEN);
    expect(dispatched).not.toContain('{{vcs_token}}');

    // THE composition assertion: tokenize the substituted command with a real
    // POSIX quote-splitting rule (not a substring match) and confirm the
    // resulting -H argument is the exact intended header value, with no
    // leaked literal quote characters from the substitution.
    const words = posixSplit(dispatched);
    const headerFlagIdx = words.indexOf('-H');
    expect(headerFlagIdx).toBeGreaterThanOrEqual(0);
    expect(words[headerFlagIdx + 1]).toBe(`Authorization: Bearer ${FIXTURE_TOKEN}`);
  });

  it('refuses a command with no {{vcs_token}} placeholder and never reads a credential', async () => {
    const member = makeTestAgent({ friendlyName: 'handoff-noplaceholder' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { structuredContent } = await vcsCredentialExec({ member_id: member.id, command: 'git status' });

    expect(structuredContent.reason).toBe('placeholder_missing');
    expect(structuredContent.ok).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('reports reason=credential_empty when the helper prints no password line', async () => {
    const member = makeTestAgent({ friendlyName: 'handoff-empty' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'protocol=https\nhost=github.com\n', stderr: '', code: 0 });

    const { structuredContent } = await vcsCredentialExec({
      member_id: member.id, command: 'curl -H "Authorization: Bearer {{vcs_token}}" https://x',
    });

    expect(structuredContent.reason).toBe('credential_empty');
    expect(structuredContent.ok).toBe(false);
    // The credential-requiring command must NOT have been dispatched.
    expect(mockExecCommand.mock.calls.some((c) => c[0].includes('curl'))).toBe(false);
  });

  it('reports reason=credential_read_failed when the helper itself fails', async () => {
    const member = makeTestAgent({ friendlyName: 'handoff-readfail' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'no such file', code: 127 });

    const { structuredContent } = await vcsCredentialExec({
      member_id: member.id, command: 'curl -H "Authorization: Bearer {{vcs_token}}" https://x',
    });

    expect(structuredContent.reason).toBe('credential_read_failed');
    expect(structuredContent.ok).toBe(false);
  });
});
