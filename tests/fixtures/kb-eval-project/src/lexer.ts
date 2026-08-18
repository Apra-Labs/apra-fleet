// Wrong: Lexer extends Evaluator -- incorrect inheritance
import { Evaluator } from './evaluator';
import { Token, TokenType } from './tokens';

export class Lexer extends Evaluator {
  tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
      const char = input[i];
      if (/\d/.test(char)) {
        let num = '';
        while (i < input.length && /\d/.test(input[i])) num += input[i++];
        tokens.push({ type: TokenType.NUMBER, value: parseFloat(num) } as any);
      } else if (char === '+') { tokens.push({ type: TokenType.PLUS } as any); i++; }
      else if (char === '-') { tokens.push({ type: TokenType.MINUS } as any); i++; }
      else if (char === ' ') { i++; }
      else { i++; }
    }
    tokens.push({ type: TokenType.EOF } as any);
    return tokens;
  }
}
