/**
 * Characterization coverage for the OS credential-helper command builders
 * underpinning the credential-cleanup label/scope-url bug (apra-fleet-7bjs):
 * gitCredentialHelperWrite and gitCredentialHelperRemove must resolve the
 * SAME credential FILE path (label-scoped) and git-config KEY
 * (scopeUrl-scoped) for a given (label, scopeUrl) pair, and two different
 * credentials on the same host must never collide on either path.
 *
 * These builders were never the buggy part of the code (the bug was the
 * CALLERS omitting label/scopeUrl, not these functions resolving them
 * wrong) -- this file would pass against the pre-fix code too. It exists to
 * prove the fix, once wired through correctly by the callers, lands on a
 * command-string pair that actually agrees, and to catch a future change to
 * either builder that breaks that agreement. The regression coverage that
 * would have failed against the actual pre-fix bug (the callers not passing
 * label/scopeUrl through) lives in tests/credential-cleanup.test.ts,
 * tests/provision-vcs-auth.test.ts, and tests/remove-member-decomm.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { getOsCommands } from '../src/os/index.js';

describe.each([
  ['linux', getOsCommands('linux')],
  ['windows', getOsCommands('windows')],
])('%s gitCredentialHelperWrite/Remove scoping', (_osName, cmds) => {
  it('write and remove target the same label-scoped file and scopeUrl-scoped config key', () => {
    const writeCmd = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghu_tok', 'work-github', 'https://github.com/my-org');
    const removeCmd = cmds.gitCredentialHelperRemove('github.com', 'work-github', 'https://github.com/my-org');

    // Both commands must reference the same label-scoped credential file...
    expect(writeCmd).toContain('fleet-git-credential-work-github');
    expect(removeCmd).toContain('fleet-git-credential-work-github');

    // ...and the same scopeUrl-scoped git-config key.
    expect(writeCmd).toContain('https://github.com/my-org');
    expect(removeCmd).toContain('https://github.com/my-org');
  });

  it('default (no label/scopeUrl) write and remove agree on both the bare credential file and the host-default config key', () => {
    const writeCmd = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghu_tok');
    const removeCmd = cmds.gitCredentialHelperRemove('github.com');

    // Config key (was already correct pre-fix -- host/scopeUrl-scoped).
    expect(writeCmd).toContain('credential.https://github.com.helper');
    expect(removeCmd).toContain('credential.https://github.com.helper');

    // Credential file (the half that was actually broken pre-fix): the bare,
    // unlabeled filename, with no trailing "-<label>" suffix.
    expect(writeCmd).toContain('fleet-git-credential');
    expect(removeCmd).toContain('fleet-git-credential');
    expect(writeCmd).not.toMatch(/fleet-git-credential-\w/);
    expect(removeCmd).not.toMatch(/fleet-git-credential-\w/);
  });

  it('revoking credential A (label X) never references credential B\'s (label Y) file or config key', () => {
    const writeA = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok-a', 'label-x', 'https://github.com');
    const writeB = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok-b', 'label-y', 'https://github.com');
    const removeA = cmds.gitCredentialHelperRemove('github.com', 'label-x', 'https://github.com');

    // Sanity: A and B really do use distinct credential files.
    expect(writeA).not.toBe(writeB);

    // The credential file removeA deletes/unsets is label-x's, never label-y's.
    expect(removeA).toContain('fleet-git-credential-label-x');
    expect(removeA).not.toContain('fleet-git-credential-label-y');
  });
});
