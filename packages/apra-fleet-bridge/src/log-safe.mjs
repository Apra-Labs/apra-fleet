// log-safe.mjs -- the mask-and-continue redaction the sinks require before
// any record reaches JSON.stringify() (implementation-plan.md Part C: "no
// secret reaches a sink").
//
// This is a DIFFERENT kind of guard from contracts.mjs's `assertNoSecrets`:
// that one is a throw-on-detect VALIDATION guard, meant for input boundaries
// where refusing the whole request is the correct response to a secret
// showing up where it should not. A sink cannot behave that way -- it has
// already accepted a record and must write SOMETHING for it, on every tick,
// for up to two days unattended. So `createRedactor` never throws: any
// value this module cannot safely represent (a circular reference, a getter
// that throws, a BigInt, a function, anything) degrades to a safe
// placeholder instead of blowing up the sink mid-write. A redactor that
// throws would take down the very observation path it exists to protect.
//
// Key-name masking reuses contracts.mjs's `isSecretKey` predicate (the same
// 'token'/'sas'/'password'/'secret'-substring, 'pat'-exact-match rule
// `assertNoSecrets` uses) rather than a second copy that could silently
// drift from it. Value masking is additive on top of that: any string
// containing one of the caller's live secret values (`secrets`), any
// `scheme://user:password@host` credential URL (via contracts.mjs's
// `CREDENTIAL_URL_PATTERN`), and any Azure SAS URL's `sig` query parameter
// (via contracts.mjs's `SAS_SIGNATURE_PATTERN`), is masked wherever it
// appears -- regardless of what key it is filed under. An `Error` (including
// this package's `BridgeError`) is also given special handling below: its
// diagnostic fields (`name`/`message`/`code`/`details`/`stack`) are
// non-enumerable or own-but-easy-to-miss, so a plain `Object.keys()` walk
// sees an Error as empty -- exactly the record a sink's reader most needs to
// not be blank.

import { isSecretKey, CREDENTIAL_URL_PATTERN, SAS_SIGNATURE_PATTERN } from './contracts.mjs';

const MASK = '[REDACTED]';

// A global copy of CREDENTIAL_URL_PATTERN -- the shared pattern is
// deliberately not declared with the `g` flag (assertNoSecrets only ever
// needs `.test()`), but `.replace()` here needs to find every match, not
// just the first.
const CREDENTIAL_URL_PATTERN_GLOBAL = new RegExp(CREDENTIAL_URL_PATTERN.source, 'g');
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/;

// Same reasoning as CREDENTIAL_URL_PATTERN_GLOBAL above: contracts.mjs's
// SAS_SIGNATURE_PATTERN is deliberately non-global; this module needs every
// occurrence masked, not just the first.
const SAS_SIGNATURE_PATTERN_GLOBAL = new RegExp(SAS_SIGNATURE_PATTERN.source, 'gi');

/** Mask the `user:password@` portion of every credential-bearing URL found in `str`, keeping the scheme visible. */
function maskCredentialUrls(str) {
  return str.replace(CREDENTIAL_URL_PATTERN_GLOBAL, (match) => {
    const schemeMatch = match.match(SCHEME_PATTERN);
    const scheme = schemeMatch ? schemeMatch[1] : '';
    return `${scheme}${MASK}@`;
  });
}

/**
 * Mask the `sig` query parameter's value in every SAS-bearing URL found in
 * `str`, keeping the rest of the URL (account, container, blob path, and the
 * non-secret sv/se/sp/st/skoid/sktid parameters -- see contracts.mjs's
 * SAS_SIGNATURE_PATTERN for why those stay legible) intact for debugging.
 */
function maskSasSignatures(str) {
  return str.replace(SAS_SIGNATURE_PATTERN_GLOBAL, (match, prefix) => `${prefix}${MASK}`);
}

/** Mask every occurrence of any known live secret value found verbatim in `str`. Plain substring matching -- no regex, so a secret containing regex metacharacters is still matched exactly. */
function maskKnownSecretValues(str, secretValues) {
  let out = str;
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join(MASK);
    }
  }
  return out;
}

/**
 * Creates a `redact(value)` function that recursively masks secrets out of
 * `value`, returning a NEW value -- the input is never mutated.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.secrets] - known live secret values (a PAT, a SAS,
 *   a bearer token) to mask wherever they appear in a string, regardless of
 *   key name. Optional -- key-name masking and credential-URL masking apply
 *   even with an empty/omitted list.
 * @returns {(value: any) => any} redact -- never throws.
 */
export function createRedactor({ secrets } = {}) {
  const secretValues = Array.isArray(secrets) ? secrets.filter((s) => typeof s === 'string' && s.length > 0) : [];

  function redactString(str) {
    return maskKnownSecretValues(maskSasSignatures(maskCredentialUrls(str)), secretValues);
  }

  /** @param {any} value @param {Set<any>} seen - objects currently being walked, for circular-reference detection. */
  function redactValue(value, seen) {
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'function') {
      return '[function]';
    }
    if (typeof value === 'symbol') {
      return value.toString();
    }
    if (value === null || typeof value !== 'object') {
      // number, boolean, undefined -- pass through untouched.
      return value;
    }
    if (seen.has(value)) {
      return '[circular]';
    }

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => safeRedactValue(item, seen));
      }

      if (value instanceof Error) {
        // `message` and `stack` are non-enumerable on Error.prototype, so
        // the generic Object.keys() walk below sees `{}` -- exactly the
        // failure records a sink's reader most needs, written blank. Pull
        // the fields out explicitly instead: `name`/`message` always;
        // `code`/`details` only when present, since a plain Error has
        // neither but this package's BridgeError (errors.mjs) carries both
        // and `details` is caller-supplied diagnostic context worth keeping.
        // `stack` is included deliberately -- the whole point of this fix is
        // restoring the diagnostic value of a failure record from an
        // unattended, up-to-two-day sink run, and a stack trace is often the
        // only thing that says WHERE a failure happened; a path embedded in
        // it is not a secret, and a truly outsized record is a sink-level
        // size concern, not this module's job. Every field here is run
        // through the SAME redaction as any other value below (not returned
        // raw) -- an error message can easily echo a credential-bearing URL
        // it failed on, and `details` gets no special trust just because it
        // came from an Error.
        const fields = { name: value.name, message: value.message };
        if (value.code !== undefined) fields.code = value.code;
        if (value.details !== undefined) fields.details = value.details;
        if (typeof value.stack === 'string') fields.stack = value.stack;
        const out = {};
        for (const key of Object.keys(fields)) {
          out[key] = safeRedactValue(fields[key], seen);
        }
        return out;
      }

      let keys;
      try {
        keys = Object.keys(value);
      } catch {
        return '[unreadable]';
      }

      const out = {};
      for (const key of keys) {
        if (isSecretKey(key)) {
          out[key] = MASK;
          continue;
        }
        let raw;
        try {
          // A getter can throw -- degrade that one field rather than the
          // whole record.
          raw = value[key];
        } catch {
          out[key] = '[unreadable]';
          continue;
        }
        out[key] = safeRedactValue(raw, seen);
      }
      return out;
    } finally {
      // Only guards a cycle along the CURRENT path, not shared references
      // between sibling branches (which are not cycles and are each safe to
      // redact independently).
      seen.delete(value);
    }
  }

  /** `redactValue`, but never throws -- the outermost safety net for a value this function did not anticipate. */
  function safeRedactValue(value, seen) {
    try {
      return redactValue(value, seen);
    } catch {
      return '[unredactable]';
    }
  }

  return function redact(value) {
    return safeRedactValue(value, new Set());
  };
}

export default createRedactor;
