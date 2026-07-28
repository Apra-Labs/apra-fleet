// Token grammar: {{ optional_ws name optional_ws }}
// name must match [A-Za-z_][A-Za-z0-9_]* (no dots, so {{secure.NAME}} is never a token)
const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Key grammar enforced on substitutions map keys
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SubstitutionInput {
  label: string;    // displayed in errors/warnings (filename or 'prompt')
  content: string;
}

export type SubstitutionResult =
  | { ok: true; outputs: string[]; warning?: string }
  | { ok: false; error: string };

// validateSubstitutionKeys is exported so handlers can call it BEFORE reading file
// contents -- satisfying the invariant that key rejection has zero content-read side effects.
export function validateSubstitutionKeys(
  callerName: string,
  substitutions: Record<string, string>,
): { ok: true } | { ok: false; error: string } {
  const badKeys = Object.keys(substitutions).filter(k => !KEY_RE.test(k));
  if (badKeys.length > 0) {
    return { ok: false, error: buildKeyRejectionError(callerName, badKeys) };
  }
  return { ok: true };
}

// applySubstitutions is the single entry point for both send_files and execute_prompt.
// When substitutions is undefined it returns content unchanged plus a heuristic warning.
// When substitutions is provided it validates keys, checks all tokens are satisfied,
// then transforms. Values never appear in returned errors or warnings.
export function applySubstitutions(
  callerName: string,
  inputs: SubstitutionInput[],
  substitutions?: Record<string, string>,
): SubstitutionResult {
  if (substitutions === undefined) {
    const warning = buildHeuristicWarning(inputs);
    return { ok: true, outputs: inputs.map(i => i.content), warning };
  }

  // Key validation: must happen before any content processing (invariant for test o).
  const keyCheck = validateSubstitutionKeys(callerName, substitutions);
  if (!keyCheck.ok) return { ok: false, error: keyCheck.error };

  // Scan all inputs for required tokens, collect missing ones.
  const missingByInput: Array<{ label: string; tokens: string[] }> = [];
  for (const input of inputs) {
    const needed = scanTokens(input.content);
    const missing = [...needed].filter(t => !(t in substitutions));
    if (missing.length > 0) {
      missingByInput.push({ label: input.label, tokens: missing });
    }
  }

  if (missingByInput.length > 0) {
    return { ok: false, error: buildUnresolvedError(callerName, missingByInput) };
  }

  // Transform: single pass, no recursive substitution.
  const outputs = inputs.map(i => transform(i.content, substitutions));
  return { ok: true, outputs };
}

// ---- internal helpers ----

function scanTokens(content: string): Set<string> {
  const re = new RegExp(TOKEN_RE.source, 'g');
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    found.add(m[1]);
  }
  return found;
}

function transform(content: string, substitutions: Record<string, string>): string {
  const re = new RegExp(TOKEN_RE.source, 'g');
  // Replacement fn: if name is in map, use value; otherwise leave token as-is (defensive).
  return content.replace(re, (_, name: string) =>
    name in substitutions ? substitutions[name] : `{{${name}}}`,
  );
}

function buildHeuristicWarning(inputs: SubstitutionInput[]): string | undefined {
  const hits: Array<{ label: string; tokens: string[] }> = [];
  for (const input of inputs) {
    const tokens = [...scanTokens(input.content)];
    if (tokens.length > 0) hits.push({ label: input.label, tokens });
  }
  if (hits.length === 0) return undefined;

  const width = Math.max(...hits.map(h => h.label.length));
  let msg = 'Warning: content contains apparent substitution tokens but no substitutions were provided.\n';
  msg += 'Apparent tokens:\n';
  for (const { label, tokens } of hits) {
    msg += `  ${(label + ':').padEnd(width + 1)}  ${tokens.join(', ')}\n`;
  }
  return msg.trimEnd();
}

function buildKeyRejectionError(callerName: string, badKeys: string[]): string {
  let msg = `${callerName}: invalid substitutions\n\n`;
  msg += `Reserved or malformed keys (must match [A-Za-z_][A-Za-z0-9_]*):\n`;
  for (const k of badKeys) msg += `  - ${k}\n`;
  msg += `\nSecrets must use {{secure.NAME}} in execute_command -- never substitutions.`;
  return msg;
}

function buildUnresolvedError(
  callerName: string,
  missing: Array<{ label: string; tokens: string[] }>,
): string {
  const width = Math.max(...missing.map(m => m.label.length));
  let msg = `${callerName}: substitution failed\n\nUnresolved tokens:\n`;
  for (const { label, tokens } of missing) {
    msg += `  ${(label + ':').padEnd(width + 1)}  ${tokens.join(', ')}\n`;
  }
  return msg.trimEnd();
}
