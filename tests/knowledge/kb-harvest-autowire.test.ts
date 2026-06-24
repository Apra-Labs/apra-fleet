import { describe, it, expect, vi } from 'vitest';

describe('kb_harvest auto-wire', () => {
  it('execute-prompt imports kb-harvest after successful completion', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/tools/execute-prompt.ts', 'utf-8')
    );
    expect(src).toContain("import('./kb-harvest.js')");
    expect(src).toContain('kbHarvest');
    expect(src).toContain('session_transcript: parsed.result');
  });

  it('auto-harvest is fire-and-forget (void import)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/tools/execute-prompt.ts', 'utf-8')
    );
    expect(src).toContain("void import('./kb-harvest.js')");
  });

  it('auto-harvest catches errors and logs warning', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/tools/execute-prompt.ts', 'utf-8')
    );
    expect(src).toContain('auto-harvest failed');
    expect(src).toContain('logWarn');
  });
});
