// fleet-sprint's member-side credential-helper readers resolve a
// member-scoped helper (member_detail vcsCredentials[].memberScoped) to the
// member's own file `.fleet-git-credential-<label>.<member id>` on all three
// helper shapes, and keep the shared legacy path when no member id is given.
// String-level only: nothing is spawned.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import { buildCredentialReadCommand } from '../fleet-sprint/runner.js';

const MEMBER_ID = '3f2c9a10-1111-4222-8333-944455556666';

const shapes = [
    ['linux', { os: 'linux', shell: '' }, `$HOME/.fleet-git-credential-github.${MEMBER_ID}`],
    ['windows-powershell', { os: 'windows', shell: 'powershell5' }, `$env:USERPROFILE\\.fleet-git-credential-github.${MEMBER_ID}.bat`],
    ['windows-gitbash', { os: 'windows', shell: 'gitbash' }, `$HOME/.fleet-git-credential-github.${MEMBER_ID}.bat`],
];

describe('fleet-sprint credential-helper readers: member-scoped path', () => {
    for (const [name, target, expected] of shapes) {
        test(`${name}: helper path, username read and credential read use the member's own file`, () => {
            const se = getSeCommands(target);
            assert.equal(se.credentialHelperPath('github', MEMBER_ID), expected);
            assert.equal(se.readCredentialHelperUsername('github', MEMBER_ID).descriptor, expected);
            assert.equal(buildCredentialReadCommand(target, 'github', MEMBER_ID).descriptor, expected);
        });

        test(`${name}: without a member id the shared legacy path is kept`, () => {
            const se = getSeCommands(target);
            const legacy = se.credentialHelperPath('github');
            assert.ok(legacy.includes('.fleet-git-credential-github'));
            assert.ok(!legacy.includes(MEMBER_ID));
            assert.ok(!/\.fleet-git-credential-github\.(?!bat)/.test(legacy));
        });

        test(`${name}: an unsafe member id is refused`, () => {
            assert.throws(() => getSeCommands(target).credentialHelperPath('github', 'id;rm -rf'), /unsafe member id/);
        });
    }
});
