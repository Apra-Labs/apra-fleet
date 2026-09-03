// Pure secret/credential scanner for the memory-contract/v1 fixture corpus
// (T1.4.1 acceptance criterion). Extracted as a small set of pure functions,
// scoped to a single (path, content) pair, so the test file can exercise it
// both against the real committed corpus AND against a planted-credential
// scratch copy without any behavior drift between the two runs.
//
// Deliberately pattern-based rather than entropy-based: the corpus is
// synthetic-only content (memory-contract/v1's own T1.4.1 constraint -- "no
// real BluSKY code, credentials, or customer text"), so a small, well-known
// set of credential SHAPES is enough to catch an accidental leak without
// false-positiving on ordinary prose.
export interface Finding {
  file: string;
  pattern: string;
  match: string;
}

interface NamedPattern {
  name: string;
  regex: RegExp;
}

// Each regex is a well-known, publicly documented credential SHAPE.
// AKIAIOSFODNN7EXAMPLE (AWS's own official documentation example key) is the
// standard, universally-recognized non-functional placeholder used to test
// this exact pattern -- see AWS docs "Understanding and getting your AWS
// credentials" -- so using that literal string in this file's own tests
// plants a format match, not a real secret.
const CREDENTIAL_PATTERNS: NamedPattern[] = [
  { name: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer-token', regex: /\bBearer [A-Za-z0-9\-._~+/]{20,}=*/g },
  { name: 'github-pat', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
];

/**
 * Scan one fixture file's raw text content for credential-shaped patterns.
 * Returns one Finding per match (not per pattern), so a file with several
 * hits is fully visible rather than collapsed to a single boolean.
 */
export function scanFixtureContent(filePath: string, content: string): Finding[] {
  const findings: Finding[] = [];
  for (const { name, regex } of CREDENTIAL_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      findings.push({ file: filePath, pattern: name, match: match[0] });
    }
  }
  return findings;
}
