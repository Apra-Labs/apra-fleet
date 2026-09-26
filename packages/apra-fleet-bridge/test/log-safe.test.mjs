// Tests for src/log-safe.mjs -- the mask-and-continue redactor sinks use
// before a record reaches JSON.stringify(). Unlike contracts.test.mjs's
// assertNoSecrets (throw-on-detect), createRedactor must NEVER throw --
// every test here is really checking "does this degrade to something
// serializable" as much as "was the secret actually masked".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor } from '../src/log-safe.mjs';

describe('createRedactor key-name masking', () => {
  test('masks keys containing token/sas/password/secret as substrings, case-insensitively', () => {
    const redact = createRedactor();
    const out = redact({
      apiToken: 'abc',
      SAS_URL: 'https://example/blob?sig=x',
      userPassword: 'hunter2',
      topSecretPlan: 'nope',
      ordinary: 'kept',
    });
    assert.equal(out.apiToken, '[REDACTED]');
    assert.equal(out.SAS_URL, '[REDACTED]');
    assert.equal(out.userPassword, '[REDACTED]');
    assert.equal(out.topSecretPlan, '[REDACTED]');
    assert.equal(out.ordinary, 'kept');
  });

  test('masks "pat" only as an exact (case-insensitive) key match', () => {
    const redact = createRedactor();
    const out = redact({ pat: 'ghp_xxx', PAT: 'ghp_yyy' });
    assert.equal(out.pat, '[REDACTED]');
    assert.equal(out.PAT, '[REDACTED]');
  });

  test('does NOT mask path/patch/compatible/pattern -- the documented pat-substring false-positive set', () => {
    const redact = createRedactor();
    const out = redact({
      path: '/tmp/x',
      patch: 'diff --git',
      compatible: true,
      pattern: '^abc$',
    });
    assert.equal(out.path, '/tmp/x');
    assert.equal(out.patch, 'diff --git');
    assert.equal(out.compatible, true);
    assert.equal(out.pattern, '^abc$');
  });
});

describe('createRedactor value masking', () => {
  test('masks a string containing a known live secret value, wherever it is filed', () => {
    const redact = createRedactor({ secrets: ['sk-live-abc123'] });
    const out = redact({ note: 'used credential sk-live-abc123 to log in' });
    assert.ok(!out.note.includes('sk-live-abc123'));
    assert.ok(out.note.includes('[REDACTED]'));
  });

  test('masks every occurrence of a secret value repeated in one string', () => {
    const redact = createRedactor({ secrets: ['tok-1'] });
    const out = redact({ note: 'tok-1 then again tok-1' });
    assert.equal(out.note, '[REDACTED] then again [REDACTED]');
  });

  test('masks a scheme://user:password@host URL credential', () => {
    const redact = createRedactor();
    const out = redact({ remoteUrl: 'https://alice:hunter2@example.com/repo.git' });
    assert.ok(!out.remoteUrl.includes('hunter2'));
    assert.ok(!out.remoteUrl.includes('alice'));
    assert.ok(out.remoteUrl.startsWith('https://[REDACTED]@'));
    assert.ok(out.remoteUrl.endsWith('example.com/repo.git'));
  });

  test('an empty/omitted secrets list still applies key-name and credential-URL masking', () => {
    const redact = createRedactor();
    const out = redact({ token: 'abc', url: 'https://u:p@h/x' });
    assert.equal(out.token, '[REDACTED]');
    assert.ok(!out.url.includes('u:p@'));
  });
});

describe('createRedactor SAS URL masking', () => {
  // acct.blob.core.windows.net probe from the pre-merge review: a SAS query
  // string is a credential even though the URL has no user:password@
  // authority -- 'sig' is the signature that grants access.
  const sasUrl = 'https://acct.blob.core.windows.net/c/b?sv=2021&sig=SIGNATURE_PLACEHOLDER&se=2026-01-01';

  test('masks the sig parameter in a plain value, leaving account/container/blob/sv/se legible', () => {
    const redact = createRedactor();
    const out = redact({ u: sasUrl });
    assert.ok(!out.u.includes('SIGNATURE_PLACEHOLDER'), 'sig value must be masked');
    assert.ok(out.u.includes('sig=[REDACTED]'));
    assert.ok(out.u.includes('acct.blob.core.windows.net/c/b'), 'account/container/blob path must stay legible');
    assert.ok(out.u.includes('sv=2021'), 'sv must stay legible (diagnostic, not secret)');
    assert.ok(out.u.includes('se=2026-01-01'), 'se must stay legible (diagnostic, not secret)');
  });

  test('masks the sig parameter when the SAS URL appears inside a free-text message', () => {
    const redact = createRedactor();
    const out = redact({ message: `upload failed for ${sasUrl}` });
    assert.ok(!out.message.includes('SIGNATURE_PLACEHOLDER'));
    assert.ok(out.message.includes('sig=[REDACTED]'));
  });

  test('masks the sig parameter when the SAS URL appears inside an error\'s details', () => {
    const redact = createRedactor();
    const err = new Error('blob write failed');
    err.details = { url: sasUrl };
    const out = redact({ e: err });
    assert.ok(!out.e.details.url.includes('SIGNATURE_PLACEHOLDER'));
    assert.ok(out.e.details.url.includes('sig=[REDACTED]'));
  });

  test('does not mangle an ordinary URL with a harmless query string', () => {
    const redact = createRedactor();
    const url = 'https://example.com/search?q=hello+world&page=2&sort=asc';
    const out = redact({ u: url });
    assert.equal(out.u, url);
  });
});

