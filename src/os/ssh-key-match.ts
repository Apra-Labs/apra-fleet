/**
 * The authorized_keys match remove_member revokes by: "<type> <base64>" taken
 * from a fleet .pub file. Every line containing it is deleted, so a degenerate
 * match is destructive: '' matches every line (an empty .pub wipes the file),
 * a bare type ('ssh-rsa') matches every key of that type, and a TRUNCATED key
 * is a prefix of every key sharing its fixed header (an ecdsa key cut inside
 * its point matches every key on that curve). Only a complete public key is
 * accepted: the base64 blob is parsed as the SSH wire format and must be
 * consumed exactly, with every field the key type requires at a valid size.
 *
 * Accepted types: ssh-rsa (modulus >= 2048 bits; fleet generates RSA-4096),
 * ssh-ed25519, ecdsa-sha2-nistp256/384/521, and the FIDO variants
 * sk-ssh-ed25519@openssh.com / sk-ecdsa-sha2-nistp256@openssh.com. Everything
 * else -- certificates (*-cert-v01@openssh.com), ssh-dss, unknown types -- is
 * rejected: fleet never generates them, so refusing to revoke is the safe side.
 */

const ECDSA_CURVES: Record<string, { curve: string; point: number }> = {
  'ecdsa-sha2-nistp256': { curve: 'nistp256', point: 65 },
  'ecdsa-sha2-nistp384': { curve: 'nistp384', point: 97 },
  'ecdsa-sha2-nistp521': { curve: 'nistp521', point: 133 },
  'sk-ecdsa-sha2-nistp256@openssh.com': { curve: 'nistp256', point: 65 },
};

const MIN_RSA_MODULUS_BITS = 2048;

/** Split a blob into uint32-length-prefixed strings; null on overrun or trailing bytes. */
function wireFields(blob: Buffer): Buffer[] | null {
  const fields: Buffer[] = [];
  let off = 0;
  while (off < blob.length) {
    if (blob.length - off < 4) return null;
    const len = blob.readUInt32BE(off);
    off += 4;
    if (len > blob.length - off) return null;
    fields.push(blob.subarray(off, off + len));
    off += len;
  }
  return fields;
}

/** A positive SSH mpint (no sign bit, minimal encoding); its bit length, or 0 if invalid. */
function positiveMpintBits(m: Buffer): number {
  if (m.length === 0 || (m[0] & 0x80) !== 0) return 0;
  if (m[0] === 0 && (m.length === 1 || (m[1] & 0x80) === 0)) return 0;
  const v = m[0] === 0 ? m.subarray(1) : m;
  return (v.length - 1) * 8 + (32 - Math.clz32(v[0]));
}

/** True when the decoded blob is a complete, well-formed public key of `type`. */
function isCompleteKeyBlob(type: string, blob: Buffer): boolean {
  const f = wireFields(blob);
  if (!f || f.length === 0 || f[0].toString('latin1') !== type) return false;
  if (type === 'ssh-rsa') {
    return f.length === 3 && positiveMpintBits(f[1]) >= 2 && positiveMpintBits(f[2]) >= MIN_RSA_MODULUS_BITS;
  }
  if (type === 'ssh-ed25519') return f.length === 2 && f[1].length === 32;
  if (type === 'sk-ssh-ed25519@openssh.com') return f.length === 3 && f[1].length === 32 && f[2].length > 0;
  const ec = ECDSA_CURVES[type];
  if (ec) {
    const sk = type.startsWith('sk-');
    return f.length === (sk ? 4 : 3)
      && f[1].toString('latin1') === ec.curve
      && f[2].length === ec.point && f[2][0] === 0x04
      && (!sk || f[3].length > 0);
  }
  return false;
}

/**
 * The "<type> <base64>" match for a public key line (trailing comment
 * ignored), or null when the line is not a complete, valid public key.
 */
export function authorizedKeyMatch(pubKeyLine: string): string | null {
  const fields = pubKeyLine.trim().split(/\s+/);
  if (fields.length < 2) return null;
  const [type, body] = fields;
  // Canonical base64 only (length a multiple of 4), so the body decodes to
  // exactly the bytes it spells and nothing is silently dropped.
  if (body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const blob = Buffer.from(body, 'base64');
  if (blob.toString('base64') !== body) return null;
  if (!isCompleteKeyBlob(type, blob)) return null;
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
