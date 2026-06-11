import { ParseError } from './errors.js';

export class Validator {
  validate(input: string): void {
    this.checkValidChars(input);
    this.checkBalancedParens(input);
    this.checkConsecutiveOperators(input);
  }

  private checkValidChars(input: string): void {
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (!/[\d\s+\-*/().]/.test(ch)) {
        throw new ParseError(`Invalid character: ${ch}`, i, input);
      }
    }
  }

  private checkBalancedParens(input: string): void {
    let depth = 0;
    for (let i = 0; i < input.length; i++) {
      if (input[i] === '(') {
        depth++;
      } else if (input[i] === ')') {
        depth--;
        if (depth < 0) throw new ParseError('Unmatched closing parenthesis', i, input);
      }
    }
    if (depth !== 0) throw new ParseError('Unmatched opening parenthesis', input.length - 1, input);
  }

  private checkConsecutiveOperators(input: string): void {
    for (let i = 0; i < input.length; i++) {
      if (/[+\-*/]/.test(input[i])) {
        let j = i + 1;
        while (j < input.length && /\s/.test(input[j])) j++;
        if (j < input.length && /[+\-*/]/.test(input[j])) {
          throw new ParseError('Consecutive operators', i, input);
        }
      }
    }
  }
}
