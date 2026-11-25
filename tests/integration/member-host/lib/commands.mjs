// Quote-led command cases for the member-host harness: commands whose FIRST
// character is a quote, which a Windows sshd whose default shell is Git Bash
// used to mangle (every argv entry was lost and the bare binary ran). Pure.
// The orchestrator's memberCommandFor now delivers POSIX member commands as
// base64 + eval, so the member must receive the exact argv. Each case echoes
// its argv back so the driver can compare it byte for byte.

export const QUOTE_LED_CASES = Object.freeze([
  {
    id: 'single-quoted-path',
    title: 'command starting with a single-quoted path',
    command: "'/usr/bin/printf' '%s|%s|%s' alpha 'be ta' gamma",
    expected: 'alpha|be ta|gamma',
  },
  {
    id: 'embedded-double-quotes',
    title: 'command with a double-quoted program and embedded double quotes',
    command: '"/usr/bin/printf" "%s|%s" "a \\"quoted\\" b" c',
    expected: 'a "quoted" b|c',
  },
]);

/** Compare what the member echoed with the case's expected argv echo (trailing newlines ignored). */
export function verifyEcho(testCase, output) {
  const got = String(output ?? '').replace(/\r/g, '').replace(/\n+$/, '');
  const ok = got === testCase.expected;
  return { ok, got, expected: testCase.expected };
}
