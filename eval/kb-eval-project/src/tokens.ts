import { LexError } from './errors.js';

export enum TokenType {
  NUMBER = 'NUMBER',
  IDENTIFIER = 'IDENTIFIER',
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  STAR = 'STAR',
  SLASH = 'SLASH',
  PERCENT = 'PERCENT',
  CARET = 'CARET',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  COMMA = 'COMMA',
  EOF = 'EOF',
}

export const OPERATOR_CHARS: Record<string, TokenType> = {
  '+': TokenType.PLUS,
  '-': TokenType.MINUS,
  '*': TokenType.STAR,
  '/': TokenType.SLASH,
  '%': TokenType.PERCENT,
  '^': TokenType.CARET,
  '(': TokenType.LPAREN,
  ')': TokenType.RPAREN,
  ',': TokenType.COMMA,
};

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

export function makeToken(
  type: TokenType,
  value: string,
  line: number,
  column: number
): Token {
  return { type, value, line, column };
}

export function isNumberToken(tok: Token): boolean {
  return tok.type === TokenType.NUMBER;
}

export function isIdentifierToken(tok: Token): boolean {
  return tok.type === TokenType.IDENTIFIER;
}

export function isOperatorToken(tok: Token): boolean {
  return tok.type in OPERATOR_CHARS;
}

export function tokenTypeToSymbol(type: TokenType): string {
  const reverse: Partial<Record<TokenType, string>> = {};
  for (const [sym, t] of Object.entries(OPERATOR_CHARS)) {
    reverse[t] = sym;
  }
  return reverse[type] ?? type.toLowerCase();
}

export class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;
  private readonly len: number;

  constructor(private readonly source: string) {
    this.len = source.length;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.len) {
      this.skipWhitespace();
      if (this.pos >= this.len) break;
      const tok = this.nextToken();
      if (tok !== null) tokens.push(tok);
    }
    tokens.push(makeToken(TokenType.EOF, '', this.line, this.column));
    return tokens;
  }

  private skipWhitespace(): void {
    while (this.pos < this.len) {
      const ch = this.source[this.pos];
      if (ch === '\n') {
        this.line++;
        this.column = 1;
        this.pos++;
      } else if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.column++;
        this.pos++;
      } else {
        break;
      }
    }
  }

  private peek(offset = 0): string {
    return this.source[this.pos + offset] ?? '';
  }

  private advance(): string {
    const ch = this.source[this.pos];
    this.pos++;
    this.column++;
    return ch;
  }

  private nextToken(): Token | null {
    const ch = this.peek();
    const startLine = this.line;
    const startCol = this.column;

    if (/\d/.test(ch) || (ch === '.' && /\d/.test(this.peek(1)))) {
      return this.readNumber(startLine, startCol);
    }

    if (/[a-zA-Z_]/.test(ch)) {
      return this.readIdentifier(startLine, startCol);
    }

    if (ch in OPERATOR_CHARS) {
      this.advance();
      return makeToken(OPERATOR_CHARS[ch], ch, startLine, startCol);
    }

    throw new LexError(
      `Unexpected character '${ch}' (code ${ch.charCodeAt(0)})`,
      this.line,
      this.column
    );
  }

  private readNumber(line: number, col: number): Token {
    let value = '';
    let hasDot = false;
    let hasExp = false;

    while (this.pos < this.len) {
      const ch = this.peek();
      if (/\d/.test(ch)) {
        value += this.advance();
      } else if (ch === '.' && !hasDot && !hasExp) {
        hasDot = true;
        value += this.advance();
      } else if ((ch === 'e' || ch === 'E') && !hasExp && value.length > 0) {
        hasExp = true;
        value += this.advance();
        if (this.peek() === '+' || this.peek() === '-') {
          value += this.advance();
        }
      } else {
        break;
      }
    }

    return makeToken(TokenType.NUMBER, value, line, col);
  }

  private readIdentifier(line: number, col: number): Token {
    let value = '';
    while (this.pos < this.len && /[a-zA-Z_0-9]/.test(this.peek())) {
      value += this.advance();
    }
    return makeToken(TokenType.IDENTIFIER, value, line, col);
  }

  getPosition(): { line: number; column: number } {
    return { line: this.line, column: this.column };
  }
}

export function lex(source: string): Token[] {
  return new Lexer(source).tokenize();
}

export function describeTokens(tokens: Token[]): string {
  return tokens
    .map(t => `${t.type}(${JSON.stringify(t.value)})@${t.line}:${t.column}`)
    .join(' ');
}