describe('createRedactor Error serialization', () => {
  test('a plain Error serializes with name/message rather than {}', () => {
    const redact = createRedactor();
    const out = redact({ e: new Error('boom') });
    assert.equal(out.e.name, 'Error');
    assert.equal(out.e.message, 'boom');
    assert.ok('code' in out.e === false, 'a plain Error has no code to report');
  });

  test('a BridgeError serializes with name/message/code/details', () => {
    const redact = createRedactor();
    class BridgeError extends Error {
      constructor(code, message, details = {}) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
        this.details = details;
      }
    }
    const err = new BridgeError('LAUNCH_FAILED', 'sprint launch failed', { member: 'alice' });
    const out = redact({ e: err });
    assert.equal(out.e.name, 'BridgeError');
    assert.equal(out.e.message, 'sprint launch failed');
    assert.equal(out.e.code, 'LAUNCH_FAILED');
    assert.deepEqual(out.e.details, { member: 'alice' });
  });

  test('an Error carries a stack string, itself run through redaction', () => {
    const redact = createRedactor({ secrets: ['leaked-token-value'] });
    const err = new Error('failed using leaked-token-value');
    const out = redact({ e: err });
    assert.equal(typeof out.e.stack, 'string');
    assert.ok(!out.e.stack.includes('leaked-token-value'), 'the message line inside stack must also be redacted');
  });

  test('a redacted error message containing a credential URL is masked, not left in the clear', () => {
    const redact = createRedactor();
    const err = new Error('git operation failed for https://alice:hunter2@example.com/repo.git');
    const out = redact({ e: err });
    assert.ok(!out.e.message.includes('hunter2'));
    assert.ok(!out.e.message.includes('alice'));
    assert.ok(out.e.message.includes('[REDACTED]'));
  });
});

describe('createRedactor structural coverage', () => {
  test('recurses into nested objects and arrays', () => {
    const redact = createRedactor();
    const out = redact({
      list: [
        { token: 'a', keep: 1 },
        { nested: { password: 'b', keep: 2 } },
      ],
    });
    assert.equal(out.list[0].token, '[REDACTED]');
    assert.equal(out.list[0].keep, 1);
    assert.equal(out.list[1].nested.password, '[REDACTED]');
    assert.equal(out.list[1].nested.keep, 2);
  });

  test('recurses into arrays of arrays', () => {
    const redact = createRedactor();
    const out = redact({ matrix: [[{ secret: 'x' }], [{ ok: true }]] });
    assert.equal(out.matrix[0][0].secret, '[REDACTED]');
    assert.equal(out.matrix[1][0].ok, true);
  });

  test('never mutates the input value', () => {
    const input = Object.freeze({ token: 'abc', nested: { password: 'def' } });
    const redact = createRedactor();
    const out = redact(input);
    assert.equal(input.token, 'abc');
    assert.equal(input.nested.password, 'def');
    assert.notEqual(out, input);
  });

  test('passes through numbers, booleans, null and undefined unchanged', () => {
    const redact = createRedactor();
    const out = redact({ n: 1, b: true, nul: null, u: undefined });
    assert.equal(out.n, 1);
    assert.equal(out.b, true);
    assert.equal(out.nul, null);
    assert.equal(out.u, undefined);
  });
});

describe('createRedactor never throws (degrades instead)', () => {
  test('a circular reference degrades to a marker instead of throwing', () => {
    const obj = { token: 'abc' };
    obj.self = obj;
    const redact = createRedactor();
    let out;
    assert.doesNotThrow(() => { out = redact(obj); });
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.self, '[circular]');
  });

  test('a circular reference nested inside an array degrades the same way', () => {
    const arr = [];
    arr.push(arr);
    const redact = createRedactor();
    let out;
    assert.doesNotThrow(() => { out = redact({ list: arr }); });
    assert.equal(out.list[0], '[circular]');
  });

  test('two independent references to the same (non-circular) object are each redacted, not flagged circular', () => {
    const shared = { token: 'abc' };
    const redact = createRedactor();
    const out = redact({ a: shared, b: shared });
    assert.equal(out.a.token, '[REDACTED]');
    assert.equal(out.b.token, '[REDACTED]');
  });

  test('a getter that throws degrades that field instead of the whole record', () => {
    const obj = { ok: 1 };
    Object.defineProperty(obj, 'boom', { enumerable: true, get() { throw new Error('nope'); } });
    const redact = createRedactor();
    let out;
    assert.doesNotThrow(() => { out = redact(obj); });
    assert.equal(out.ok, 1);
    assert.equal(out.boom, '[unreadable]');
  });

  test('a BigInt is stringified rather than thrown on', () => {
    const redact = createRedactor();
    let out;
    assert.doesNotThrow(() => { out = redact({ big: 10n }); });
    assert.equal(out.big, '10');
  });

  test('a function value degrades to a marker', () => {
    const redact = createRedactor();
    const out = redact({ fn: () => 'hi' });
    assert.equal(out.fn, '[function]');
  });

  test('a bare value (not an object) at the top level is handled directly', () => {
    const redact = createRedactor();
    assert.equal(redact('plain string'), 'plain string');
    assert.equal(redact(42), 42);
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
  });

  test('a bare secret-bearing string at the top level is still value-masked', () => {
    const redact = createRedactor({ secrets: ['sk-top-level'] });
    assert.equal(redact('leaked sk-top-level here'), 'leaked [REDACTED] here');
  });
});
