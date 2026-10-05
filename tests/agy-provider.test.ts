import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AgyProvider } from '../src/providers/agy.js';
import type { SSHExecResult } from '../src/types.js';

function makeResult(stdout: string, code = 0): SSHExecResult {
  return { stdout, stderr: '', code };
}

// -- apra-fleet-qmb: parseResponse --
//
// execute_prompt against an agy member used to hand callers back an empty
// reply (structuredContent.response effectively "{}") because parseResponse
// was never exercised against a realistic captured transcript, and never
// captured the conversation id agy assigns even when the transcript exposed
// one. These tests pin both against a recorded (fixture) AGY CLI output --
// no live AGY dispatch involved anywhere here.
describe('AgyProvider parseResponse', () => {
  const p = new AgyProvider();
  const fixturePath = path.join(__dirname, 'fixtures', 'agy-transcript-output.txt');

  it('extracts the final PLANNER_RESPONSE reply text from the FLEET_TRANSCRIPT-wrapped JSONL', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toBe('Implemented the change in src/foo.ts and verified it builds cleanly.');
    expect(parsed.isError).toBe(false);
  });

  it('captures the conversation id exposed on an earlier transcript entry (not just the final one)', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.sessionId).toBe('conv-9f8e7d6c-aaaa-bbbb-cccc-000000000001');
  });

  it('reflects a non-zero exit code as isError even with a captured reply', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw, 1));
    expect(parsed.result).toBe('Implemented the change in src/foo.ts and verified it builds cleanly.');
    expect(parsed.isError).toBe(true);
  });

  it('leaves sessionId undefined when no transcript entry exposes a conversation id', () => {
    const raw = [
      'FLEET_TRANSCRIPT_START',
      '{"type":"USER_QUERY","status":"DONE","content":"do the task"}',
      '{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}',
      'FLEET_TRANSCRIPT_END',
    ].join('\n');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toBe('done');
    expect(parsed.sessionId).toBeUndefined();
  });

  it('ignores non-DONE PLANNER_RESPONSE entries and malformed JSON lines, keeping the last valid DONE reply', () => {
    const raw = [
      'FLEET_TRANSCRIPT_START',
      '{not valid json}',
      '{"type":"PLANNER_RESPONSE","status":"IN_PROGRESS","content":"still working"}',
      '{"type":"PLANNER_RESPONSE","status":"DONE","content":"first done"}',
      '{"type":"PLANNER_RESPONSE","status":"DONE","content":"final done"}',
      'FLEET_TRANSCRIPT_END',
    ].join('\n');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toBe('final done');
  });

  it('falls back to ANSI-stripped raw stdout when the transcript markers are missing entirely (e.g. FLEET_TRANSCRIPT_MISSING)', () => {
    const raw = 'FLEET_PID:1234\nFLEET_TRANSCRIPT_MISSING:NOT_IN_CACHE:/home/user/project\n';
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toContain('FLEET_TRANSCRIPT_MISSING');
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.isError).toBe(false);
  });

  it('never returns an empty {} result when the transcript carries a real reply (apra-fleet-qmb regression guard)', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).not.toBe('');
    expect(parsed.result.length).toBeGreaterThan(0);
  });
});

