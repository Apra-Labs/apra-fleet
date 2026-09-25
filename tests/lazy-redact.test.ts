import { describe, it, expect } from 'vitest';
import { detectSecrets } from '../src/lazy/detect.js';
import { Redactor, SseRestorer, SYSTEM_NOTE, placeholder } from '../src/lazy/redact.js';
import type { KnownSecret, Origin, VaultLike } from '../src/lazy/vault.js';

class MemVault implements VaultLike {
  items: KnownSecret[] = [];
  entries() {
    return [...this.items].sort((a, b) => b.value.length - a.value.length);
  }
  valueOf(name: string) {
    return this.items.find(i => i.name === name)?.value;
  }
  remember(kind: string, value: string, _origin: Origin) {
    const hit = this.items.find(i => i.value === value);
    if (hit) return hit.name;
    let name = kind;
    for (let n = 2; this.items.some(i => i.name === name); n++) name = `${kind}_${n}`;
    this.items.push({ name, value });
    return name;
  }
  touch() {}
}

const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';

function spans(text: string, mode: 'user' | 'tool' = 'user') {
  return detectSecrets(text, mode).map(f => text.slice(f.start, f.end));
}

describe('detectSecrets', () => {
  it('finds provider-format keys anywhere', () => {
    expect(spans(`use ${GH} please`, 'tool')).toEqual([GH]);
    expect(spans(`export AWS_ACCESS_KEY_ID=${AWS}`, 'tool')).toEqual([AWS]);
    expect(spans('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'tool')).toEqual(['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123']);
  });

  it('finds whole private key blocks', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(spans(`here:\n${key}\nthanks`, 'tool')).toEqual([key]);
  });

  it('finds context assignments and URL passwords', () => {
    expect(spans('DB_PASSWORD=hunter22\nDB_HOST=localhost', 'tool')).toEqual(['hunter22']);
    expect(spans('"apiKey": "q8Zr!x0w"', 'tool')).toEqual(['q8Zr!x0w']);
    expect(spans('postgres://admin:S3cretPass@db.internal:5432/app', 'tool')).toEqual(['S3cretPass']);
  });

  it('ignores code references and placeholders', () => {
    expect(spans('const token = getToken();', 'tool')).toEqual([]);
    expect(spans('password: string;', 'tool')).toEqual([]);
    expect(spans('apiKey = config.apiKey', 'tool')).toEqual([]);
    expect(spans('TOKEN=${GITHUB_TOKEN}', 'tool')).toEqual([]);
    expect(spans('token={{secure.github_token}}', 'tool')).toEqual([]);
  });

  it('understands phrases and the explicit marker in chat only', () => {
    expect(spans('my password is correcthorse9')).toEqual(['correcthorse9']);
    expect(spans('secret: plainwords')).toEqual(['plainwords']);
    expect(spans('secret: plainwords', 'tool')).toEqual([]);
  });

  it('catches random-looking pasted strings in chat but not hashes or paths', () => {
    const rnd = 'Xq7vT2mK9pL4wR8zN3bY6cF1';
    expect(spans(`the key: ${rnd}`)).toEqual([rnd]);
    expect(spans(`here ${rnd} ok`, 'tool')).toEqual([]);
    expect(spans('commit 9fceb02d0ae598e95dc970b74767f19372d61af8')).toEqual([]);
    expect(spans('see /home/user/projects/app/src/components/Button.tsx')).toEqual([]);
    expect(spans('cwd /tmp/claude-1000/-home-vbvnyk-Documents-repos-apra-fleet/4dd8f1f5-87cb-40ab-9686-d0d50071caaa/scratchpad')).toEqual([]);
    expect(spans('use my-Service_v2.Config-Loader3000.example')).toEqual([]);
  });
});

describe('Redactor.scrubRequest', () => {
  it('replaces a pasted secret in chat and adds the system note', () => {
    const v = new MemVault();
    const r = new Redactor(v);
    const out = r.scrubRequest({
      system: [{ type: 'text', text: 'You are Claude Code' }],
      messages: [{ role: 'user', content: `push with ${GH}` }],
    });
    expect(out.body.messages[0].content).toBe(`push with ${placeholder('github_token')}`);
    expect(JSON.stringify(out.body)).not.toContain(GH);
    expect(out.body.system.at(-1).text).toBe(SYSTEM_NOTE);
    expect(out.events).toContainEqual({ name: 'github_token', kind: 'new', origin: 'chat' });
  });

  it('scrubs known values everywhere, including restored tool calls and system text', () => {
    const v = new MemVault();
    v.items.push({ name: 'db_pass', value: 'hunter22-long' });
    const r = new Redactor(v);
    const out = r.scrubRequest({
      system: 'ctx hunter22-long',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'psql -p hunter22-long' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'auth ok hunter22-long' }] }] },
      ],
    });
    expect(JSON.stringify(out.body)).not.toContain('hunter22-long');
    expect(out.body.messages[0].content[0].input.command).toBe('psql -p {{secure.db_pass}}');
  });

  it('catches secrets in tool output such as a .env file', () => {
    const v = new MemVault();
    const r = new Redactor(v);
    const out = r.scrubRequest({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'STRIPE_KEY=sk_live_abcdefghijklmnop1234\nPORT=3000' }] }],
    });
    expect(out.body.messages[0].content[0].content).toBe('STRIPE_KEY={{secure.stripe_key}}\nPORT=3000');
  });

  it('applies only strict rules to injected <system-reminder> context', () => {
    const r = new Redactor(new MemVault());
    const reminder = '<system-reminder>\nnote Xq7vT2mK9pL4wR8zN3bY6cF1 and my password is hunter22x\n</system-reminder>';
    const out = r.scrubRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: reminder }, { type: 'text', text: `and ${GH}` }] }] });
    expect(out.body.messages[0].content[0].text).toBe(reminder);
    expect(out.body.messages[0].content[1].text).toBe('and {{secure.github_token}}');
  });

  it('leaves thinking blocks and tool definitions alone', () => {
    const v = new MemVault();
    v.items.push({ name: 'x', value: 'Xq7vT2mK9pL4wR8zN3bY6cF1' });
    const r = new Redactor(v);
    const thinking = { type: 'thinking', thinking: 'plan', signature: 'Xq7vT2mK9pL4wR8zN3bY6cF1' };
    const tools = [{ name: 'Bash', description: 'Xq7vT2mK9pL4wR8zN3bY6cF1' }];
    const out = r.scrubRequest({ tools, messages: [{ role: 'assistant', content: [thinking] }] });
    expect(out.body.messages[0].content[0]).toEqual(thinking);
    expect(out.body.tools).toBe(tools);
  });

  it('is stable: scrubbing a restored conversation yields the same request', () => {
    const v = new MemVault();
    const r = new Redactor(v);
    const first = r.scrubRequest({ messages: [{ role: 'user', content: `token ${GH}` }] });
    const toolCall = { type: 'tool_use', id: 't', name: 'Bash', input: r.restoreDeep({ command: 'gh auth login --with-token {{secure.github_token}}' }) };
    expect(toolCall.input.command).toContain(GH);
    const second = r.scrubRequest({
      messages: [{ role: 'user', content: `token ${GH}` }, { role: 'assistant', content: [toolCall] }],
    });
    expect(second.body.messages[0]).toEqual(first.body.messages[0]);
    expect(second.body.messages[1].content[0].input.command).toBe('gh auth login --with-token {{secure.github_token}}');
  });
});

