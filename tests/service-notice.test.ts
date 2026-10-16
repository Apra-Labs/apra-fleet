/**
 * Pending service notice: guidance a detached install (apra-fleet update)
 * could not show is persisted and printed once by the next service verb.
 * Uses a private temp dir only (removed afterwards).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeServiceNotice, clearServiceNotice, takePendingServiceNotice, showPendingServiceNotice,
} from '../src/services/service-notice.js';

describe('service notice', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-notice-'));
    file = path.join(dir, 'data', 'service-notice.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is shown exactly once, then stays on disk until cleared', () => {
    writeServiceNotice('do X then Y', file);
    expect(takePendingServiceNotice(file)).toBe('do X then Y');
    expect(takePendingServiceNotice(file)).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
    clearServiceNotice(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(takePendingServiceNotice(file)).toBeNull();
  });

  it('a new notice is shown again even after an earlier one was shown', () => {
    writeServiceNotice('first', file);
    takePendingServiceNotice(file);
    writeServiceNotice('second', file);
    expect(takePendingServiceNotice(file)).toBe('second');
  });

  it('showPendingServiceNotice prints on stderr once; nothing when absent or corrupt', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      showPendingServiceNotice(file);
      expect(err).not.toHaveBeenCalled();
      writeServiceNotice('run apra-fleet install', file);
      showPendingServiceNotice(file);
      showPendingServiceNotice(file);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toMatch(/Note from the last apra-fleet install:\nrun apra-fleet install/);
      expect(log).not.toHaveBeenCalled();
      fs.writeFileSync(file, '{not json');
      showPendingServiceNotice(file);
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});
