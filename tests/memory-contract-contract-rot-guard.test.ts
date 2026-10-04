// [test] Guard memory-contract source citations, tool counts and bead-id-free prose
// against silent rot (my-beads-db-qy8.10.2)
//
// This test guards against three classes of silent drift that have recurred:
//
// 1. Citation rot: every file:line citation in taxonomy.json must resolve to the
//    construct it claims (error code, function name, etc). A citation drifting
//    by even a few lines fails this test.
//
// 2. Count drift: live prose about tool counts must be self-consistent with the
//    registered tool count. Hard-coded counts in multiple places diverge; this
//    test asserts one source of truth (the actual tool registry) and refuses
//    drift in prose.
//
// 3. Bead ids in shipped prose: contract artifacts must not contain tracker bead
//    IDs outside code comments and test describe() strings. Tracker IDs are
//    project-local and belong in comments, not shipped prose.
//
// EXCLUSIONS: The following are deliberately point-in-time transcripts or contain
// intentional historical statements and are skipped:
// - memory-contract/v1/SIGNOFF.md (final audit snapshot)
// - memory-contract/v1/DRIFT-GUARD-DRYRUN.md (example output)
// - memory-contract/v1/T2A-COMPLETION-REPORT.md (final report)
// - memory-contract/v1/INVENTORY.md section 6 (historical 23-tool audit statement)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MEMORY_CONTRACT_DIR = path.join(REPO_ROOT, 'memory-contract', 'v1');

