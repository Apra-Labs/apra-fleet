import fs from 'node:fs';
import path from 'node:path';
import type { OnboardingState } from '../types.js';
import { FLEET_DIR } from '../paths.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';

const ONBOARDING_PATH = path.join(FLEET_DIR, 'onboarding.json');

const DEFAULT_STATE: OnboardingState = {
  bannerShown: false,
  firstMemberRegistered: false,
  firstPromptExecuted: false,
  multiMemberNudgeShown: false,
};

// In-memory singleton — loaded once at server start.
// All reads use this copy; JS event loop serializes access (no concurrent-read races).
let _state: OnboardingState | null = null;

// Runtime-only flag — not persisted to disk.
export let welcomeBackShownThisSession = false;

function ensureFleetDir(): void {
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load onboarding state from disk into the in-memory singleton.
 * Call once at server startup. Missing file = fresh install (all false).
 * If the registry already has members but no onboarding file, this is an
 * upgrade: pre-set bannerShown=true so existing users don't see the banner.
 */
export function loadOnboardingState(existingMemberCount = 0): OnboardingState {
  ensureFleetDir();

  if (!fs.existsSync(ONBOARDING_PATH)) {
    const state: OnboardingState = { ...DEFAULT_STATE };
    if (existingMemberCount > 0) {
      // Upgrade path: existing registry, no onboarding file → skip banner
      state.bannerShown = true;
    }
    _state = state;
    return _state;
  }

  try {
    const raw = fs.readFileSync(ONBOARDING_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    // Merge with defaults so new fields added in future upgrades get falsy defaults
    _state = { ...DEFAULT_STATE, ...parsed };
  } catch {
    // Corrupted file → treat as fresh install, log warning
    process.stderr.write('[apra-fleet] Warning: onboarding.json is corrupted; resetting to defaults.\n');
    _state = { ...DEFAULT_STATE };
  }

  return _state;
}

/**
 * Persist the current in-memory state to disk atomically (temp write + rename).
 */
export function saveOnboardingState(): void {
  if (_state === null) return;
  ensureFleetDir();

  const tmp = ONBOARDING_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_state, null, 2), { mode: 0o600 });
  enforceOwnerOnly(tmp);
  fs.renameSync(tmp, ONBOARDING_PATH);
  enforceOwnerOnly(ONBOARDING_PATH);
}

/**
 * Get the current in-memory state. Loads from disk if not yet loaded (fallback for tests).
 */
export function getOnboardingState(): OnboardingState {
  if (_state === null) loadOnboardingState();
  return _state!;
}

/**
 * Returns true if the milestone has NOT yet been shown (i.e., it should be shown now).
 */
export function shouldShow(key: keyof OnboardingState): boolean {
  return !getOnboardingState()[key];
}

/**
 * Mark a milestone as reached. Updates in-memory state and persists to disk immediately.
 */
export function advanceMilestone(key: keyof OnboardingState): void {
  const state = getOnboardingState();
  if (state[key]) return; // Already advanced — no-op
  state[key] = true;
  saveOnboardingState();
}

/**
 * Reset session-level runtime flags. Call at server startup after loadOnboardingState().
 */
export function resetSessionFlags(): void {
  welcomeBackShownThisSession = false;
}

/**
 * Mark welcome-back as shown for this server session.
 */
export function markWelcomeBackShown(): void {
  welcomeBackShownThisSession = true;
}

/**
 * Reset module state — used in tests only.
 */
export function _resetForTest(): void {
  _state = null;
  welcomeBackShownThisSession = false;
}
