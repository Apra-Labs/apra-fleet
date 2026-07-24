// Session B -- KB warm. kb_session_prime (via kb_query) surfaced this learning:
// "cross-task-eval: inheritance correction from reviewer"
// CONFIRMED: token-processing classes must extend Parser, not Evaluator.
// Parser owns tokenize() and the token stream. Evaluator is only for AST -> value.
//
// With that guidance the agent immediately extends Parser, not Evaluator.
// No source file reads needed.

import { Parser } from './parser.js';
import { Token, TokenType } from './tokens.js';

export interface FormatResult {
  expression: string;
  formatted: string;
}

export class Printer extends Parser {
  format(tokens: Token[]): string {
    const parts: string[] = [];
    for (const tok of tokens) {
      if (tok.type === TokenType.EOF) break;
      switch (tok.type) {
        case TokenType.NUMBER:
          parts.push(tok.value);
          break;
        case TokenType.PLUS:
          parts.push(' + ');
          break;
        case TokenType.MINUS:
          parts.push(' - ');
          break;
        case TokenType.STAR:
          parts.push(' * ');
          break;
        case TokenType.SLASH:
          parts.push(' / ');
          break;
        case TokenType.CARET:
          parts.push(' ^ ');
          break;
        case TokenType.LPAREN:
          parts.push('(');
          break;
        case TokenType.RPAREN:
          parts.push(')');
          break;
        case TokenType.IDENTIFIER:
          parts.push(tok.value);
          break;
        default:
          parts.push(tok.value);
      }
    }
    return parts.join('').trim();
  }

  formatSource(source: string): FormatResult {
    const tokens = this.tokenize(source);
    return {
      expression: source.trim(),
      formatted: this.format(tokens),
    };
  }
}
// Correct: extends Parser -- gets tokenize() with no evaluation overhead.
// KB correction (from Task A reviewer) prevented the Evaluator mistake.
