import { Parser } from './parser.js';
import { ParseError } from './errors.js';

export class Validator extends Parser {
  validate(input: string): { valid: boolean; error?: string } {
    try {
      this.parse(input);
      return { valid: true };
    } catch (e) {
      if (e instanceof ParseError) {
        return { valid: false, error: e.message };
      }
      return { valid: false, error: String(e) };
    }
  }
}
