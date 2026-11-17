import { Evaluator, EvalOptions } from './evaluator.js';

export { EvalError, LexError, ParseError, RuntimeError } from './errors.js';
export { UndefinedVariableError, DivisionByZeroError, OverflowError, ArityError, UnknownFunctionError } from './errors.js';
export { formatError, isEvalError } from './errors.js';
export { TokenType, Lexer, lex, describeTokens } from './tokens.js';
export type { Token } from './tokens.js';
export { ASTNode, NumberNode, IdentifierNode, UnaryNode, BinaryNode, CallNode, Parser } from './parser.js';
export type { ParseResult } from './parser.js';
export { Evaluator, DEFAULT_BUILTINS } from './evaluator.js';
export type { Environment, BuiltinFn, EvalOptions } from './evaluator.js';

export function evaluate(
  expression: string,
  vars?: Record<string, number>,
  opts?: EvalOptions
): number {
  const ev = new Evaluator();
  if (vars) ev.setVariables(vars);
  return ev.evaluate(expression, opts);
}

export function evaluateSafe(
  expression: string,
  vars?: Record<string, number>,
  opts?: EvalOptions
): { ok: true; value: number } | { ok: false; error: string } {
  try {
    return { ok: true, value: evaluate(expression, vars, opts) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function evaluateAll(
  expressions: string[],
  vars?: Record<string, number>,
  opts?: EvalOptions
): Array<{ expression: string; value?: number; error?: string }> {
  const ev = new Evaluator();
  if (vars) ev.setVariables(vars);
  return expressions.map(expr => {
    try {
      return { expression: expr, value: ev.evaluate(expr, opts) };
    } catch (err) {
      return { expression: expr, error: (err as Error).message };
    }
  });
}

export interface ReplResult {
  line: number;
  input: string;
  value?: number;
  error?: string;
}

export function runRepl(
  lines: string[],
  initialVars?: Record<string, number>
): ReplResult[] {
  const ev = new Evaluator();
  if (initialVars) ev.setVariables(initialVars);
  const results: ReplResult[] = [];

  for (let i = 0; i < lines.length; i++) {
    const input = lines[i].trim();
    if (!input || input.startsWith('#')) {
      continue;
    }

    const assign = input.match(/^([a-zA-Z_][a-zA-Z_0-9]*)\s*=\s*(.+)$/);
    if (assign) {
      const [, name, expr] = assign;
      try {
        const value = ev.evaluate(expr);
        ev.setVariable(name, value);
        results.push({ line: i + 1, input, value });
      } catch (err) {
        results.push({ line: i + 1, input, error: (err as Error).message });
      }
      continue;
    }

    try {
      const value = ev.evaluate(input);
      results.push({ line: i + 1, input, value });
    } catch (err) {
      results.push({ line: i + 1, input, error: (err as Error).message });
    }
  }

  return results;
}
