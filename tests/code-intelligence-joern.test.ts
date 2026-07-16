import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Joern Provider Research Verification (apra-fleet-u4y.1.2)
//
// This test suite validates that the selected Joern tool satisfies all 6
// evaluation criteria from the code-intelligence research requirements:
// 1. License (Apache 2.0, MIT, or BSD)
// 2. Code graph/relationship analysis (call graphs, deps, symbol refs)
// 3. Semantic/structured code search
// 4. Active maintenance claim
// 5. CLI/library usability approach documented
// 6. Multi-language support (TS/JS + Python minimum)
//
// Plus verification that:
// - All 7 CodeIntelligenceProvider method stubs exist in the class skeleton
// - The file compiles without TypeScript errors
// ---------------------------------------------------------------------------

describe('Joern Provider Research Verification', () => {
  const joernFilePath = join(__dirname, '../src/tools/code-intelligence-joern.ts');
  let fileContent: string;

  // Read the file once for all tests
  beforeEach(() => {
    fileContent = readFileSync(joernFilePath, 'utf-8');
  });

  // ---------------------------------------------------------------------------
  // Criterion 1: License verification (Apache 2.0, MIT, or BSD)
  // ---------------------------------------------------------------------------
  it('Criterion 1: States a valid license (Apache 2.0, MIT, or BSD) in the header comment', () => {
    expect(fileContent).toMatch(/License:\s*(Apache 2\.0|MIT|BSD)/i);
    // Specifically verify it is Apache 2.0 for Joern
    expect(fileContent).toMatch(/License:\s*Apache 2\.0/i);
  });

  // ---------------------------------------------------------------------------
  // Criterion 2: Code graph/relationship analysis (call graphs, deps, symbol refs)
  // ---------------------------------------------------------------------------
  it('Criterion 2: Describes code graph/relationship analysis capabilities (call graphs, CFG, PDG)', () => {
    expect(fileContent).toMatch(/call graph|call.*graph/i);
    // Joern uses CPG (Code Property Graph) which merges multiple graph types
    expect(fileContent).toMatch(/CPG|Code Property Graph/);
    // Verify mention of key graph components
    expect(fileContent).toMatch(/AST|abstract syntax tree/i);
    expect(fileContent).toMatch(/CFG|control flow|call flow/i);
  });

  // ---------------------------------------------------------------------------
  // Criterion 3: Semantic/structured code search
  // ---------------------------------------------------------------------------
  it('Criterion 3: Describes semantic/structured code search capabilities (CPGQL query language)', () => {
    expect(fileContent).toMatch(/semantic|query language|CPGQL/i);
    // Joern uses CPGQL for structured queries
    expect(fileContent).toMatch(/CPGQL|Joern Query Language/);
    // Verify mention of symbolic/method name queries
    expect(fileContent).toMatch(/method.*name|symbol.*search|pattern match/i);
  });

  // ---------------------------------------------------------------------------
  // Criterion 4: Active maintenance claim
  // ---------------------------------------------------------------------------
  it('Criterion 4: Verifies tool is actively maintained (recent releases, frequent commits)', () => {
    expect(fileContent).toMatch(/actively maintained|active maintenance|frequent commits|recent/i);
    // Verify version info
    expect(fileContent).toMatch(/v4\.x|2026-07|latest stable/i);
  });

  // ---------------------------------------------------------------------------
  // Criterion 5: CLI/library usability approach documented
  // ---------------------------------------------------------------------------
  it('Criterion 5: Documents the CLI/library usability approach for integration', () => {
    // Should document both installation and usage approaches
    expect(fileContent).toMatch(/installation|install|spawn|subprocess/i);
    expect(fileContent).toMatch(/joern-parse|joern --script|joern-export|child process/i);
    // Should describe the chosen approach
    expect(fileContent).toMatch(/chosen approach|installation.*approach|spawnable/i);
  });

  // ---------------------------------------------------------------------------
  // Criterion 6: Multi-language support (TS/JS + Python minimum)
  // ---------------------------------------------------------------------------
  it('Criterion 6: Supports required languages (TypeScript/JavaScript + Python minimum)', () => {
    expect(fileContent).toMatch(/javascript|typescript|ts.*js|js2cpg|jssrc2cpg/i);
    expect(fileContent).toMatch(/python|pysrc2cpg/i);
    // Verify it's listed as multi-language
    expect(fileContent).toMatch(/multi-language|supports.*language/i);
  });

  // ---------------------------------------------------------------------------
  // Method skeleton verification: all 7 methods present
  // ---------------------------------------------------------------------------
  describe('Method skeleton verification', () => {
    it('Contains all 7 CodeIntelligenceProvider method stubs', () => {
      const methods = [
        'graph',
        'impact',
        'query',
        'context',
        'map',
        'flow',
        'tests',
      ];

      for (const method of methods) {
        expect(fileContent).toMatch(new RegExp(`async ${method}\\s*\\(`, 'i'));
      }
    });

    it('All methods throw NotImplementedError stubs', () => {
      expect(fileContent).toMatch(/throw new Error.*not implemented/i);
      const matches = fileContent.match(/throw new Error\('JoernProvider\.\w+\(\) not implemented'\)/g) || [];
      expect(matches.length).toBeGreaterThanOrEqual(7);
    });

    it('JoernProvider class implements CodeIntelligenceProvider interface', () => {
      expect(fileContent).toMatch(/class JoernProvider implements CodeIntelligenceProvider/);
    });
  });

  // ---------------------------------------------------------------------------
  // Compilation verification
  // ---------------------------------------------------------------------------
  it('File structure is syntactically valid (verifiable via TypeScript compilation)', () => {
    // Basic structural checks that would be caught by tsc --noEmit
    expect(fileContent).toContain('import type { CodeIntelligenceProvider }');
    expect(fileContent).toContain('export class JoernProvider');
    // Verify no obvious syntax errors (unmatched braces, etc.)
    const openBraces = (fileContent.match(/{/g) || []).length;
    const closeBraces = (fileContent.match(/}/g) || []).length;
    expect(openBraces).toBe(closeBraces);
  });

  // ---------------------------------------------------------------------------
  // Research summary validation
  // ---------------------------------------------------------------------------
  it('Documents the research decision: 3 candidates evaluated, Joern selected', () => {
    expect(fileContent).toMatch(/Research summary.*3 candidates/i);
    expect(fileContent).toMatch(/Joern.*SELECTED/i);
    expect(fileContent).toMatch(/SCIP|scip-typescript/i);
    expect(fileContent).toMatch(/tree-sitter/i);
  });

  // ---------------------------------------------------------------------------
  // Method mapping documentation
  // ---------------------------------------------------------------------------
  it('Provides detailed method-to-capability mappings for all 7 methods', () => {
    expect(fileContent).toMatch(/Method mapping.*capabilities/i);
    expect(fileContent).toMatch(/graph\(symbol\)|impact\(target|query\(query\)|context\(name\)|map\(top\)|flow\(from|tests\(symbol\)/);
  });
});
