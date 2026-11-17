import {
  Parser,
  ASTNode,
  NumberNode,
  IdentifierNode,
  UnaryNode,
  BinaryNode,
  CallNode,
} from './parser.js';
import {
  DivisionByZeroError,
  RuntimeError,
  UndefinedVariableError,
  OverflowError,
  ArityError,
  UnknownFunctionError,
} from './errors.js';

export type Environment = Map<string, number>;
export type BuiltinFn = (args: number[]) => number;

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const SAFE_MIN = Number.MIN_SAFE_INTEGER;

export const DEFAULT_BUILTINS: Record<string, BuiltinFn> = {
  abs: ([x]) => Math.abs(x),
  sqrt: ([x]) => Math.sqrt(x),
  ceil: ([x]) => Math.ceil(x),
  floor: ([x]) => Math.floor(x),
  round: ([x]) => Math.round(x),
  sin: ([x]) => Math.sin(x),
  cos: ([x]) => Math.cos(x),
  tan: ([x]) => Math.tan(x),
  log: ([x]) => Math.log(x),
  log2: ([x]) => Math.log2(x),
  log10: ([x]) => Math.log10(x),
  exp: ([x]) => Math.exp(x),
  max: (args) => Math.max(...args),
  min: (args) => Math.min(...args),
  pow: ([base, exp]) => Math.pow(base, exp),
  mod: ([a, b]) => ((a % b) + b) % b,
};

const BUILTIN_ARITIES: Record<string, number | null> = {
  abs: 1,
  sqrt: 1,
  ceil: 1,
  floor: 1,
  round: 1,
  sin: 1,
  cos: 1,
  tan: 1,
  log: 1,
  log2: 1,
  log10: 1,
  exp: 1,
  max: null,
  min: null,
  pow: 2,
  mod: 2,
};

export interface EvalOptions {
  checkOverflow?: boolean;
  maxDepth?: number;
}

export class Evaluator extends Parser {
  private environment: Environment = new Map();
  private builtins: Map<string, BuiltinFn> = new Map(
    Object.entries(DEFAULT_BUILTINS)
  );
  private depth = 0;

  setVariable(name: string, value: number): void {
    this.environment.set(name, value);
  }

  getVariable(name: string): number | undefined {
    return this.environment.get(name);
  }

  setVariables(vars: Record<string, number>): void {
    for (const [k, v] of Object.entries(vars)) {
      this.environment.set(k, v);
    }
  }

  clearVariables(): void {
    this.environment.clear();
  }

  registerBuiltin(name: string, fn: BuiltinFn): void {
    this.builtins.set(name, fn);
  }

  evaluate(source: string, opts: EvalOptions = {}): number {
    const ast = this.parse(source);
    this.depth = 0;
    return this.evalNode(ast, opts);
  }

  evaluateAst(ast: ASTNode, opts: EvalOptions = {}): number {
    this.depth = 0;
    return this.evalNode(ast, opts);
  }

  protected evalNode(node: ASTNode, opts: EvalOptions = {}): number {
    const maxDepth = opts.maxDepth ?? 200;

    if (this.depth > maxDepth) {
      throw new RuntimeError(`Maximum recursion depth (${maxDepth}) exceeded`, node.kind);
    }

    this.depth++;
    try {
      return this.dispatchNode(node, opts);
    } finally {
      this.depth--;
    }
  }

  private dispatchNode(node: ASTNode, opts: EvalOptions): number {
    if (node instanceof NumberNode) {
      return node.value;
    }

    if (node instanceof IdentifierNode) {
      const value = this.environment.get(node.name);
      if (value === undefined) {
        throw new UndefinedVariableError(node.name);
      }
      return value;
    }

    if (node instanceof UnaryNode) {
      const operand = this.evalNode(node.operand, opts);
      if (node.operator === '-') return -operand;
      throw new RuntimeError(`Unknown unary operator: ${node.operator}`, 'UnaryNode');
    }

    if (node instanceof BinaryNode) {
      return this.evalBinary(node, opts);
    }

    if (node instanceof CallNode) {
      return this.evalCall(node, opts);
    }

    throw new RuntimeError(`Unrecognized AST node kind: ${node.kind}`, node.kind);
  }

  private evalBinary(node: BinaryNode, opts: EvalOptions): number {
    const left = this.evalNode(node.left, opts);
    const right = this.evalNode(node.right, opts);
    let result: number;

    switch (node.operator) {
      case '+':
        result = left + right;
        break;
      case '-':
        result = left - right;
        break;
      case '*':
        result = left * right;
        break;
      case '/':
        if (right === 0) throw new DivisionByZeroError();
        result = left / right;
        break;
      case '%':
        if (right === 0) throw new DivisionByZeroError();
        result = left % right;
        break;
      case '^':
        result = Math.pow(left, right);
        break;
      default:
        throw new RuntimeError(
          `Unknown binary operator: ${node.operator}`,
          'BinaryNode'
        );
    }

    if (opts.checkOverflow && (result > SAFE_MAX || result < SAFE_MIN)) {
      throw new OverflowError(result);
    }

    return result;
  }

  private evalCall(node: CallNode, opts: EvalOptions): number {
    const fn = this.builtins.get(node.callee);
    if (!fn) {
      throw new UnknownFunctionError(node.callee);
    }

    const expectedArity = BUILTIN_ARITIES[node.callee];
    if (expectedArity !== null && expectedArity !== undefined) {
      if (node.args.length !== expectedArity) {
        throw new ArityError(node.callee, expectedArity, node.args.length);
      }
    }

    const evaledArgs = node.args.map(arg => this.evalNode(arg, opts));
    return fn(evaledArgs);
  }

  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [k, v] of this.environment) {
      result[k] = v;
    }
    return result;
  }
}
