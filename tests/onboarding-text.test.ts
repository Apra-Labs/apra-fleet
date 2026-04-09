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
  it('covers adding a member', () => {
    expect(GETTING_STARTED_GUIDE).toContain('Add your first member');
  });

  it('covers giving it work with natural language examples', () => {
    expect(GETTING_STARTED_GUIDE).toContain('Ask my-server to run the test suite');
    expect(GETTING_STARTED_GUIDE).toContain('Send the src/ folder to my-server and run the build');
  });

  it('covers checking status', () => {
    expect(GETTING_STARTED_GUIDE).toContain('Show fleet status');
  });

  it('does not include the /pm step', () => {
    expect(GETTING_STARTED_GUIDE).not.toContain('/pm init');
  });
});

describe('WELCOME_BACK', () => {
  it('shows member count and last active time', () => {
    const msg = WELCOME_BACK(3, '2h ago');
    expect(msg).toContain('3 member');
    expect(msg).toContain('2h ago');
    expect(msg).not.toContain('online');
  });

  it('uses singular "member" for count of 1', () => {
    const msg = WELCOME_BACK(1, '5m ago');
    expect(msg).toContain('1 member');
    expect(msg).not.toContain('1 members');
  });

  it('shows fallback message when fleet has no members', () => {
    const msg = WELCOME_BACK(0, 'unknown');
    expect(msg).toContain('Fleet ready');
  });
});

describe('NUDGE_AFTER_FIRST_REGISTER', () => {
  it('suggests SSH key setup for remote members', () => {
    const msg = NUDGE_AFTER_FIRST_REGISTER('remote');
    expect(msg).toContain('key-based auth');
    expect(msg).toContain('🔑');
  });

  it('suggests giving work to local members using default name', () => {
    const msg = NUDGE_AFTER_FIRST_REGISTER('local');
    expect(msg).toContain('my-server');
    expect(msg).toContain('🚀');
  });

  it('uses the actual member name when provided', () => {
    const msg = NUDGE_AFTER_FIRST_REGISTER('local', 'build-box');
    expect(msg).toContain('build-box');
    expect(msg).not.toContain('my-server');
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
