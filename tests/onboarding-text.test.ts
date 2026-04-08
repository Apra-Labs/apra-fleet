import { describe, it, expect } from 'vitest';
import {
  BANNER,
  GETTING_STARTED_GUIDE,
  WELCOME_BACK,
  NUDGE_AFTER_FIRST_REGISTER,
  NUDGE_AFTER_FIRST_PROMPT,
  NUDGE_AFTER_MULTI_MEMBER,
} from '../src/onboarding/text.js';

describe('BANNER', () => {
  it('contains the ASCII art header line', () => {
    expect(BANNER).toContain('█████╗ ██████╗ ██████╗');
  });

  it('contains the tagline', () => {
    expect(BANNER).toContain('One model is a tool. A fleet is a team.');
  });

  it('contains the separator lines', () => {
    expect(BANNER).toContain('────────────────────────────────────────────────────────────────────────────────');
  });
});

describe('GETTING_STARTED_GUIDE', () => {
  it('mentions register_member', () => {
    expect(GETTING_STARTED_GUIDE).toContain('register_member');
  });

  it('mentions execute_prompt', () => {
    expect(GETTING_STARTED_GUIDE).toContain('execute_prompt');
  });

  it('mentions fleet_status', () => {
    expect(GETTING_STARTED_GUIDE).toContain('fleet_status');
  });

  it('mentions PM skill commands', () => {
    expect(GETTING_STARTED_GUIDE).toContain('/pm init');
    expect(GETTING_STARTED_GUIDE).toContain('/pm pair');
    expect(GETTING_STARTED_GUIDE).toContain('/pm plan');
  });
});

describe('WELCOME_BACK', () => {
  it('shows member count and online count', () => {
    const msg = WELCOME_BACK(3, 2, '2h ago');
    expect(msg).toContain('3 member');
    expect(msg).toContain('2 online');
    expect(msg).toContain('2h ago');
  });

  it('uses singular "member" for count of 1', () => {
    const msg = WELCOME_BACK(1, 1, '5m ago');
    expect(msg).toContain('1 member,');
    expect(msg).not.toContain('1 members');
  });

  it('shows fallback message when fleet has no members', () => {
    const msg = WELCOME_BACK(0, 0, 'unknown');
    expect(msg).toContain('Fleet ready');
  });
});

describe('NUDGE_AFTER_FIRST_REGISTER', () => {
  it('suggests SSH key setup for remote members', () => {
    const msg = NUDGE_AFTER_FIRST_REGISTER('remote');
    expect(msg).toContain('setup_ssh_key');
    expect(msg).toContain('🔑');
  });

  it('suggests running a prompt for local members', () => {
    const msg = NUDGE_AFTER_FIRST_REGISTER('local');
    expect(msg).toContain('execute_prompt');
    expect(msg).toContain('🚀');
  });
});

describe('NUDGE_AFTER_FIRST_PROMPT', () => {
  it('mentions fleet_status', () => {
    const msg = NUDGE_AFTER_FIRST_PROMPT();
    expect(msg).toContain('fleet_status');
  });
});

describe('NUDGE_AFTER_MULTI_MEMBER', () => {
  it('mentions PM skill commands', () => {
    const msg = NUDGE_AFTER_MULTI_MEMBER();
    expect(msg).toContain('/pm init');
    expect(msg).toContain('/pm pair');
    expect(msg).toContain('/pm plan');
  });
});
