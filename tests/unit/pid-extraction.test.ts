import { describe, it, expect, afterEach } from 'vitest';
import { extractAndStorePid } from '../../src/services/strategy.js';
import { getStoredPid, clearStoredPid } from '../../src/utils/agent-helpers.js';
import type { SSHExecResult } from '../../src/types.js';

const AGENT_ID = 'pid-extract-test-agent';

function makeResult(stdout: string, code = 0): SSHExecResult {
  return { stdout, stderr: '', code };
}

afterEach(() => clearStoredPid(AGENT_ID));

describe('extractAndStorePid', () => {
  it('stores PID when FLEET_PID line is present', () => {
    const result = extractAndStorePid(AGENT_ID, makeResult('FLEET_PID:1234\n{"result":"ok"}'));
    expect(getStoredPid(AGENT_ID)).toBe(1234);
    expect(result.stdout).not.toContain('FLEET_PID:');
  });

  it('strips the FLEET_PID line from stdout', () => {
    const result = extractAndStorePid(AGENT_ID, makeResult('FLEET_PID:5678\n{"result":"hello"}'));
    expect(result.stdout).toBe('{"result":"hello"}');
  });

  it('is a no-op when no FLEET_PID line is present', () => {
    const raw = makeResult('{"result":"ok"}');
    const result = extractAndStorePid(AGENT_ID, raw);
    expect(result).toBe(raw);
    expect(getStoredPid(AGENT_ID)).toBeUndefined();
  });

  it('handles Windows CRLF line endings', () => {
    const result = extractAndStorePid(AGENT_ID, makeResult('FLEET_PID:9999\r\n{"result":"win"}'));
    expect(getStoredPid(AGENT_ID)).toBe(9999);
    expect(result.stdout).toBe('{"result":"win"}');
    expect(result.stdout).not.toContain('FLEET_PID:');
  });

  it('handles FLEET_PID line not at position 0 (truncation header before it)', () => {
    const stdout = '[OUTPUT TRUNCATED]\nFLEET_PID:4242\n{"result":"x"}';
    const result = extractAndStorePid(AGENT_ID, makeResult(stdout));
    expect(getStoredPid(AGENT_ID)).toBe(4242);
    expect(result.stdout).not.toContain('FLEET_PID:');
    expect(result.stdout).toContain('[OUTPUT TRUNCATED]');
    expect(result.stdout).toContain('{"result":"x"}');
  });

  it('preserves exit code and stderr unchanged', () => {
    const result = extractAndStorePid(AGENT_ID, { stdout: 'FLEET_PID:1\nout', stderr: 'some error', code: 42 });
    expect(result.stderr).toBe('some error');
    expect(result.code).toBe(42);
  });

  it('handles empty stdout gracefully', () => {
    const result = extractAndStorePid(AGENT_ID, makeResult(''));
    expect(result.stdout).toBe('');
    expect(getStoredPid(AGENT_ID)).toBeUndefined();
  });
});
