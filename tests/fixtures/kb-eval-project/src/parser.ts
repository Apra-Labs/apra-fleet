import { Lexer, Token, TokenType } from './tokens.js';
import { ParseError } from './errors.js';

export abstract class ASTNode {
  abstract readonly kind: string;
  abstract toString(): string;
}

export class NumberNode extends ASTNode {
  readonly kind = 'NumberNode' as const;

  constructor(public readonly value: number) {
    super();
  }

  toString(): string {
    return String(this.value);
  }
}

export class IdentifierNode extends ASTNode {
  readonly kind = 'IdentifierNode' as const;

  constructor(public readonly name: string) {
    super();
  }

  toString(): string {
    return this.name;
  }
}

export class UnaryNode extends ASTNode {
  readonly kind = 'UnaryNode' as const;

  constructor(
    public readonly operator: '-',
    public readonly operand: ASTNode
  ) {
    super();
  }

  toString(): string {
    return `(${this.operator}${this.operand})`;
  }
}

export class BinaryNode extends ASTNode {
  readonly kind = 'BinaryNode' as const;

  constructor(
    public readonly operator: '+' | '-' | '*' | '/' | '%' | '^',
    public readonly left: ASTNode,
    public readonly right: ASTNode
  ) {
    super();
  }

  toString(): string {
    return `(${this.left} ${this.operator} ${this.right})`;
  }
}

export class CallNode extends ASTNode {
  readonly kind = 'CallNode' as const;

  constructor(
    public readonly callee: string,
    public readonly args: ASTNode[]
  ) {
    super();
  }

  toString(): string {
    return `${this.callee}(${this.args.map(a => a.toString()).join(', ')})`;
  }
}

export interface ParseResult {
  ast: ASTNode;
  tokens: Token[];
  tokenCount: number;
}

export class Parser {
  protected tokens: Token[] = [];
  protected pos = 0;

  tokenize(source: string): Token[] {
    const lexer = new Lexer(source);
    return lexer.tokenize();
  }

  parse(source: string): ASTNode {
    this.tokens = this.tokenize(source);
    this.pos = 0;

    if (this.current().type === TokenType.EOF) {
      throw new ParseError('Empty expression', 1, 1);
    }

    const node = this.parseExpression();
    const remaining = this.current();

    if (remaining.type !== TokenType.EOF) {
      throw new ParseError(
        `Unexpected token '${remaining.value}' after expression`,
        remaining.line,
        remaining.column
      );
    }

    return node;
  }

  parseWithMeta(source: string): ParseResult {
    const tokens = this.tokenize(source);
    this.tokens = tokens;
    this.pos = 0;
    const ast = this.parseExpression();
    return { ast, tokens, tokenCount: tokens.length };
  }

  protected current(): Token {
    return (
      this.tokens[this.pos] ?? {
        type: TokenType.EOF,
        value: '',
        line: 0,
        column: 0,
      }
    );
  }

  protected peek(offset = 1): Token {
    return (
      this.tokens[this.pos + offset] ?? {
        type: TokenType.EOF,
        value: '',
        line: 0,
        column: 0,
      }
    );
  }

  protected consume(expectedType?: TokenType): Token {
    const tok = this.tokens[this.pos];
    if (!tok) {
      throw new ParseError('Unexpected end of input', 0, 0);
    }
    if (expectedType !== undefined && tok.type !== expectedType) {
      throw new ParseError(
        `Expected ${expectedType}, got ${tok.type} ('${tok.value}')`,
        tok.line,
        tok.column
      );
    }
    this.pos++;
    return tok;
  }

  protected parseExpression(): ASTNode {
    return this.parseAddSub();
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();

    while (
      this.current().type === TokenType.PLUS ||
      this.current().type === TokenType.MINUS
    ) {
      const op = this.consume().value as '+' | '-';
      const right = this.parseMulDiv();
      left = new BinaryNode(op, left, right);
    }

    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parsePower();

    while (
      this.current().type === TokenType.STAR ||
      this.current().type === TokenType.SLASH ||
      this.current().type === TokenType.PERCENT
    ) {
      const op = this.consume().value as '*' | '/' | '%';
      const right = this.parsePower();
      left = new BinaryNode(op, left, right);
    }

    return left;
  }

  private parsePower(): ASTNode {
    const left = this.parseUnary();

    if (this.current().type === TokenType.CARET) {
      this.consume();
      const right = this.parsePower();
      return new BinaryNode('^', left, right);
    }

    return left;
  }

  private parseUnary(): ASTNode {
    if (this.current().type === TokenType.MINUS) {
      this.consume();
      const operand = this.parseUnary();
      return new UnaryNode('-', operand);
    }

    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    const tok = this.current();

    if (tok.type === TokenType.NUMBER) {
      this.consume();
      return new NumberNode(parseFloat(tok.value));
    }

    if (tok.type === TokenType.IDENTIFIER) {
      this.consume();
      if (this.current().type === TokenType.LPAREN) {
        return this.parseCall(tok.value);
      }
      return new IdentifierNode(tok.value);
    }

    if (tok.type === TokenType.LPAREN) {
      this.consume();
      const expr = this.parseExpression();
      this.consume(TokenType.RPAREN);
      return expr;
    }

    throw new ParseError(
      `Unexpected token '${tok.value}' (type: ${tok.type})`,
      tok.line,
      tok.column
    );
  }

  private parseCall(callee: string): CallNode {
    this.consume(TokenType.LPAREN);
    const args: ASTNode[] = [];

    if (this.current().type !== TokenType.RPAREN) {
      args.push(this.parseExpression());
      while (this.current().type === TokenType.COMMA) {
        this.consume();
        args.push(this.parseExpression());
      }
    }

    this.consume(TokenType.RPAREN);
    return new CallNode(callee, args);
  }

  getTokens(): Token[] {
    return [...this.tokens];
  }
}
