import { Token, TokenType, makeToken } from './tokens.js';
import { ParseError } from './errors.js';

export interface ASTNode {
  type: 'number' | 'binary';
  value?: number;
  op?: string;
  left?: ASTNode;
  right?: ASTNode;
}

export class Parser {
  protected tokens: Token[] = [];
  protected pos = 0;

  protected tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/\d/.test(ch)) {
        let num = '';
        const start = i;
        while (i < input.length && /[\d.]/.test(input[i])) num += input[i++];
        tokens.push(makeToken(TokenType.NUMBER, num, start));
        continue;
      }
      const map: Record<string, TokenType> = {
        '+': TokenType.PLUS, '-': TokenType.MINUS,
        '*': TokenType.MULTIPLY, '/': TokenType.DIVIDE,
        '(': TokenType.LPAREN, ')': TokenType.RPAREN,
      };
      if (map[ch]) { tokens.push(makeToken(map[ch], ch, i++)); continue; }
      throw new ParseError(`Unknown character: ${ch}`, i, input);
    }
    tokens.push(makeToken(TokenType.EOF, '', i));
    return tokens;
  }

  protected current(): Token { return this.tokens[this.pos]; }
  protected consume(type?: TokenType): Token {
    const t = this.tokens[this.pos];
    if (type && t.type !== type) throw new ParseError(`Expected ${type} got ${t.type}`, t.pos, '');
    this.pos++;
    return t;
  }

  parse(input: string): ASTNode {
    this.tokens = this.tokenize(input);
    this.pos = 0;
    return this.parseExpr();
  }

  private parseExpr(): ASTNode { return this.parseAdd(); }
  private parseAdd(): ASTNode {
    let left = this.parseMul();
    while ([TokenType.PLUS, TokenType.MINUS].includes(this.current().type)) {
      const op = this.consume().value;
      left = { type: 'binary', op, left, right: this.parseMul() };
    }
    return left;
  }
  private parseMul(): ASTNode {
    let left = this.parsePrimary();
    while ([TokenType.MULTIPLY, TokenType.DIVIDE].includes(this.current().type)) {
      const op = this.consume().value;
      left = { type: 'binary', op, left, right: this.parsePrimary() };
    }
    return left;
  }
  private parsePrimary(): ASTNode {
    if (this.current().type === TokenType.LPAREN) {
      this.consume(TokenType.LPAREN);
      const node = this.parseExpr();
      this.consume(TokenType.RPAREN);
      return node;
    }
    return { type: 'number', value: parseFloat(this.consume(TokenType.NUMBER).value) };
  }
}
