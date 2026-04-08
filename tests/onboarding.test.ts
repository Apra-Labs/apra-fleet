import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use a fresh temp dir per test run — setup.ts sets APRA_FLEET_DATA_DIR
const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.tmpdir(), 'apra-fleet-test-data');
const ONBOARDING_PATH = path.join(FLEET_DIR, 'onboarding.json');

function ensureFleetDir() {
  if (!fs.existsSync(FLEET_DIR)) fs.mkdirSync(FLEET_DIR, { recursive: true });
}

function removeOnboardingFile() {
  if (fs.existsSync(ONBOARDING_PATH)) fs.rmSync(ONBOARDING_PATH);
}

beforeEach(async () => {
  ensureFleetDir();
  removeOnboardingFile();
  // Reset module state between tests
  const mod = await import('../src/services/onboarding.js');
  mod._resetForTest();
});

afterEach(() => {
  removeOnboardingFile();
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
