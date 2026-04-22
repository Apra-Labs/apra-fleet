/**
 * Maps raw ssh2 error strings to user-friendly guidance messages.
 */
export function classifySshError(error: string): string {
  const msg = error ?? '';

  if (/Authentication failed|All configured authentication methods failed/i.test(msg)) {
    return 'Authentication failed — wrong password or key not accepted';
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return 'Connection refused — check host and port';
  }
  if (/ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
    return 'Host unreachable — check hostname and network';
  }
  if (/password prompt could not be opened|OOB|auth-socket/i.test(msg)) {
    return "Password prompt could not be opened. Try passing the password directly via the 'password' field.";
  }

  return msg;
}
