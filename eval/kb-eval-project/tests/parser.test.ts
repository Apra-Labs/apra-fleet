import { describe, it, expect } from 'vitest';
import { Parser } from '../src/parser.js';
import { Evaluator } from '../src/evaluator.js';
import { ParseError } from '../src/errors.js';

describe('Parser', () => {
  const p = new Parser();
  it('parses a number', () => expect(p.parse('42')).toEqual({ type: 'number', value: 42 }));
  it('parses addition', () => expect(p.parse('1+2').type).toBe('binary'));
  it('throws on unknown char', () => expect(() => p.parse('1@2')).toThrow(ParseError));
});

describe('Evaluator', () => {
  const e = new Evaluator();
  it('evaluates simple expr', () => expect(e.evaluate('2+3*4')).toBe(14));
  it('respects parens', () => expect(e.evaluate('(2+3)*4')).toBe(20));
  it('throws on div by zero', () => expect(() => e.evaluate('1/0')).toThrow());
});
