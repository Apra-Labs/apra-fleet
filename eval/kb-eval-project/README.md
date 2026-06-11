# kb-eval-project

A small expression evaluator for testing the KB memory plane.

## Conventions
- All classes are exported from src/index.ts
- Errors use classes from errors.ts (ParseError, EvalError)
- New processor classes should extend the class in the file they depend on most
- Tests live in tests/ and use vitest
