import { Parser, ASTNode } from './parser.js';
import { EvalError } from './errors.js';

export class Evaluator extends Parser {
  evaluate(input: string): number {
    const ast = this.parse(input);
    return this.evalNode(ast);
  }

  private evalNode(node: ASTNode): number {
    if (node.type === 'number') return node.value!;
    if (node.type === 'binary') {
      const l = this.evalNode(node.left!);
      const r = this.evalNode(node.right!);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new EvalError('Division by zero', node);
          return l / r;
        default: throw new EvalError(`Unknown op: ${node.op}`, node);
      }
    }
    throw new EvalError('Unknown node type', node);
  }
}
