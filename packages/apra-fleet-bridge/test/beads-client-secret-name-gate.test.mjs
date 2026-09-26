// Charset gate on `secretName` in buildTrackerCommand.
//
// REGRESSION -- a real command-injection path, found in review before this
// branch was pushed. buildTrackerCommand interpolates `secretName` BARE into
// `{{secret.${secretName}}}`, and the result is a shell command string
// dispatched to a member. It used to check only that the name was truthy,
// while rest-client.mjs -- performing the identical interpolation -- gated
// its charset. A name containing '}' closes the placeholder early and
// everything after it becomes shell text the member executes:
//
//   secretName = 'x}} ; <command> ; echo {{secret.y'
//   ->  AZURE_DEVOPS_PAT={{secret.x}} ; <command> ; echo {{secret.y}} bd ado pull 2
//
// Three statements, the middle one attacker-chosen. The value arrives from
// outside the process -- `--secret-name`, FLEET_BRIDGE_SECRET_NAME, the repo
// config file, or the pipeline's own `adoPatSecretName` parameter -- so
// anyone able to queue a pipeline could run commands on the member host.
//
// These tests assert on the THROW rather than on the emitted string. A test
// that merely checked the output looked right for a benign name is exactly
// what let this gap survive to a live integration run.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTrackerCommand } from '../src/beads-client.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

const GOOD = { namespace: 'ado', verb: 'pull', refs: ['2'], targetOs: 'linux', shell: 'posix' };

test('rejects a secretName that breaks out of the placeholder', () => {
  assert.throws(
    () => buildTrackerCommand({ ...GOOD, secretName: 'x}} ; echo PWNED ; echo {{secret.y' }),
    (err) => {
      assert.ok(err instanceof BridgeError, 'must be a BridgeError');
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    },
  );
});

test('rejects secretNames carrying shell metacharacters or a leading dash', () => {
  const hostile = [
    'name;whoami',
    'name && whoami',
    'name|whoami',
    'name$(whoami)',
    'name with space',
    '}',
    '{{secret.other}}',
    '-leading-dash',
  ];
  for (const name of hostile) {
    assert.throws(
      () => buildTrackerCommand({ ...GOOD, secretName: name }),
      BridgeError,
      `expected rejection for secretName ${JSON.stringify(name)}`,
    );
  }
});

test('an absent secretName is still CONFIG_MISSING, not CONFIG_INVALID', () => {
  // The two failures mean different things to a pipeline branching on the
  // exit code: "you forgot to configure it" vs "what you configured is
  // dangerous". Adding the charset gate must not collapse them.
  for (const missing of [undefined, null, '']) {
    assert.throws(
      () => buildTrackerCommand({ ...GOOD, secretName: missing }),
      (err) => {
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      },
    );
  }
});

test('still accepts a legitimate secretName, and keeps the placeholder bare', () => {
  for (const shell of ['posix', 'powershell']) {
    const cmd = buildTrackerCommand({
      ...GOOD,
      secretName: 'fleet_bridge_azdevops_pat',
      targetOs: shell === 'posix' ? 'linux' : 'windows',
      shell,
    });
    assert.match(cmd, /\{\{secret\.fleet_bridge_azdevops_pat\}\}/);
    // The placeholder must stay BARE: the server substitutes an
    // already-quoted literal, so quoting it here double-quotes the value.
    assert.ok(!/['"]\{\{secret\./.test(cmd), `placeholder must not be quoted (${shell}): ${cmd}`);
  }
});