function sse(type: string, data: any): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function parseEvents(text: string): any[] {
  return text.split('\n\n').filter(Boolean).map(e => JSON.parse(e.split('\n').find(l => l.startsWith('data:'))!.slice(5)));
}

describe('SseRestorer', () => {
  const secret = 'pa"ss\\word-123';
  function setup() {
    const v = new MemVault();
    v.items.push({ name: 'db_pass', value: secret });
    return new SseRestorer(new Redactor(v));
  }

  const stream = [
    sse('message_start', { message: { id: 'm' } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'using {{secure.db_pass}}' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } }),
    sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "psql -p {{sec' } }),
    sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'ure.db_pa' } }),
    sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'ss}} -h x"}' } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_stop', {}),
  ].join('');

  function check(out: string) {
    const events = parseEvents(out);
    const text = events.find(e => e.delta?.type === 'text_delta');
    expect(text.delta.text).toBe('using {{secure.db_pass}}'); // prose is left alone
    const deltas = events.filter(e => e.delta?.type === 'input_json_delta');
    expect(deltas).toHaveLength(1);
    expect(JSON.parse(deltas[0].delta.partial_json)).toEqual({ command: `psql -p ${secret} -h x` });
    expect(events.at(-1).type).toBe('message_stop');
  }

  it('restores a placeholder split across deltas', () => {
    const r = setup();
    check(r.push(stream) + r.end());
  });

  it('survives arbitrary network chunking, one byte at a time', () => {
    const r = setup();
    let out = '';
    for (const ch of stream) out += r.push(ch);
    check(out + r.end());
  });

  it('handles CRLF framing', () => {
    const r = setup();
    const crlf = stream.replace(/\n/g, '\r\n');
    const out = r.push(crlf) + r.end();
    check(out.replace(/\r\n/g, '\n'));
  });
});
