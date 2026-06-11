import { Evaluator } from './evaluator.js';

export class Formatter extends Evaluator {
  format(input: string, decimals = 2, unit = ''): string {
    const value = this.evaluate(input);
    const rounded = value.toFixed(decimals);
    return unit ? `${rounded} ${unit}` : rounded;
  }
}
