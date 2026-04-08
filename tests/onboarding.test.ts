import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use a fresh temp dir per test run — setup.ts sets APRA_FLEET_DATA_DIR
const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.tmpdir(), 'apra-fleet-test-data');
const ONBOARDING_PATH = path.join(FLEET_DIR, 'onboarding.json');
const REGISTRY_PATH = path.join(FLEET_DIR, 'registry.json');

function ensureFleetDir() {
  if (!fs.existsSync(FLEET_DIR)) fs.mkdirSync(FLEET_DIR, { recursive: true });
}

function removeOnboardingFile() {
  if (fs.existsSync(ONBOARDING_PATH)) fs.rmSync(ONBOARDING_PATH);
}

function removeRegistryFile() {
  if (fs.existsSync(REGISTRY_PATH)) fs.rmSync(REGISTRY_PATH);
}

function writeRegistry(agents: object[]) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: '1.0', agents }), { mode: 0o600 });
}

beforeEach(async () => {
  ensureFleetDir();
  removeOnboardingFile();
  removeRegistryFile();
  // Reset module state between tests
  const mod = await import('../src/services/onboarding.js');
  mod._resetForTest();
});

afterEach(() => {
  removeOnboardingFile();
  removeRegistryFile();
});

describe('loadOnboardingState', () => {
  it('returns default state when file is missing', async () => {
    const { loadOnboardingState } = await import('../src/services/onboarding.js');
    const state = loadOnboardingState();
    expect(state.bannerShown).toBe(false);
    expect(state.firstMemberRegistered).toBe(false);
    expect(state.firstPromptExecuted).toBe(false);
    expect(state.multiMemberNudgeShown).toBe(false);
  });

  it('does not create file on load (only on write)', async () => {
    const { loadOnboardingState } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    expect(fs.existsSync(ONBOARDING_PATH)).toBe(false);
  });

  it('pre-sets bannerShown=true when existing members exist (upgrade path)', async () => {
    const { loadOnboardingState } = await import('../src/services/onboarding.js');
    const state = loadOnboardingState(3); // 3 existing members
    expect(state.bannerShown).toBe(true);
  });

  it('loads persisted state from disk', async () => {
    ensureFleetDir();
    const saved = { bannerShown: true, firstMemberRegistered: true, firstPromptExecuted: false, multiMemberNudgeShown: false };
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify(saved), { mode: 0o600 });

    const { loadOnboardingState, _resetForTest } = await import('../src/services/onboarding.js');
    _resetForTest();
    const state = loadOnboardingState();
    expect(state.bannerShown).toBe(true);
    expect(state.firstMemberRegistered).toBe(true);
    expect(state.firstPromptExecuted).toBe(false);
  });

  it('treats corrupted JSON as default state and does not throw', async () => {
    ensureFleetDir();
    fs.writeFileSync(ONBOARDING_PATH, 'not-valid-json{{{', { mode: 0o600 });

    const { loadOnboardingState, _resetForTest } = await import('../src/services/onboarding.js');
    _resetForTest();
    const state = loadOnboardingState();
    expect(state.bannerShown).toBe(false);
    expect(state.firstMemberRegistered).toBe(false);
  });

  it('merges missing fields with defaults (forward-compatibility)', async () => {
    ensureFleetDir();
    // File written by older version only has some fields
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ bannerShown: true }), { mode: 0o600 });

    const { loadOnboardingState, _resetForTest } = await import('../src/services/onboarding.js');
    _resetForTest();
    const state = loadOnboardingState();
    expect(state.bannerShown).toBe(true);
    expect(state.firstMemberRegistered).toBe(false); // defaulted
    expect(state.multiMemberNudgeShown).toBe(false);  // defaulted
  });
});

