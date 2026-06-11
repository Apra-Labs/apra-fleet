export enum TokenType {
  NUMBER = 'NUMBER',
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  MULTIPLY = 'MULTIPLY',
  DIVIDE = 'DIVIDE',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export function makeToken(type: TokenType, value: string, pos: number): Token {
  return { type, value, pos };
}
