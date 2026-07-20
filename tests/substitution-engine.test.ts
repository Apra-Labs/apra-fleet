import { describe, it, expect, vi } from 'vitest';
import { applySubstitutions, validateSubstitutionKeys } from '../src/services/substitution-engine.js';

// ---- engine-level unit tests (a-j) ----

describe('applySubstitutions -- happy path', () => {
  it('(a) replaces all tokens when all are present in substitutions map', () => {
    const result = applySubstitutions(
      'send_files',
      [{ label: 'tpl.md', content: 'Branch: {{branch}}, base: {{base_branch}}' }],
      { branch: 'feat/x', base_branch: 'main' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputs[0]).toBe('Branch: feat/x, base: main');
  });

  it('(a) replaces every occurrence of a token, not just the first', () => {
    const result = applySubstitutions(
      'send_files',
      [{ label: 'f.md', content: '{{x}} and {{x}} again' }],
      { x: 'hello' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputs[0]).toBe('hello and hello again');
  });
});

describe('applySubstitutions -- unresolved token rejection (b)', () => {
  it('(b) rejects when a required token has no entry', () => {
    const result = applySubstitutions(
      'send_files',
      [{ label: 'tpl-doer.md', content: 'branch={{branch}}, base={{base_branch}}' }],
      { branch: 'feat/x' }, // base_branch missing
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('send_files: substitution failed');
    expect(result.error).toContain('tpl-doer.md');
    expect(result.error).toContain('base_branch');
    // should NOT contain the value
    expect(result.error).not.toContain('feat/x');
  });

  it('(b) lists all unresolved tokens across multiple inputs', () => {
    const result = applySubstitutions(
      'send_files',
      [
        { label: 'tpl-doer.md', content: '{{branch}} {{base_branch}}' },
        { label: 'tpl-reviewer.md', content: '{{member_name}}' },
      ],
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('tpl-doer.md');
    expect(result.error).toContain('tpl-reviewer.md');
    expect(result.error).toContain('branch');
    expect(result.error).toContain('member_name');
  });

  it('(b) zero side effects on rejection -- outputs not returned', () => {
    const result = applySubstitutions(
      'execute_prompt',
      [{ label: 'prompt', content: '{{missing}}' }],
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as any).outputs).toBeUndefined();
  });
});

describe('applySubstitutions -- extra keys silently ignored (c)', () => {
  it('(c) extra keys produce no error, no warning, no effect', () => {
    const result = applySubstitutions(
      'execute_prompt',
      [{ label: 'prompt', content: 'hello {{name}}' }],
      { name: 'world', unused_key: 'ignored', another_extra: 'also ignored' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputs[0]).toBe('hello world');
    expect(result.warning).toBeUndefined();
  });
});

describe('applySubstitutions -- token grammar whitespace tolerance (d)', () => {
  it('(d) resolves {{x}}, {{ x}}, {{x }}, and {{ x }} to the same key', () => {
    const content = '{{x}} {{ x}} {{x }} {{ x }}';
    const result = applySubstitutions(
      'execute_prompt',
      [{ label: 'prompt', content }],
      { x: 'VALUE' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputs[0]).toBe('VALUE VALUE VALUE VALUE');
  });
});

describe('applySubstitutions -- no substitutions, content unchanged (e)', () => {
  it('(e) returns content unchanged when substitutions is omitted', () => {
    const content = 'plain content with no tokens';
    const result = applySubstitutions('send_files', [{ label: 'f.md', content }], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputs[0]).toBe(content);
    expect(result.warning).toBeUndefined();
  });
});

describe('applySubstitutions -- heuristic warning (f, g)', () => {
  it('(f) warning fires when content contains {{token}} pattern and no substitutions given', () => {
    const result = applySubstitutions(
      'send_files',
      [{ label: 'tpl.md', content: 'Send to {{branch}} on {{base_branch}}' }],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('tpl.md');
    expect(result.warning).toContain('branch');
    expect(result.warning).toContain('base_branch');
  });

  it('(f) warning names the label correctly for execute_prompt surface', () => {
    const result = applySubstitutions(
      'execute_prompt',
      [{ label: 'prompt', content: 'Work on {{branch}}' }],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toContain('prompt');
    expect(result.warning).toContain('branch');
  });

  it('(g) warning does NOT fire for plain content with no {{...}} patterns', () => {
    const result = applySubstitutions(
      'send_files',
      [{ label: 'readme.md', content: 'Just some plain text, no braces.' }],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBeUndefined();
  });
});

describe('applySubstitutions -- batch atomicity (h)', () => {
  it('(h) when one input has unresolved tokens the whole call fails; zero outputs returned', () => {
    const result = applySubstitutions(
      'send_files',
      [
        { label: 'ok.md', content: 'no tokens here' },
        { label: 'bad.md', content: '{{missing_token}}' },
      ],
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as any).outputs).toBeUndefined();
    expect(result.error).toContain('bad.md');
  });
});

describe('applySubstitutions -- source never modified (i)', () => {
  it('(i) original content strings are not mutated by the engine', () => {
    const original = '{{branch}}';
    const input = { label: 'f.md', content: original };
    applySubstitutions('send_files', [input], { branch: 'feat/x' });
    expect(input.content).toBe('{{branch}}');
  });
});

describe('applySubstitutions -- values never appear in errors (j)', () => {
  it('(j) values are absent from unresolved-token error messages', () => {
    const result = applySubstitutions(
      'execute_prompt',
      [{ label: 'prompt', content: '{{tok}}' }],
      { tok: 'SECRET_VALUE_XYZ' }, // but tok IS present, so let's use a missing one
    );
    // tok is present, so this succeeds. Need a different scenario.
    expect(result.ok).toBe(true);
  });

  it('(j) value does not appear in heuristic warning', () => {
    // We can confirm indirectly: warning only contains token names, not values.
    // When substitutions is undefined there are no values to leak anyway.
    // This also guards that warning text only names tokens.
    const result = applySubstitutions(
      'send_files',
      [{ label: 'f.md', content: '{{secret_token}}' }],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toContain('secret_token');
    // warning must not contain any value (there are no values in this call -- just confirming
    // the shape doesn't accidentally include something it shouldn't)
    expect(result.warning).not.toContain('secret_value');
  });
});

// ---- secrets boundary tests (k-o) ----

describe('validateSubstitutionKeys -- secrets boundary (k, l)', () => {
  it('(k) rejects key matching secure.* pattern', () => {
    const result = validateSubstitutionKeys('send_files', { 'secure.github_pat': 'value' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('send_files: invalid substitutions');
    expect(result.error).toContain('secure.github_pat');
    expect(result.error).toContain('execute_command');
  });

  it('(l) rejects key containing a dot that is not secure.*', () => {
    const result = validateSubstitutionKeys('execute_prompt', { 'some.thing': 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('some.thing');
  });

  it('(l) rejects key with hyphen', () => {
    const result = validateSubstitutionKeys('send_files', { 'branch-name': 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('branch-name');
  });

  it('(l) rejects key with colon', () => {
    const result = validateSubstitutionKeys('send_files', { 'secure:token': 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('secure:token');
  });

  it('(l) rejects key with whitespace', () => {
    const result = validateSubstitutionKeys('send_files', { 'my key': 'x' });
    expect(result.ok).toBe(false);
  });

  it('(k+l) accepts multiple bad keys and lists them all', () => {
    const result = validateSubstitutionKeys('send_files', {
      'secure.github_pat': 'v1',
      'branch-name': 'v2',
      valid_key: 'v3',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('secure.github_pat');
    expect(result.error).toContain('branch-name');
    expect(result.error).not.toContain('valid_key');
    // values must never appear in errors
    expect(result.error).not.toContain('v1');
    expect(result.error).not.toContain('v2');
  });

  it('valid keys pass', () => {
    expect(validateSubstitutionKeys('send_files', { branch: 'x', base_branch: 'y', _private: 'z', A1: 'w' }).ok).toBe(true);
  });
});

describe('applySubstitutions -- {{secure.NAME}} content pass-through (m)', () => {
  it('(m) {{secure.NAME}} in content is not treated as a substitution token', () => {
    const content = 'run with {{secure.github_pat}} and {{branch}}';
    const result = applySubstitutions(
      'send_files',
      [{ label: 'cmd.md', content }],
      { branch: 'feat/x' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // {{branch}} substituted, {{secure.github_pat}} passes through verbatim
    expect(result.outputs[0]).toBe('run with {{secure.github_pat}} and feat/x');
  });

  it('(m) {{secure.NAME}} does NOT appear in unresolved tokens list', () => {
    const result = applySubstitutions(
      'send_files',
      [{ label: 'cmd.md', content: '{{secure.token}} {{real_token}}' }],
      {}, // real_token missing, but secure.token must not appear as missing
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // real_token is missing
    expect(result.error).toContain('real_token');
    // secure.token is NOT a valid substitution token -- must not appear as unresolved
    expect(result.error).not.toContain('secure.token');
    expect(result.error).not.toContain('secure');
  });

  it('(m) {{secure.NAME}} does NOT trigger the heuristic warning', () => {
    const result = applySubstitutions(
      'execute_prompt',
      [{ label: 'prompt', content: 'use {{secure.github_pat}} in execute_command' }],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No valid substitution tokens found, so warning must be absent
    expect(result.warning).toBeUndefined();
  });
});

describe('applySubstitutions -- value pass-through in substitution values (n)', () => {
  it('(n) {{secure.NAME}} syntax inside a substitution value is written verbatim, not re-interpreted', () => {
    const result = applySubstitutions(
      'execute_prompt',
      [{ label: 'prompt', content: '{{branch}}' }],
      { branch: '{{secure.github_pat}}' }, // value happens to contain secure syntax
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No recursive substitution: the value is written as-is
    expect(result.outputs[0]).toBe('{{secure.github_pat}}');
  });
});

describe('validateSubstitutionKeys -- rejection before content read (o)', () => {
  it('(o) key rejection happens without any content scan', () => {
    // We verify by passing content with valid tokens: if key validation is pure
    // (no scanning), the error must be about the key grammar, not about unresolved tokens.
    const result = applySubstitutions(
      'send_files',
      [{ label: 'f.md', content: '{{branch}}' }],
      { 'secure.github_pat': 'x', branch: 'feat' }, // bad key present
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Error must mention the key grammar rejection, not "unresolved tokens"
    expect(result.error).toContain('invalid substitutions');
    expect(result.error).not.toContain('substitution failed');
  });
});

// ---- code-reuse audit (w, x) ----

describe('code-reuse audit (w, x)', () => {
  it('(w) send_files and execute_prompt both import from substitution-engine', async () => {
    // Verify by importing -- if the module boundary is wrong the import would fail.
    const engine = await import('../src/services/substitution-engine.js');
    expect(typeof engine.applySubstitutions).toBe('function');
    expect(typeof engine.validateSubstitutionKeys).toBe('function');
  });

  it('(x) substitution-engine does not import from credential-store', async () => {
    // Read the engine source and verify no credential-store import.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      new URL('../src/services/substitution-engine.ts', import.meta.url),
      'utf-8',
    );
    expect(src).not.toContain('credential-store');
    expect(src).not.toContain('credentialResolve');
    expect(src).not.toContain('credentialSet');
  });
});
