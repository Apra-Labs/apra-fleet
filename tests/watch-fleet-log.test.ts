import { describe, it, expect } from 'vitest';
import { formatFleetLogLine } from '../src/services/watch/fleet-log.js';

const ts = '2026-07-05T11:18:43.717+05:30';

function line(o: Record<string, unknown>): string {
  return JSON.stringify({ ts, level: 'info', ...o });
}

describe('formatFleetLogLine', () => {
  it('skips noise tags (stall ticks, startup)', () => {
    expect(formatFleetLogLine(line({ tag: 'stall_poll_tick', msg: 'x' }))).toBeNull();
    expect(formatFleetLogLine(line({ tag: 'startup', msg: 'up' }))).toBeNull();
  });

  it('returns null for unparseable lines', () => {
    expect(formatFleetLogLine('not json')).toBeNull();
  });

  it('renders an execute_command entry with a $ marker and attribution', () => {
    const r = formatFleetLogLine(line({ tag: 'execute_command', mem: 'ecs-remote', mid: 'abc', msg: 'ls -la' }));
    expect(r?.mem).toBe('ecs-remote');
    expect(r?.mid).toBe('abc');
    expect(r?.events[0]).toMatchObject({ marker: '$', text: 'ls -la' });
  });

  it('renders exit lifecycle as a dim detail line', () => {
    const r = formatFleetLogLine(line({ tag: 'execute_command', mem: 'm', msg: 'exit=0 elapsed=1081ms' }));
    expect(r?.events[0]).toMatchObject({ detail: true, kind: 'dim', text: '-> exit=0 elapsed=1081ms' });
  });

  it('marks an error-level exit as del kind', () => {
    const r = formatFleetLogLine(JSON.stringify({ ts, level: 'error', tag: 'execute_command', mem: 'm', msg: 'exit=1 elapsed=5ms' }));
    expect(r?.events[0]).toMatchObject({ detail: true, kind: 'del' });
  });

  it('hides pid lines unless verbose', () => {
    expect(formatFleetLogLine(line({ tag: 'execute_command', mem: 'm', msg: 'pid=953032' }))).toBeNull();
    const v = formatFleetLogLine(line({ tag: 'execute_command', mem: 'm', msg: 'pid=953032' }), true);
    expect(v?.events[0]).toMatchObject({ detail: true, text: '-> pid=953032' });
  });

  it('renders an execute_prompt entry with a > marker and LLM prefix', () => {
    const r = formatFleetLogLine(line({ tag: 'execute_prompt', mem: 'doer', msg: '[sonnet] resume=false timeout=120s Do the thing' }));
    expect(r?.events[0]).toMatchObject({ marker: '>' });
    expect(r?.events[0].text).toContain('LLM');
    expect(r?.events[0].text).toContain('Do the thing');
  });

  it('renders send_files with a > marker', () => {
    const r = formatFleetLogLine(line({ tag: 'send_files', mem: 'm', msg: '2 file(s)' }));
    expect(r?.events[0]).toMatchObject({ marker: '>' });
    expect(r?.events[0].text).toContain('send_files');
  });

  it('renders config events (update_member) dimmed with no marker', () => {
    const r = formatFleetLogLine(line({ tag: 'update_member', mem: 'm', msg: 'unattended=auto' }));
    expect(r?.events[0]).toMatchObject({ marker: '', kind: 'dim' });
    expect(r?.events[0].text).toContain('update_member');
  });
});