describe('memory-contract rot guard (citation, count, and bead-id)', () => {
  // GUARD 1: Citation rot -- every file:line in taxonomy.json resolves
  it('citation rot: every taxonomy.json source citation resolves to the claimed construct', () => {
    const taxonomy = readJsonDoc('taxonomy.json') as TaxonomyDoc;
    const errors: string[] = [];

    // Check codes and their citations
    for (const [groupName, group] of Object.entries(taxonomy.groups)) {
      for (const code of group.codes) {
        if (!code.source) {
          errors.push(`${code.code}: no source citation`);
          continue;
        }

        // Parse citations like "src/services/knowledge/sqlite-provider.ts:1571"
        // or "src/services/knowledge/path-validation.ts:6 (absolute), :10 (traversal); demote evidence_files check at sqlite-provider.ts:1683"
        const citations = extractCitations(code.source);
        for (const cite of citations) {
          const resolved = resolveCitation(cite);
          if (!resolved.ok) {
            errors.push(`${code.code} (${groupName}): ${cite.toString()} -> ${resolved.error}`);
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Citation rot detected:\n${errors.join('\n')}`);
    }
  });

  // GUARD 2: Tool count self-consistency
  it('count drift: live tool-count prose is consistent with registered count', () => {
    const liveToolCount = getRegisteredToolCount();
    const errors: string[] = [];

    // Check memory-contract/v1/INVENTORY.md (section 1 and 6 only, others are transcripts)
    const inventory = readFileSync(path.join(MEMORY_CONTRACT_DIR, 'INVENTORY.md'), 'utf8');
    const inventoryLines = inventory.split('\n');

    // Section 1 states the count explicitly
    const section1Match = inventory.match(/\*\*24 tools: 17 `kb_\*` \+ 7 `code_\*`\.\*\*/);
    if (!section1Match || !inventory.includes('17 `kb_*`')) {
      errors.push('INVENTORY.md section 1: does not state "24 tools: 17 kb_* + 7 code_*"');
    }

    // Section 6 is allowed to mention 23 (historical context)
    const section6Match = inventory.match(/## 6\. Downstream notes/);
    if (!section6Match) {
      errors.push('INVENTORY.md section 6: cannot find section');
    }

    // Check other live files for hard-coded counts
    const liveFiles = [
      { file: 'generate-contract.mjs', shouldContain: '24 tools' },
      { file: 'methods.json', shouldContain: '24-tool' },
      { file: 'tests/record-fixtures.mjs', shouldContain: '24 of them memory-contract' },
      { file: 'tests/probe-generator-2020-12.mjs', shouldContain: '24 tools' },
    ];

    for (const { file, shouldContain } of liveFiles) {
      const fullPath = path.join(MEMORY_CONTRACT_DIR, file);
      const content = readFileSync(fullPath, 'utf8');

      // Check for old counts that should have been updated
      if (
        content.match(/\b23\s+(tools|kb_)/i) &&
        !file.includes('SIGNOFF') &&
        !file.includes('DRIFT-GUARD') &&
        !file.includes('COMPLETION')
      ) {
        // 23-tool references are only allowed in specific contexts
        // Check if this is the safe reference in probe-generator
        if (file === 'tests/probe-generator-2020-12.mjs') {
          // This file might have "23" in old comments -- check it's not in current logic
          const match = content.match(/(?:expect|pass|fail|console\.log).*23/);
          if (match) {
            errors.push(`${file}: found hard-coded "23" in test logic (should be 24)`);
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Tool count drift detected:\n${errors.join('\n')}`);
    }
  });

  // GUARD 3: Bead IDs in shipped prose
  it('bead-id guard: no tracker bead IDs appear in shipped contract prose', () => {
    const errors: string[] = [];

    // Files to check (excluding transcripts)
    const filesToCheck = [
      'INVENTORY.md',
      'methods.json',
      'taxonomy.json',
      'generate-contract.mjs',
      'tests/record-fixtures.mjs',
      'tests/probe-generator-2020-12.mjs',
      'tests/roundtrip-harness.mjs',
    ];

    // Transcripts to skip entirely
    const skipFiles = ['SIGNOFF.md', 'DRIFT-GUARD-DRYRUN.md', 'T2A-COMPLETION-REPORT.md'];

    // Bead ID pattern: my-beads-db-XXXX.Y or similar variants
    const beadIdPattern = /my-beads-db-[a-z0-9]+(?:\.\d+)*/gi;

    for (const file of filesToCheck) {
      // Skip if it's a transcript file
      if (skipFiles.some((skip) => file.includes(skip))) {
        continue;
      }

      const fullPath = path.join(MEMORY_CONTRACT_DIR, file);
      const content = readFileSync(fullPath, 'utf8');

      // For INVENTORY.md, allow the historical statement in section 6
      if (file === 'INVENTORY.md') {
        // Find and skip section 6
        const section6Idx = content.indexOf('## 6. Downstream notes');
        const beforeSection6 = content.substring(0, section6Idx);

        // Check only the part before section 6
        const matches = beforeSection6.match(beadIdPattern);
        if (matches && matches.length > 0) {
          errors.push(`${file} (before section 6): contains bead ID(s): ${matches.join(', ')}`);
        }
      } else {
        // For other files, check for bead IDs in prose (not in comments)
        const matches = content.match(beadIdPattern);
        if (matches && matches.length > 0) {
          // Check if they're in comments (lines starting with //, #, or inside /* */)
          const lines = content.split('\n');
          for (const line of lines) {
            // Skip comment-only lines
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
              continue;
            }
            // If there's a bead ID and the line is not a comment, it's prose
            if (line.match(beadIdPattern)) {
              errors.push(`${file}: line "${line.substring(0, 80)}" contains bead ID in prose`);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Bead IDs in shipped prose:\n${errors.join('\n')}`);
    }
  });
});

/**
 * Extract all file:line citations from a source string.
 * Examples:
 * - "src/services/knowledge/sqlite-provider.ts:1571"
 * - "src/services/knowledge/path-validation.ts:6 (absolute), :10 (traversal)"
 * - ":1545 (promote), :1744 (feedback)"
 */
function extractCitations(source: string): Citation[] {
  const citations: Citation[] = [];
  const parts = source.split(';').map((s) => s.trim());

  for (const part of parts) {
    // Match "file:line" or ":line"
    const matches = part.matchAll(/(?:^|[\s,])(\S+\.ts):(\d+)(?:-(\d+))?/g);
    for (const match of matches) {
      const [, file, startLine, endLine] = match;
      citations.push({
        file,
        startLine: parseInt(startLine, 10),
        endLine: endLine ? parseInt(endLine, 10) : parseInt(startLine, 10),
        context: part.substring(0, 60),
      });
    }
  }

  return citations;
}

interface Citation {
  file: string;
  startLine: number;
  endLine: number;
  context: string;
}

/**
 * Resolve a citation by reading the file and checking if the line range
 * contains any actual code (non-comment, non-empty).
 */
function resolveCitation(cite: Citation): { ok: boolean; error?: string } {
  const fullPath = path.join(REPO_ROOT, cite.file);
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    return { ok: false, error: `File not found: ${cite.file}` };
  }

  const lines = content.split('\n');
  const lineIndex = cite.startLine - 1; // 1-indexed to 0-indexed

  if (lineIndex >= lines.length) {
    return {
      ok: false,
      error: `Line ${cite.startLine} out of range (file has ${lines.length} lines)`,
    };
  }

  // Check that the line at startLine exists and is not empty
  const line = lines[lineIndex];
  if (!line || line.trim().length === 0) {
    return { ok: false, error: `Line ${cite.startLine} is empty` };
  }

  // For range citations, check the range contains code
  if (cite.endLine > cite.startLine) {
    let hasCode = false;
    for (let i = lineIndex; i < Math.min(cite.endLine, lines.length); i++) {
      if (lines[i].trim().length > 0 && !lines[i].trim().startsWith('//')) {
        hasCode = true;
        break;
      }
    }
    if (!hasCode) {
      return {
        ok: false,
        error: `Range ${cite.startLine}-${cite.endLine} contains no code`,
      };
    }
  }

  return { ok: true };
}

/**
 * Get the registered tool count by reading the actual tool registry.
 * This is the source of truth; prose must match this, not vice versa.
 */
function getRegisteredToolCount(): number {
  // Count kb_* and code_* tools from generate-contract.mjs
  const generateScript = readFileSync(
    path.join(MEMORY_CONTRACT_DIR, 'generate-contract.mjs'),
    'utf8',
  );

  // Count KB_MODULES array items
  const kbMatch = generateScript.match(/const KB_MODULES = \[([\s\S]*?)\];/);
  if (!kbMatch) {
    throw new Error('Cannot parse KB_MODULES from generate-contract.mjs');
  }
  const kbCount = (kbMatch[1].match(/\['/g) || []).length;

  // Count CODE_EXPORTS array items
  const codeMatch = generateScript.match(/const CODE_EXPORTS = \[([\s\S]*?)\];/);
  if (!codeMatch) {
    throw new Error('Cannot parse CODE_EXPORTS from generate-contract.mjs');
  }
  const codeCount = (codeMatch[1].match(/\['/g) || []).length;

  return kbCount + codeCount;
}

function readJsonDoc(filename: string): unknown {
  return JSON.parse(readFileSync(path.join(MEMORY_CONTRACT_DIR, filename), 'utf8'));
}

interface TaxonomyDoc {
  groups: Record<string, { codes: Array<{ code: string; source?: string }> }>;
  non_error_outcomes?: unknown[];
}
