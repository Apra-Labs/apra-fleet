import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from './test-helpers.js';
import { loadUserConfig, getModelOverride, getLogPreviewChars, DEFAULT_LOG_PREVIEW_CHARS, _resetCache } from '../src/services/user-config.js';

const CONFIG_PATH = path.join(FLEET_DIR, 'config.json');

describe('user-config loader', () => {
  beforeEach(() => {
    _resetCache();
    if (!fs.existsSync(FLEET_DIR)) {
      fs.mkdirSync(FLEET_DIR, { recursive: true });
    }
    // Clean up any existing config
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  afterEach(() => {
    _resetCache();
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  it('returns empty config when file is missing', () => {
    const config = loadUserConfig();
    expect(config).toEqual({});
  });

  it('loads well-formed config with valid providers and tiers', () => {
    const data = {
      providers: {
        agy: {
          modelMapping: {
            cheap: 'GPT-OSS 120B (Medium)',
            standard: 'Gemini 3.1 Pro (High)',
            premium: 'Claude Opus 4.6 (Thinking)',
          },
        },
        claude: {
          modelMapping: {
            cheap: 'claude-haiku-4-5',
          },
        },
      },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data), 'utf-8');

    const config = loadUserConfig();
    expect(config.providers?.agy?.modelMapping?.cheap).toBe('GPT-OSS 120B (Medium)');
    expect(config.providers?.agy?.modelMapping?.standard).toBe('Gemini 3.1 Pro (High)');
    expect(config.providers?.agy?.modelMapping?.premium).toBe('Claude Opus 4.6 (Thinking)');
    expect(config.providers?.claude?.modelMapping?.cheap).toBe('claude-haiku-4-5');
  });

  it('returns empty config for malformed JSON and logs warning', () => {
    fs.writeFileSync(CONFIG_PATH, '{ bad json !!!', 'utf-8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = loadUserConfig();
    expect(config).toEqual({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('user config malformed'));
    spy.mockRestore();
  });

  it('returns empty config for non-object JSON (array)', () => {
    fs.writeFileSync(CONFIG_PATH, '[1,2,3]', 'utf-8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = loadUserConfig();
    expect(config).toEqual({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('user config malformed'));
    spy.mockRestore();
  });

  it('warns on unknown provider keys but accepts valid ones', () => {
    const data = {
      providers: {
        agy: { modelMapping: { cheap: 'Model A' } },
        bogus: { modelMapping: { cheap: 'Model B' } },
      },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data), 'utf-8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = loadUserConfig();
    expect(config.providers?.agy?.modelMapping?.cheap).toBe('Model A');
    expect((config.providers as any)?.bogus).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown provider "bogus"'));
    spy.mockRestore();
  });

  it('warns on unknown tier keys but accepts valid ones', () => {
    const data = {
      providers: {
        claude: { modelMapping: { cheap: 'haiku', ultra: 'opus' } },
      },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data), 'utf-8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = loadUserConfig();
    expect(config.providers?.claude?.modelMapping?.cheap).toBe('haiku');
    expect((config.providers?.claude?.modelMapping as any)?.ultra).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown tier "ultra"'));
    spy.mockRestore();
  });

  it('caches the result across calls', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ providers: { agy: { modelMapping: { cheap: 'X' } } } }), 'utf-8');

    const first = loadUserConfig();
    // Overwrite file -- cache should still return old value
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ providers: { agy: { modelMapping: { cheap: 'Y' } } } }), 'utf-8');
    const second = loadUserConfig();

    expect(first).toBe(second); // same object reference
    expect(second.providers?.agy?.modelMapping?.cheap).toBe('X');
  });
});

describe('getModelOverride', () => {
  beforeEach(() => {
    _resetCache();
    if (!fs.existsSync(FLEET_DIR)) {
      fs.mkdirSync(FLEET_DIR, { recursive: true });
    }
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  afterEach(() => {
    _resetCache();
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  it('returns undefined when no config file exists', () => {
    expect(getModelOverride('agy', 'cheap')).toBeUndefined();
  });

  it('returns override when config has a mapping for the provider/tier', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      providers: { agy: { modelMapping: { premium: 'Custom Premium' } } },
    }), 'utf-8');

    expect(getModelOverride('agy', 'premium')).toBe('Custom Premium');
    expect(getModelOverride('agy', 'cheap')).toBeUndefined();
    expect(getModelOverride('claude', 'premium')).toBeUndefined();
  });
});

describe('getLogPreviewChars', () => {
  beforeEach(() => {
    _resetCache();
    if (!fs.existsSync(FLEET_DIR)) fs.mkdirSync(FLEET_DIR, { recursive: true });
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  afterEach(() => {
    _resetCache();
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  it('returns the default when no config file exists', () => {
    expect(getLogPreviewChars()).toBe(DEFAULT_LOG_PREVIEW_CHARS);
  });

  it('returns the configured previewChars', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ logging: { previewChars: 512 } }), 'utf-8');
    expect(getLogPreviewChars()).toBe(512);
  });

  it('accepts 0 (no preview) as a valid override', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ logging: { previewChars: 0 } }), 'utf-8');
    expect(getLogPreviewChars()).toBe(0);
  });

  it('floors a fractional previewChars', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ logging: { previewChars: 100.9 } }), 'utf-8');
    expect(getLogPreviewChars()).toBe(100);
  });

  it('ignores a negative or non-numeric previewChars and warns', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ logging: { previewChars: -5 } }), 'utf-8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getLogPreviewChars()).toBe(DEFAULT_LOG_PREVIEW_CHARS);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('logging.previewChars'));
    spy.mockRestore();
  });

  it('ignores a non-numeric previewChars', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ logging: { previewChars: 'lots' } }), 'utf-8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getLogPreviewChars()).toBe(DEFAULT_LOG_PREVIEW_CHARS);
    spy.mockRestore();
  });
});

describe('agy provider uses user-config for display name', () => {
  beforeEach(() => {
    _resetCache();
    if (!fs.existsSync(FLEET_DIR)) {
      fs.mkdirSync(FLEET_DIR, { recursive: true });
    }
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  afterEach(() => {
    _resetCache();
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  it('uses hardcoded default when no user config exists', async () => {
    const { AgyProvider } = await import('../src/providers/agy.js');
    const p = new AgyProvider();
    const cmd = p.buildPromptCommand({
      folder: '/home/user/project',
      promptFile: '.fleet-task.md',
      tier: 'cheap',
    });
    // Default cheap display name
    expect(cmd).toContain('Gemini 3.5 Flash (Medium)');
  });

  it('uses user-config override when config is present', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      providers: { agy: { modelMapping: { cheap: 'Custom Cheap Model' } } },
    }), 'utf-8');

    const { AgyProvider } = await import('../src/providers/agy.js');
    const p = new AgyProvider();
    const cmd = p.buildPromptCommand({
      folder: '/home/user/project',
      promptFile: '.fleet-task.md',
      tier: 'cheap',
    });
    expect(cmd).toContain('Custom Cheap Model');
    expect(cmd).not.toContain('Gemini 3.5 Flash (Medium)');
  });

  it('falls back to hardcoded default for tiers not in user config', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      providers: { agy: { modelMapping: { premium: 'Custom Premium' } } },
    }), 'utf-8');

    const { AgyProvider } = await import('../src/providers/agy.js');
    const p = new AgyProvider();
    const cmd = p.buildPromptCommand({
      folder: '/home/user/project',
      promptFile: '.fleet-task.md',
      tier: 'standard',
    });
    // standard not overridden -- should use hardcoded default
    expect(cmd).toContain('Gemini 3.1 Pro (Low)');
  });
});
