/**
 * The authorized_keys match remove_member revokes by: "<type> <base64>" taken
 * from a fleet .pub file. Every line containing it is deleted, so a degenerate
 * match is destructive: '' matches every line (an empty .pub wipes the file)
 * and a bare type ('ssh-rsa') matches every key of that type. Only a real
 * public key -- known type, base64 body whose blob names the same type -- is
 * accepted.
 */

const BASE_TYPES = [
  'ssh-ed25519',
  'ssh-ed448',
  'ssh-rsa',
  'ssh-dss',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
];

function certType(base: string): string {
  const at = base.indexOf('@');
  return at < 0 ? `${base}-cert-v01@openssh.com` : `${base.slice(0, at)}-cert-v01${base.slice(at)}`;
}

const KNOWN_KEY_TYPES = new Set([...BASE_TYPES, ...BASE_TYPES.map(certType)]);

/** Shortest accepted base64 body; real keys are 68+ chars (ed25519). */
const MIN_BODY_CHARS = 32;

/**
 * The "<type> <base64>" match for a public key line (trailing comment
 * ignored), or null when the line is not a real public key.
 */
export function authorizedKeyMatch(pubKeyLine: string): string | null {
  const fields = pubKeyLine.trim().split(/\s+/);
  if (fields.length < 2) return null;
  const [type, body] = fields;
  if (!KNOWN_KEY_TYPES.has(type)) return null;
  if (body.length < MIN_BODY_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  // The key blob starts with the length-prefixed type name.
  const blob = Buffer.from(body, 'base64');
  if (blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len !== type.length || blob.subarray(4, 4 + len).toString('latin1') !== type) return null;
  return `${type} ${body}`;
}

/**
 * Guard for the OS command builders: throws unless `keyMatch` is exactly a
 * valid "<type> <base64>" match, so no builder ever emits a command that
 * could match unrelated (or all) authorized_keys lines.
 */
export function assertAuthorizedKeyMatch(keyMatch: string): void {
  if (authorizedKeyMatch(keyMatch) !== keyMatch) {
    throw new Error('refusing to build an authorized_keys removal command: the key match is not a "<type> <base64>" public key');
  }
}