describe('saveOnboardingState', () => {
  it('persists in-memory state to disk atomically', async () => {
    const { loadOnboardingState, advanceMilestone, _resetForTest } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    advanceMilestone('bannerShown');

    // File should now exist with bannerShown=true
    expect(fs.existsSync(ONBOARDING_PATH)).toBe(true);
    const ondisk = JSON.parse(fs.readFileSync(ONBOARDING_PATH, 'utf-8'));
    expect(ondisk.bannerShown).toBe(true);

    // Reload and verify persistence
    _resetForTest();
    const reloaded = loadOnboardingState();
    expect(reloaded.bannerShown).toBe(true);
  });

  it('leaves no temp file behind after atomic write', async () => {
    const { loadOnboardingState, saveOnboardingState } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    saveOnboardingState();

    const tmp = ONBOARDING_PATH + '.tmp';
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(ONBOARDING_PATH)).toBe(true);
  });

  it('writes onboarding.json with 0o600 permissions (owner-only)', async () => {
    const { loadOnboardingState, saveOnboardingState } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    saveOnboardingState();

    const stat = fs.statSync(ONBOARDING_PATH);
    // Mask to lower 9 permission bits
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});

describe('advanceMilestone', () => {
  it('advances a single milestone and persists', async () => {
    const { loadOnboardingState, advanceMilestone, shouldShow } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    expect(shouldShow('firstMemberRegistered')).toBe(true);
    advanceMilestone('firstMemberRegistered');
    expect(shouldShow('firstMemberRegistered')).toBe(false);

    const ondisk = JSON.parse(fs.readFileSync(ONBOARDING_PATH, 'utf-8'));
    expect(ondisk.firstMemberRegistered).toBe(true);
  });

  it('is idempotent — calling twice does not change state', async () => {
    const { loadOnboardingState, advanceMilestone, getOnboardingState } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    advanceMilestone('bannerShown');
    advanceMilestone('bannerShown'); // second call should be no-op
    expect(getOnboardingState().bannerShown).toBe(true);
  });

  it('advances all milestones independently', async () => {
    const { loadOnboardingState, advanceMilestone, shouldShow } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    advanceMilestone('bannerShown');
    advanceMilestone('firstPromptExecuted');

    expect(shouldShow('bannerShown')).toBe(false);
    expect(shouldShow('firstPromptExecuted')).toBe(false);
    expect(shouldShow('firstMemberRegistered')).toBe(true);  // not advanced
    expect(shouldShow('multiMemberNudgeShown')).toBe(true);   // not advanced
  });
});

describe('shouldShow', () => {
  it('returns true for unset milestones', async () => {
    const { loadOnboardingState, shouldShow } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    expect(shouldShow('bannerShown')).toBe(true);
  });

  it('returns false for set milestones', async () => {
    const { loadOnboardingState, advanceMilestone, shouldShow } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    advanceMilestone('bannerShown');
    expect(shouldShow('bannerShown')).toBe(false);
  });
});

describe('isJsonResponse', () => {
  it('returns true for object JSON', async () => {
    const { isJsonResponse } = await import('../src/services/onboarding.js');
    expect(isJsonResponse('{"members":[]}')).toBe(true);
    expect(isJsonResponse('{ "foo": 1 }')).toBe(true);
  });

  it('returns true for array JSON', async () => {
    const { isJsonResponse } = await import('../src/services/onboarding.js');
    expect(isJsonResponse('[1,2,3]')).toBe(true);
    expect(isJsonResponse('[ ]')).toBe(true);
  });

  it('returns false for non-JSON responses', async () => {
    const { isJsonResponse } = await import('../src/services/onboarding.js');
    expect(isJsonResponse('✅ Member registered.')).toBe(false);
    expect(isJsonResponse('❌ Error: member not found')).toBe(false);
    expect(isJsonResponse('Fleet ready.')).toBe(false);
    expect(isJsonResponse('')).toBe(false);
  });
});

describe('getFirstRunPreamble', () => {
  it('returns banner + guide on fresh install (first call)', async () => {
    const { loadOnboardingState, getFirstRunPreamble } = await import('../src/services/onboarding.js');
    loadOnboardingState(); // fresh state — bannerShown = false

    const result = getFirstRunPreamble();
    expect(result).not.toBeNull();
    expect(result).toContain('One model is a tool'); // tagline in ASCII art banner
    expect(result).toContain('Getting Started');      // guide header
  });

  it('returns null on second call (banner already shown)', async () => {
    const { loadOnboardingState, getFirstRunPreamble } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    getFirstRunPreamble(); // first call shows banner
    const second = getFirstRunPreamble(); // second call must return null
    expect(second).toBeNull();
  });

  it('persists bannerShown so server crash cannot re-show banner', async () => {
    const { loadOnboardingState, getFirstRunPreamble, _resetForTest } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    getFirstRunPreamble(); // marks bannerShown = true and writes to disk

    // Simulate server restart
    _resetForTest();
    loadOnboardingState(); // reloads from disk

    const result = getFirstRunPreamble();
    expect(result).toBeNull(); // must not show banner again
  });

  it('returns null when state is loaded with bannerShown=true (upgrade/existing user)', async () => {
    const { loadOnboardingState, getFirstRunPreamble } = await import('../src/services/onboarding.js');
    loadOnboardingState(3); // 3 existing members → upgrade path → bannerShown=true

    const result = getFirstRunPreamble();
    expect(result).toBeNull();
  });
});

describe('session flags', () => {
  it('welcomeBackShownThisSession starts false', async () => {
    const mod = await import('../src/services/onboarding.js');
    mod._resetForTest();
    expect(mod.welcomeBackShownThisSession).toBe(false);
  });

  it('markWelcomeBackShown sets the flag', async () => {
    const mod = await import('../src/services/onboarding.js');
    mod._resetForTest();
    mod.markWelcomeBackShown();
    expect(mod.welcomeBackShownThisSession).toBe(true);
  });

  it('resetSessionFlags clears the flag', async () => {
    const mod = await import('../src/services/onboarding.js');
    mod.markWelcomeBackShown();
    mod.resetSessionFlags();
    expect(mod.welcomeBackShownThisSession).toBe(false);
  });
});

describe('getOnboardingNudge', () => {
  it('shows NUDGE_AFTER_FIRST_REGISTER(local) on first register_member success', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    writeRegistry([{ id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString() }]);

    const result = getOnboardingNudge('register_member', { member_type: 'local' }, '✅ Member registered.');
    expect(result).not.toBeNull();
    expect(result).toContain('execute_prompt');
  });

  it('shows NUDGE_AFTER_FIRST_REGISTER(remote) with SSH key tip', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    writeRegistry([{ id: '1', friendlyName: 'alpha', agentType: 'remote', workFolder: '/tmp/a', createdAt: new Date().toISOString() }]);

    const result = getOnboardingNudge('register_member', { member_type: 'remote' }, '✅ Member registered.');
    expect(result).not.toBeNull();
    expect(result).toContain('setup_ssh_key');
  });

  it('does not show first-register nudge on second registration', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();
    writeRegistry([{ id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString() }]);

    getOnboardingNudge('register_member', { member_type: 'local' }, '✅ Member registered.'); // first — consumes milestone
    const second = getOnboardingNudge('register_member', { member_type: 'local' }, '✅ Member registered.');
    // second call: firstMemberRegistered is set, multiMemberNudgeShown not set but only 1 agent → null
    expect(second).toBeNull();
  });

  it('shows NUDGE_AFTER_MULTI_MEMBER when registry reaches 2+ members', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    // First registration — only 1 agent in registry
    writeRegistry([{ id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString() }]);
    getOnboardingNudge('register_member', { member_type: 'local' }, '✅ Member registered.'); // advances firstMemberRegistered

    // Second registration — now 2 agents in registry
    writeRegistry([
      { id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString() },
      { id: '2', friendlyName: 'beta', agentType: 'remote', workFolder: '/tmp/b', createdAt: new Date().toISOString() },
    ]);
    const result = getOnboardingNudge('register_member', { member_type: 'remote' }, '✅ Member registered.');
    expect(result).not.toBeNull();
    expect(result).toContain('PM skill');
  });

  it('does not show multi-member nudge a second time', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    writeRegistry([{ id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString() }]);
    getOnboardingNudge('register_member', { member_type: 'local' }, '✅ Member registered.');

    writeRegistry([
      { id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString() },
      { id: '2', friendlyName: 'beta', agentType: 'remote', workFolder: '/tmp/b', createdAt: new Date().toISOString() },
    ]);
    getOnboardingNudge('register_member', { member_type: 'remote' }, '✅ Member registered.'); // consumes multiMemberNudgeShown

    const third = getOnboardingNudge('register_member', { member_type: 'local' }, '✅ Member registered.');
    expect(third).toBeNull();
  });

  it('shows NUDGE_AFTER_FIRST_PROMPT on first execute_prompt success', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    const result = getOnboardingNudge('execute_prompt', {}, '📋 Task submitted.');
    expect(result).not.toBeNull();
    expect(result).toContain('fleet_status');
  });

  it('does not show prompt nudge on second execute_prompt', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    getOnboardingNudge('execute_prompt', {}, '📋 Task submitted.');
    const second = getOnboardingNudge('execute_prompt', {}, '📋 Task submitted.');
    expect(second).toBeNull();
  });

  it('ignores non-success register_member results', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    const result = getOnboardingNudge('register_member', { member_type: 'local' }, '❌ Member already exists.');
    expect(result).toBeNull();
  });

  it('returns null for unrelated tool names', async () => {
    const { loadOnboardingState, getOnboardingNudge } = await import('../src/services/onboarding.js');
    loadOnboardingState();

    const result = getOnboardingNudge('fleet_status', {}, 'some output');
    expect(result).toBeNull();
  });
});

