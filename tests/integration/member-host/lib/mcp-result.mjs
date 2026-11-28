// Reading fleet MCP tool results the way the product's own consumers do. Pure;
// unit-tested by tests/member-host-harness.test.ts.
//
// A tool result can carry display-only items ahead of or after the payload: an
// onboarding block wrapped in <apra-fleet-display> with audience ['user']
// (src/services/tool-registry.ts wrapTool). They are for the user, not the
// caller, and are dropped here (apra-fleet-client parseToolJson skips them the
// same way). execute_command reports the command's real exit code and output
// in structuredContent ({exitCode, stdout, stderr}, plus isError/reason when
// the command never produced an exit code); its text is the human form
// "Exit code: N\n<output>" and never sets the MCP isError for a nonzero exit.
// So exit codes come from structuredContent.exitCode, never from isError.

const isDisplayItem = c => /^\s*<apra-fleet-display>/.test(String(c?.text ?? ''))
  || (Array.isArray(c?.annotations?.audience) && c.annotations.audience.length === 1 && c.annotations.audience[0] === 'user');

/** { isError, text (payload items only), structured } of a raw callTool() result. */
export function toolResult(raw) {
  const items = (raw?.content ?? []).filter(c => !isDisplayItem(c));
  return {
    isError: !!raw?.isError,
    text: items.map(c => c.text ?? '').join('\n'),
    structured: raw?.structuredContent && typeof raw.structuredContent === 'object' ? raw.structuredContent : null,
  };
}

/**
 * The outcome of an execute_command result: { exitCode, stdout, stderr,
 * failure }. exitCode is the command's own, or -1 when it never produced one
 * (failure then names the reason: the structured reason, or 'no-structured'
 * for a result without structuredContent).
 */
export function execOutcome(r) {
  const sc = r?.structured;
  if (!sc || typeof sc.exitCode !== 'number') {
    return { exitCode: -1, stdout: '', stderr: String(r?.text ?? ''), failure: r?.isError ? 'error-result' : 'no-structured' };
  }
  if (sc.isError) return { exitCode: -1, stdout: String(sc.stdout ?? ''), stderr: String(sc.stderr ?? ''), failure: String(sc.reason ?? 'error') };
  return { exitCode: sc.exitCode, stdout: String(sc.stdout ?? ''), stderr: String(sc.stderr ?? ''), failure: null };
}
