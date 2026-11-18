// Public keys ("<type> <base64>", no comment) for the authorized_keys match
// validator tests. All but the sk- keys were generated with ssh-keygen (public
// halves only; the private keys were discarded). The sk- keys need a hardware
// token, so they are assembled here in their documented wire format.

const wireString = (b: Buffer | string): Buffer => {
  const data = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
};

const wireKey = (type: string, ...fields: Array<Buffer | string>): string =>
  `${type} ${Buffer.concat([wireString(type), ...fields.map(wireString)]).toString('base64')}`;

const bytes = (n: number, seed: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (seed + i * 7) & 0xff));
const ecPoint = (n: number, seed: number): Buffer => Buffer.concat([Buffer.from([0x04]), bytes(n - 1, seed)]);

export const SSH_PUBLIC_KEYS = {
  rsa2048: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDSv9Gjlo4/jxd8Qcies5whb77X3FU/jR2WCJGjPcxdugbLXh5ueFU2XPJrYeNX2dULVzCCPEP75HDWCatBFswtX8DzY82yamn3JIb8I/E2+B2ui+Ax4VUxG/MaLoEox/d66lGKQmWIOFqY2h93emr8f6iT8G0bahe/Yi/vaxyWIr0VTP7XmaO5hyicKwT2bzOd2os2BNUH/PaAuYJ0usDN8H9kGo0j6jYd0fIS8lk5pjUZZWVwjmFcPUJmz2jgDAHDQxAryKFZhzFPRZC72cKyABSTiZWHRv0rX/WJmgoOEyibYXCghfHE6X3dnU83gSNYldka4UMeYbLx9zVXM55P',
  rsa4096: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDK6YhLOZ4MQfRplsU7d9qk1W22nhokaOV6whKvkTnylGoUi6D10C9skUFT+EGSh/G5hqdB2uZC5RgTrgPoLzcVYeSgMaZlCKudu0vbFUaBDTCSJMr4kApwZI4il6A6nGqVgROTOINezkZ8GGMULNcsJu66KZv5l3mUQy34TrholKehW0RmUVi2i3wLcWB9m+2Yyk10Z0hL8DOBwHWv4Z76hDBXpTfooFLBO7p3UhGHvTi5D1w9lRrwTlA4rJG8lYGQPCBnjBBohGhEG9Czu/09eE9v2wlNQEdkmyfQnP33vLnhUflUmKCF3BgexA7VX12rl7NlCufYcNhaV+XV1HKLRRIcYg7wn/RriZNm5fpyJTdEhD/oepzq77cp4LNE6VzNJfflkduCCrKJ54gFX1NEpELlZOPF9yfwFf07+fbk8M5j+zEp6k20xXNPw75A7+H8RoR1ncUljMswET7bQ17FNhVdIWEEjJlkRO/IAB1U51kvP4XEsoBZEzNE7yJS0Xc/nl/FYzuD5r7LxlHmx48PtPrhNjl6TWvKnrOcU6/R1MzMZyVaAGfrzBDgbSxiu/jmHD721yJ+P7YrgNyxXDF7bKJp8XIkOzwWlGIkzXGfsn5nE+pZRC/M9Vg8n4qD5bosGXJz92eNVPnCWgEYqo2HW/EovKdiewAVTcVitrCAvw==',
  ed25519: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFaPOYK9NYdIUxFsQ3HYOVJ8zj7ZTCpj6ARIrO2E9UJb',
  ecdsa256: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBOcHXpDJjejbF2UBz9P4+/kFnvd4IzgpSo16CVvcRJmY23BE1RjH1YomF0U/DTylw8QOxpDAJ5SYQgf2xD+bAvg=',
  ecdsa384: 'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBMSEGV1pT7r243Lmhj20d3jPGNtxOENifQmDLzkNjfX8250IQ3BRmPZowbEH+B7QkGiEYLV8MqLrsoPXPiZxV9c5NRYlOnICTBW5Xh+N6SQSBKvRrTmoXSQDmH321OMPDQ==',
  ecdsa521: 'ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBABZx2ClIDyRaygnMTvJhYeGic+d+w4ZdLa0W45QfFVbBXkOu3iJNI2O/obXGuE42RGoA6Z5YUZvARhgZnffPacePAAO5ltliDldOdcDsic5k/zNlo3CXm+nrggBb7Ms08GdTYtV9leekpnMIUDv/cQrywNbNEzJfH5E6CxWyXBX2DsDTg==',
  skEd25519: wireKey('sk-ssh-ed25519@openssh.com', bytes(32, 3), 'ssh:'),
  skEcdsa256: wireKey('sk-ecdsa-sha2-nistp256@openssh.com', 'nistp256', ecPoint(65, 5), 'ssh:'),
} as const;

