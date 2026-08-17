import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import type { KbProviders } from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry } from '../../src/services/knowledge/types.js';

// apra-fleet-b4g.1.6: apra-fleet-b4g.1.3 wired repo_remote_url through the
// three hot-path kb tool schemas and forwarded it to getKbProviders as the
// second argument at kb-capture.ts:53, kb-harvest.ts:107 and
// kb-session-prime.ts:185, but shipped with no automated coverage. zod strips
// unknown keys silently, so a dropped `...kbScopeFields` spread would resolve
// to an empty KB rather than error. This file pins both halves of the wiring:
// the schema layer (case 1) and the handler forwarding (cases 2-3), plus the
// slug-resolution consequence of a remote-scoped call (case 4).
//
// TABLE-DRIVEN over the three wired tools (case 1-3) rather than three
// copy-pasted describe blocks: apra-fleet-b4g.1.4 extends this same table to
// the remaining kb tools once it wires them, and depends on this shape --
// adding a tool requires no new assertion code, only a new TOOLS entry.

const mockGetKbProviders = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/knowledge/kb-providers.js', () => ({
  getKbProviders: mockGetKbProviders,
}));

import { kbCaptureSchema, kbCapture } from '../../src/tools/kb-capture.js';
import { kbHarvestSchema, kbHarvest } from '../../src/tools/kb-harvest.js';
import { kbSessionPrimeSchema, kbSessionPrime } from '../../src/tools/kb-session-prime.js';

function entry(id: string): KBEntry {
  return {
    id,
    type: 'knowledge',
    title: id,
    summary: `summary-${id}`,
    content: '',
    source_files: ['src/fixture.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    stale: false,
    flagged_for_review: false,
    author: '',
    source: 'doer',
    confidence: 'CONFIRMED',
    created_at: '2026-01-01T00:00:00.000Z',
    use_count: 0,
  };
}

// >= COLD_KB_MAX (3) so kb_session_prime's canonical-bible cold-seed blocks
// never fire -- keeps this file's providers stub the only thing under test.
function primedContext() {
  return {
    session_warm: true,
    stale_files: [],
    top_entries: [entry('a'), entry('b'), entry('c')],
    fresh_summaries: [],
    recommended_code_calls: [],
    token_estimate: 0,
  };
}

interface ToolCase {
  name: string;
  schema: z.ZodTypeAny;
  call: (input: unknown) => Promise<string>;
  // Fields (besides repo_path/repo_remote_url) needed to satisfy the schema
  // and to make the handler actually reach getKbProviders (kb_harvest early-
  // returns before calling it when session_transcript is absent).
  minimalInput: Record<string, unknown>;
  // Stub returned by the mocked getKbProviders for this tool's call path.
  providersStub: () => KbProviders;
}

const TOOLS: ToolCase[] = [
  {
    name: 'kb_capture',
    schema: kbCaptureSchema,
    call: input => kbCapture(input as Parameters<typeof kbCapture>[0]),
    minimalInput: { type: 'knowledge', title: 't', summary: 's', content: 'c' },
    providersStub: () => ({
      project: { capture: vi.fn().mockResolvedValue({ id: 'id1', audn_decision: 'add' }) } as any,
      global: { capture: vi.fn() } as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_harvest',
    schema: kbHarvestSchema,
    call: input => kbHarvest(input as Parameters<typeof kbHarvest>[0]),
    // A plain sentence yields no LEARNING_PATTERNS match, so provider.capture
    // is never invoked -- only the early-return guard (session_transcript
    // absent) needs to be avoided.
    minimalInput: { session_transcript: 'This is a plain sentence with nothing to extract.' },
    providersStub: () => ({
      project: { capture: vi.fn() } as any,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_session_prime',
    schema: kbSessionPrimeSchema,
    call: input => kbSessionPrime(input as Parameters<typeof kbSessionPrime>[0]),
    minimalInput: {},
    providersStub: () => ({
      project: { prime: vi.fn().mockResolvedValue(primedContext()) } as any,
      global: { query: vi.fn() } as any,
      projectSlug: 'slug',
    }),
  },
];

describe.each(TOOLS)('$name repo_remote_url wiring', ({ schema, call, minimalInput, providersStub }) => {
  beforeEach(() => {
    mockGetKbProviders.mockReset();
    mockGetKbProviders.mockResolvedValue(providersStub());
  });

  // Case 1: the schema accepts repo_remote_url and preserves it through
  // .parse(). Guards the zod silent-strip mode if kbScopeFields is ever
  // dropped from a tool's schema spread.
  it('schema accepts and preserves repo_remote_url through .parse()', () => {
    const parsed = schema.parse({
      ...minimalInput,
      repo_remote_url: 'https://example.com/acme/repo.git',
    }) as { repo_remote_url?: string };
    expect(parsed.repo_remote_url).toBe('https://example.com/acme/repo.git');
  });

  // Case 2: the handler forwards repo_remote_url to getKbProviders as the
  // SECOND argument. Fails if that argument is ever deleted from the call
  // site.
  it('forwards repo_remote_url to getKbProviders as the second argument', async () => {
    await call({ ...minimalInput, repo_remote_url: 'https://example.com/acme/repo.git' });

    expect(mockGetKbProviders).toHaveBeenCalledTimes(1);
    expect(mockGetKbProviders.mock.calls[0][1]).toBe('https://example.com/acme/repo.git');
  });

  // Case 3: omitting repo_remote_url keeps the pre-change one-argument
  // behaviour -- no default is injected, the second argument stays undefined,
  // and the field stays optional at the schema layer.
  it('omitting repo_remote_url keeps the pre-change behaviour (no default injected)', async () => {
    const parsed = schema.parse({ ...minimalInput }) as { repo_remote_url?: string };
    expect(parsed.repo_remote_url).toBeUndefined();

    await call({ ...minimalInput });

    expect(mockGetKbProviders).toHaveBeenCalledTimes(1);
    expect(mockGetKbProviders.mock.calls[0][1]).toBeUndefined();
  });
});

// Case 4: slug resolution for a nonexistent remote-style repo_path. Uses the
// REAL kb-providers module (bypassing the vi.mock above via importActual) so
// resolveProjectSlug's remote-URL short-circuit is genuinely exercised --
// NOT a capture-then-read round trip, since sqlite-provider.ts:323 rejects
// any capture whose source files cannot resolve under a repoPath that does
// not exist on disk, before or after this sprint's fixes (that end-to-end
// case belongs to apra-fleet-b4g.1.5, which uses a real tmpdir fixture).
describe('slug resolution: nonexistent remote-style repo_path + fake remote URL', () => {
  afterEach(async () => {
    const real = await vi.importActual<typeof import('../../src/services/knowledge/kb-providers.js')>(
      '../../src/services/knowledge/kb-providers.js',
    );
    real.resetKbProviders();
  });

  it('resolves to the URL-derived slug, not "default"', async () => {
    const real = await vi.importActual<typeof import('../../src/services/knowledge/kb-providers.js')>(
      '../../src/services/knowledge/kb-providers.js',
    );
    const remoteUrl = `git@github.com:acme/does-not-exist-${crypto.randomUUID()}.git`;
    const fakeRepoPath = `/definitely/does/not/exist/${crypto.randomUUID()}`;

    const providers = await real.getKbProviders(fakeRepoPath, remoteUrl);

    expect(providers.projectSlug).not.toBe('default');
    expect(providers.projectSlug).toBe(resolveProjectSlug(undefined, remoteUrl));
  });
});
