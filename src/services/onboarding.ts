import fs from 'node:fs';
import path from 'node:path';
import type { OnboardingState } from '../types.js';
import { FLEET_DIR } from '../paths.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';
import { BANNER, GETTING_STARTED_GUIDE, WELCOME_BACK, NUDGE_AFTER_FIRST_REGISTER, NUDGE_AFTER_FIRST_PROMPT, NUDGE_AFTER_MULTI_MEMBER } from '../onboarding/text.js';
import { getAllAgents } from './registry.js';

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
 * Returns true if the tool response is JSON-formatted (starts with `{` or `[`).
 * Used by wrapTool to skip prepending onboarding text to structured data responses.
 * Covers: fleet_status, list_members, member_detail, monitor_task.
 */
export function isJsonResponse(result: string): boolean {
  return result.startsWith('{') || result.startsWith('[');
}

/**
 * Returns the first-run banner + getting started guide if this is the first tool
 * call after a fresh install. Marks bannerShown and persists immediately so a
 * server crash won't re-show the banner.
 * Returns null if the banner has already been shown.
 */
export function getFirstRunPreamble(): string | null {
  const state = getOnboardingState();
  if (state.bannerShown) return null;
  advanceMilestone('bannerShown');
  return BANNER + '\n' + GETTING_STARTED_GUIDE;
}

/**
 * Post-tool contextual nudge. Called by wrapTool after every tool invocation.
 * Uses input.member_type directly — no response string parsing for type.
 * Each nudge fires at most once (milestone flag prevents repeat).
 */
export function getOnboardingNudge(toolName: string, input: any, result: string): string | null {
  if (toolName === 'register_member' && result.startsWith('✅')) {
    if (shouldShow('firstMemberRegistered')) {
      advanceMilestone('firstMemberRegistered');
      return NUDGE_AFTER_FIRST_REGISTER(input.member_type as string);
    }
    if (shouldShow('multiMemberNudgeShown')) {
      const agents = getAllAgents();
      if (agents.length >= 2) {
        advanceMilestone('multiMemberNudgeShown');
        return NUDGE_AFTER_MULTI_MEMBER();
      }
    }
  }
  if (toolName === 'execute_prompt' && result.startsWith('📋')) {
    if (shouldShow('firstPromptExecuted')) {
      advanceMilestone('firstPromptExecuted');
      return NUDGE_AFTER_FIRST_PROMPT();
    }
  }
  return null;
}

function formatLastActive(agents: { lastUsed?: string }[]): string {
  const times = agents
    .map(a => a.lastUsed)
    .filter((t): t is string => Boolean(t))
    .map(t => new Date(t).getTime())
    .filter(t => !isNaN(t)); // guard against malformed date strings
  if (times.length === 0) return 'unknown';
  const diff = Date.now() - Math.max(...times);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Welcome-back preamble for non-first-run server starts.
 * Shown once per server lifecycle (session flag prevents repeat).
 * Returns null if this is the first run (banner not yet shown) or already shown this session.
 */
export function getWelcomeBackPreamble(): string | null {
  const state = getOnboardingState();
  if (!state.bannerShown) return null; // first run — banner will handle it
  if (welcomeBackShownThisSession) return null;
  markWelcomeBackShown();
  const agents = getAllAgents();
  const lastActive = formatLastActive(agents);
  return WELCOME_BACK(agents.length, 0, lastActive);
}

/**
 * Reset module state — used in tests only.
 */
export function _resetForTest(): void {
  _state = null;
  welcomeBackShownThisSession = false;
}