/** Keys of the accepted types that must NOT be accepted. */
export const SSH_INVALID_KEYS = {
  // Below the 2048-bit RSA floor.
  rsa1024: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQCyohn3Wcewar/Aq/5PxZA2Gpz4+1AyUFLXZBdWaOdCRNielnnEyxFkToMO6jByZ/ll0DIOyvm/AokXUb9xG887911UKQnzALoV2MxZGTXpgOAsfBwifL831eiXvW4V8HJ4eIfYrX2s5AcktrEKnX+l6m43OydNyyoABl8bgwq3LQ==',
  // A real OpenSSH certificate: certificates are never revoked by match.
  ed25519Cert: 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIG1ZHlT3E6kO1ajgfAbgrB6QzQYo/hjhGkWW/PDL9jEPAAAAIFaPOYK9NYdIUxFsQ3HYOVJ8zj7ZTCpj6ARIrO2E9UJbAAAAAAAAAAAAAAABAAAAAmlkAAAAAAAAAAAAAAAA//////////8AAAAAAAAAggAAABVwZXJtaXQtWDExLWZvcndhcmRpbmcAAAAAAAAAF3Blcm1pdC1hZ2VudC1mb3J3YXJkaW5nAAAAAAAAABZwZXJtaXQtcG9ydC1mb3J3YXJkaW5nAAAAAAAAAApwZXJtaXQtcHR5AAAAAAAAAA5wZXJtaXQtdXNlci1yYwAAAAAAAAAAAAAAMwAAAAtzc2gtZWQyNTUxOQAAACAzZg2CX6fZpAsZ/mB2cCHlMD+iaeb6cq/2wfUaDQ84yAAAAFMAAAALc3NoLWVkMjU1MTkAAABA1b9vw3AxkDldZPQlJDxh73lhbEVu7d2zpM2zqi3s4nsYCQpV5JNPL8+hM+XZjhY8NqsIWo2485DkzkjXLUoHAA==',
  ecdsaWrongCurve: wireKey('ecdsa-sha2-nistp256', 'nistp384', ecPoint(65, 9)),
  ecdsaWrongPointSize: wireKey('ecdsa-sha2-nistp384', 'nistp384', ecPoint(65, 9)),
  ed25519ShortKey: wireKey('ssh-ed25519', bytes(31, 1)),
  ed25519TrailingField: wireKey('ssh-ed25519', bytes(32, 1), 'x'),
  skEd25519NoApplication: wireKey('sk-ssh-ed25519@openssh.com', bytes(32, 3)),
  dss: wireKey('ssh-dss', bytes(129, 1), bytes(21, 2), bytes(128, 3), bytes(128, 4)),
} as const;

/**
 * Truncated variants of a "<type> <base64>" key: cut at every wire field
 * boundary (a cut exactly between fields), 1 byte short, inside the first
 * field, and the base64 text itself cut at 32 / 40 chars and 4 chars short.
 */
export function truncatedKeys(key: string): Array<[string, string]> {
  const [type, body] = key.split(' ');
  const blob = Buffer.from(body, 'base64');
  const cuts = new Map<string, number>();
  for (let off = 0, i = 0; off < blob.length; i++) {
    off += 4 + blob.readUInt32BE(off);
    if (off < blob.length) cuts.set(`after field ${i}`, off);
  }
  cuts.set('1 byte short', blob.length - 1);
  cuts.set('inside the type field', 10);
  const out: Array<[string, string]> = [...cuts].map(([name, n]) => [`blob ${name} (${n}/${blob.length} bytes)`, `${type} ${blob.subarray(0, n).toString('base64')}`]);
  for (const chars of [32, 40, body.length - 4]) out.push([`base64 cut to ${chars}/${body.length} chars`, `${type} ${body.slice(0, chars)}`]);
  return out;
}
