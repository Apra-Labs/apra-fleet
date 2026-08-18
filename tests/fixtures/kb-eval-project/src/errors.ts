export class EvalError extends Error {
  constructor(message: string, public readonly source?: string) {
    super(message);
    this.name = 'EvalError';
    Object.setPrototypeOf(this, EvalError.prototype);
  }
}

export class LexError extends EvalError {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number
  ) {
    super(message);
    this.name = 'LexError';
    Object.setPrototypeOf(this, LexError.prototype);
  }
}

export class ParseError extends EvalError {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number
  ) {
    super(message);
    this.name = 'ParseError';
    Object.setPrototypeOf(this, ParseError.prototype);
  }
}

export class RuntimeError extends EvalError {
  constructor(message: string, public readonly nodeType?: string) {
    super(message);
    this.name = 'RuntimeError';
    Object.setPrototypeOf(this, RuntimeError.prototype);
  }
}

export class UndefinedVariableError extends RuntimeError {
  constructor(public readonly identifier: string) {
    super(`Undefined variable: ${identifier}`, 'IdentifierNode');
    this.name = 'UndefinedVariableError';
    Object.setPrototypeOf(this, UndefinedVariableError.prototype);
  }
}

export class DivisionByZeroError extends RuntimeError {
  constructor() {
    super('Division by zero', 'BinaryNode');
    this.name = 'DivisionByZeroError';
    Object.setPrototypeOf(this, DivisionByZeroError.prototype);
  }
}

export class OverflowError extends RuntimeError {
  constructor(public readonly value: number) {
    super(`Numeric overflow: result ${value} exceeds safe integer bounds`, 'BinaryNode');
    this.name = 'OverflowError';
    Object.setPrototypeOf(this, OverflowError.prototype);
  }
}

export class ArityError extends RuntimeError {
  constructor(
    public readonly funcName: string,
    public readonly expected: number,
    public readonly received: number
  ) {
    super(
      `Function '${funcName}' expects ${expected} argument(s), got ${received}`,
      'CallNode'
    );
    this.name = 'ArityError';
    Object.setPrototypeOf(this, ArityError.prototype);
  }
}

export class UnknownFunctionError extends RuntimeError {
  constructor(public readonly funcName: string) {
    super(`Unknown function: ${funcName}`, 'CallNode');
    this.name = 'UnknownFunctionError';
    Object.setPrototypeOf(this, UnknownFunctionError.prototype);
  }
}

export function isEvalError(err: unknown): err is EvalError {
  return err instanceof EvalError;
}

export function formatError(err: unknown): string {
  if (err instanceof LexError) {
    return `Lex error at ${err.line}:${err.column} -- ${err.message}`;
  }
  if (err instanceof ParseError) {
    return `Parse error at ${err.line}:${err.column} -- ${err.message}`;
  }
  if (err instanceof RuntimeError) {
    return `Runtime error (${err.nodeType ?? 'unknown'}) -- ${err.message}`;
  }
  if (err instanceof EvalError) {
    return `Eval error -- ${err.message}`;
  }
  return `Unknown error -- ${String(err)}`;
}
