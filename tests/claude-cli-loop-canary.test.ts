/**
 * Verdict logic of scripts/claude-cli-loop-canary.mjs against recorded Claude
 * CLI stream-json output (tests/fixtures/claude-loop-canary/, see its README
 * for provenance). No network and no real CLI: canaryVerdict only parses the
 * recorded stdout with the real ClaudeProvider and runs the real fleet-sprint
 * engine (dispatchRole + createPermissionDenialHeal) on it.
 *
 * Which verdict mapping each case guards:
 *   (a) loop refused, complete reply        -> PASS (engine continues)
 *   (b) loop refused, incomplete reply,
 *       inner commands within the policy    -> PASS (engine nudges)
 *   (c) inner command outside the policy    -> FAIL (engine would abort)
 *   (d) credential rejected / install fails -> NOT RUN, never PASS
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude.js';
// @ts-ignore -- plain ESM script without type declarations
import { canaryVerdict, VERDICT, EXIT_CODES, CANARY_LOOP } from '../scripts/claude-cli-loop-canary.mjs';

const FIXTURES = path.join(__dirname, 'fixtures', 'claude-loop-canary');
const recorded = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
const provider = new ClaudeProvider();
const verdictFor = (name: string, code = 0) => canaryVerdict({ dispatch: { stdout: recorded(name), stderr: '', code } }, { provider });

describe('claude-cli-loop-canary verdict', () => {
  it('the recorded latest-CLI run refused the canary loop (fixture sanity)', () => {
    const parsed = provider.parseResponse({ stdout: recorded('loop-refused-complete.jsonl'), stderr: '', code: 0 }, { unattended: false });
    expect(parsed.permissionDenial?.denials.map((d) => d.target)).toEqual([CANARY_LOOP]);
    expect(parsed.result).toBe('CANARY-REPLY refused');
  });

  it('(a) loop refused with a complete reply -> PASS, the engine continues with a warning', async () => {
    const v = await verdictFor('loop-refused-complete.jsonl');
    expect(v.verdict).toBe(VERDICT.PASS);
    expect(v.decision).toBe('continue');
    expect(v.refused).toBe(true);
    expect(v.grants).toEqual([]);
    expect(v.logs.some((l: string) => /WARNING/.test(l) && l.includes(CANARY_LOOP))).toBe(true);
  });

  it('(b) loop refused, incomplete reply, inner commands within policy -> PASS, the engine nudges', async () => {
    const v = await verdictFor('loop-refused-incomplete.jsonl');
    expect(v.verdict).toBe(VERDICT.PASS);
    expect(v.decision).toBe('nudge');
    expect(v.grants).toEqual([]);
  });

  it('(c) a refusal the engine cannot heal -> FAIL, the engine would abort', async () => {
    const v = await verdictFor('loop-refused-outside-policy.jsonl');
    expect(v.verdict).toBe(VERDICT.FAIL);
    expect(v.decision).toBe('abort');
    expect(v.reason).toMatch(/MemberPermissionDeniedError/);
    expect(v.reason).toMatch(/curl -s/);
    expect(v.grants).toEqual([]);
  });

  it('(d) a rejected credential or a failed install -> NOT RUN, never PASS', async () => {
    const auth = await verdictFor('auth-failure.jsonl', 1);
    expect(auth.verdict).toBe(VERDICT.NOT_RUN);
    expect(auth.reason).toMatch(/credential/);
    const install = await canaryVerdict({ notRun: 'npm install @anthropic-ai/claude-code@latest failed (npm exited 1): ENOTFOUND' }, { provider });
    expect(install.verdict).toBe(VERDICT.NOT_RUN);
    const noCredential = await canaryVerdict({ notRun: 'no usable LLM credential: nothing stored' }, { provider });
    expect(noCredential.verdict).toBe(VERDICT.NOT_RUN);
    for (const v of [auth, install, noCredential]) expect(v.verdict).not.toBe(VERDICT.PASS);
  });

  it('exit codes match the documented header: PASS 0, FAIL 1, NOT RUN 2', () => {
    expect(EXIT_CODES[VERDICT.PASS]).toBe(0);
    expect(EXIT_CODES[VERDICT.FAIL]).toBe(1);
    expect(EXIT_CODES[VERDICT.NOT_RUN]).toBe(2);
    expect(VERDICT.NOT_RUN).toBe('NOT RUN');
  });
});
