export class ParseError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
    public readonly input: string
  ) {
    super(`ParseError at pos ${pos}: ${message} in "${input}"`);
    this.name = 'ParseError';
  }
}

export class EvalError extends Error {
  constructor(message: string, public readonly node: unknown) {
    super(`EvalError: ${message}`);
    this.name = 'EvalError';
  }
}
