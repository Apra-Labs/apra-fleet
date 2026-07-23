// Session B -- KB warm. kb_session_prime returned this learning in top_entries:
// "new processor classes must extend the class they depend on most --
//  Validator needs tokenize() from Parser, so it extends Parser, not Evaluator."
//
// With that guidance the agent immediately extends Parser, not Evaluator.
// No source file reads needed.

import { Parser } from './parser.js';
import { ParseError, LexError } from './errors.js';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  message: string;
  line: number;
  column: number;
  kind: 'lex' | 'parse' | 'unknown';
}

export class Validator extends Parser {
  validate(source: string): ValidationResult {
    const errors: ValidationError[] = [];
    try {
      this.parse(source);
    } catch (err) {
      if (err instanceof LexError) {
        errors.push({ message: err.message, line: err.line, column: err.column, kind: 'lex' });
      } else if (err instanceof ParseError) {
        errors.push({ message: err.message, line: err.line, column: err.column, kind: 'parse' });
      } else {
        errors.push({ message: (err as Error).message, line: 0, column: 0, kind: 'unknown' });
      }
    }
    return { valid: errors.length === 0, errors };
  }

  isValid(source: string): boolean {
    return this.validate(source).valid;
  }

  tokenizeOnly(source: string): ReturnType<Parser['tokenize']> {
    return this.tokenize(source);
  }
}
// Correct: extends Parser -- gets tokenize() and parse() with no runtime baggage.
// LexError and ParseError carry line/column for precise user feedback.
