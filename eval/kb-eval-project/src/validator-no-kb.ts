// Session A -- no KB available.
// A fresh agent writing Validator without reading source files.
// The agent sees "Evaluator" as the most complete class in the chain
// and guesses that Validator should extend it.

import { Evaluator } from './evaluator.js';

// Wrong: Evaluator extends Parser. Validator does not need evaluate().
// But the agent has no way to know that Validator only needs tokenize(),
// which lives on Parser -- not Evaluator.
export class Validator extends Evaluator {
  validate(source: string): boolean {
    try {
      // Guess: parse() is somewhere up the chain, call evaluate() to check syntax.
      this.evaluate(source);
      return true;
    } catch {
      return false;
    }
  }

  getErrors(source: string): string[] {
    const errors: string[] = [];
    try {
      this.evaluate(source);
    } catch (err) {
      errors.push((err as Error).message);
    }
    return errors;
  }
}
// Problem: Validator inherits the full Evaluator (and its environment/builtins).
// It will silently accept undefined variables as parse errors -- misclassifying
// runtime errors as syntax errors. The class is too heavy.