describe('getWelcomeBackPreamble', () => {
  it('returns null on first run (bannerShown=false)', async () => {
    const { loadOnboardingState, getWelcomeBackPreamble } = await import('../src/services/onboarding.js');
    loadOnboardingState(); // fresh — bannerShown=false

    expect(getWelcomeBackPreamble()).toBeNull();
  });

  it('shows welcome-back on first call after banner already shown', async () => {
    const { loadOnboardingState, getWelcomeBackPreamble } = await import('../src/services/onboarding.js');
    // Simulate existing user: bannerShown=true
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ bannerShown: true, firstMemberRegistered: false, firstPromptExecuted: false, multiMemberNudgeShown: false }), { mode: 0o600 });
    loadOnboardingState();

    const result = getWelcomeBackPreamble();
    expect(result).not.toBeNull();
    expect(result).toContain('Fleet');
  });

  it('returns null on second call (already shown this session)', async () => {
    const { loadOnboardingState, getWelcomeBackPreamble } = await import('../src/services/onboarding.js');
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ bannerShown: true, firstMemberRegistered: false, firstPromptExecuted: false, multiMemberNudgeShown: false }), { mode: 0o600 });
    loadOnboardingState();

    getWelcomeBackPreamble(); // first call
    const second = getWelcomeBackPreamble(); // second call
    expect(second).toBeNull();
  });

  it('shows fallback "Fleet ready." message when no agents registered', async () => {
    const { loadOnboardingState, getWelcomeBackPreamble } = await import('../src/services/onboarding.js');
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ bannerShown: true, firstMemberRegistered: false, firstPromptExecuted: false, multiMemberNudgeShown: false }), { mode: 0o600 });
    loadOnboardingState();
    // no registry file → getAllAgents() returns empty

    const result = getWelcomeBackPreamble();
    expect(result).not.toBeNull();
    expect(result).toContain('Fleet ready');
  });

  it('shows member count and lastActive when agents are registered', async () => {
    const { loadOnboardingState, getWelcomeBackPreamble } = await import('../src/services/onboarding.js');
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ bannerShown: true, firstMemberRegistered: true, firstPromptExecuted: false, multiMemberNudgeShown: false }), { mode: 0o600 });
    loadOnboardingState();

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeRegistry([
      { id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString(), lastUsed: twoHoursAgo },
    ]);

    const result = getWelcomeBackPreamble();
    expect(result).not.toBeNull();
    expect(result).toContain('1 member');
    expect(result).toContain('2h ago');
  });

  it('shows "unknown" lastActive when agent has a malformed lastUsed (NaN guard)', async () => {
    const { loadOnboardingState, getWelcomeBackPreamble, _resetForTest } = await import('../src/services/onboarding.js');
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ bannerShown: true, firstMemberRegistered: true, firstPromptExecuted: false, multiMemberNudgeShown: false }), { mode: 0o600 });
    _resetForTest();
    loadOnboardingState();

    writeRegistry([
      { id: '1', friendlyName: 'alpha', agentType: 'local', workFolder: '/tmp/a', createdAt: new Date().toISOString(), lastUsed: 'not-a-date' },
    ]);

    const result = getWelcomeBackPreamble();
    expect(result).not.toBeNull();
    expect(result).not.toContain('NaN');
    expect(result).toContain('unknown');
  });
});
