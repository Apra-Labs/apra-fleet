// Session A -- no KB available.
// A fresh agent writing Printer without reading source files.
// The agent sees "Printer evaluates and then prints" -- guesses Evaluator is the right base.

import { Evaluator } from './evaluator.js';

// Wrong: extends Evaluator -- pulls in the full evaluation engine just to format output.
// The agent has no way to know Printer only needs tokenize() from Parser.
export class Printer extends Evaluator {
  print(source: string): string {
    try {
      const result = this.evaluate(source);
      return `Result: ${result}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }

  format(source: string): string {
    try {
      const result = this.evaluate(source);
      return `${source} = ${result}`;
    } catch {
      return source;
    }
  }
}
// Problem: Printer inherits the full Evaluator (environment, builtins, depth tracking).
// It cannot format tokens -- it can only evaluate and show results.
// Formatting a token stream requires Parser.tokenize(), not Evaluator.evaluate().
