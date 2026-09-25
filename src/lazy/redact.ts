/**
 * Request scrubbing and response restoring.
 *
 * Outbound, every known secret is replaced by `{{secure.NAME}}` wherever it
 * appears, and new secrets found in user text or tool output are added to the
 * vault first. Inbound, placeholders inside tool calls are swapped back for
 * the real value so tools run with it -- the model itself never sees it.
 *
 * Because restored values come back in the next request (as the assistant's
 * own earlier tool call), scrubbing is the exact inverse of restoring and the
 * conversation the model sees stays stable, which also keeps prompt caching.
 */
import { detectSecrets, type DetectMode, type DetectOptions } from './detect.js';
import type { Origin, VaultLike } from './vault.js';

export const PLACEHOLDER_RE = /\{\{secure\.([a-zA-Z0-9_-]{1,64})\}\}/g;

export function placeholder(name: string): string {
  return `{{secure.${name}}}`;
}

export const SYSTEM_NOTE =
  'Some values in this conversation appear as {{secure.NAME}}. Each is a real secret held on the ' +
  "user's machine. Use the token exactly as written wherever the value is needed (commands, files, " +
  'config, code); it is replaced with the real value when the tool runs. Never ask the user to ' +
  'reveal it, and do not try to print, decode or guess it.';

export interface ScrubEvent {
  name: string;
  kind: 'new' | 'known';
  origin: Origin;
}

export interface ScrubResult {
  body: any;
  events: ScrubEvent[];
  /** True when the outgoing conversation contains at least one placeholder. */
  usesPlaceholders: boolean;
}

export class Redactor {
  constructor(private vault: VaultLike, private detect: DetectOptions = {}) {}

  /** Replace known values, then catch and store new ones. */
  scrubText(text: string, mode: DetectMode | null, events: ScrubEvent[]): string {
    if (!text) return text;
    let out = text;
    for (const s of this.vault.entries()) {
      if (!out.includes(s.value)) continue;
      out = out.split(s.value).join(placeholder(s.name));
      this.vault.touch(s.name);
      events.push({ name: s.name, kind: 'known', origin: mode === 'user' ? 'chat' : 'tool-output' });
    }
    if (mode === null) return out;

    const findings = detectSecrets(out, mode, this.detect);
    if (findings.length === 0) return out;
    const origin: Origin = mode === 'user' ? 'chat' : 'tool-output';
    let rebuilt = '';
    let cursor = 0;
    for (const f of findings) {
      const value = out.slice(f.start, f.end);
      if (value.includes('{{secure.')) continue;
      const name = this.vault.remember(f.kind, value, origin);
      events.push({ name, kind: 'new', origin });
      rebuilt += out.slice(cursor, f.start) + placeholder(name);
      cursor = f.end;
    }
    rebuilt += out.slice(cursor);
    // A value caught once may appear again elsewhere in the same text.
    return this.scrubText(rebuilt, null, events);
  }

  /** Known-value scrub of every string in an arbitrary JSON value. */
  scrubDeep(value: any, events: ScrubEvent[]): any {
    if (typeof value === 'string') return this.scrubText(value, null, events);
    if (Array.isArray(value)) return value.map(v => this.scrubDeep(v, events));
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.scrubDeep(v, events);
      return out;
    }
    return value;
  }

  private scrubToolResult(block: any, events: ScrubEvent[]): any {
    const content = block.content;
    if (typeof content === 'string') return { ...block, content: this.scrubText(content, 'tool', events) };
    if (Array.isArray(content)) {
      return {
        ...block,
        content: content.map((c: any) => (c?.type === 'text' ? { ...c, text: this.scrubText(c.text, 'tool', events) } : c)),
      };
    }
    return block;
  }

  private scrubBlock(block: any, role: string, events: ScrubEvent[]): any {
    if (!block || typeof block !== 'object') return block;
    switch (block.type) {
      case 'text':
        // Only user turns can carry new secrets; assistant text is the model's own.
        return { ...block, text: this.scrubText(block.text, role === 'user' ? userTextMode(block.text) : null, events) };
      case 'tool_result':
        return this.scrubToolResult(block, events);
      case 'tool_use':
        return { ...block, input: this.scrubDeep(block.input, events) };
      case 'thinking':
      case 'redacted_thinking':
      case 'image':
      case 'document':
        // Signed or binary -- editing would break the request, and none of it
        // can hold a value the model has not already been shown scrubbed.
        return block;
      default:
        return this.scrubDeep(block, events);
    }
  }

  /** Scrub a Messages API (or count_tokens) request body. */
  scrubRequest(body: any): ScrubResult {
    const events: ScrubEvent[] = [];
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      return { body: this.scrubDeep(body, events), events, usesPlaceholders: false };
    }
    const out = { ...body };
    out.messages = body.messages.map((m: any) => {
      if (typeof m?.content === 'string') {
        return { ...m, content: this.scrubText(m.content, m.role === 'user' ? userTextMode(m.content) : null, events) };
      }
      if (Array.isArray(m?.content)) {
        return { ...m, content: m.content.map((b: any) => this.scrubBlock(b, m.role, events)) };
      }
      return m;
    });
    if (typeof body.system === 'string') out.system = this.scrubText(body.system, null, events);
    else if (Array.isArray(body.system)) out.system = body.system.map((b: any) => this.scrubBlock(b, 'system', events));

    const usesPlaceholders = JSON.stringify(out.messages).includes('{{secure.');
    if (usesPlaceholders) out.system = appendSystemNote(out.system);
    return { body: out, events, usesPlaceholders };
  }

  /** Swap placeholders for real values in raw JSON text (values JSON-escaped). */
  restoreJsonText(json: string): string {
    return json.replace(PLACEHOLDER_RE, (whole, name) => {
      const v = this.vault.valueOf(name);
      return v === undefined ? whole : JSON.stringify(v).slice(1, -1);
    });
  }

  restoreDeep(value: any): any {
    if (typeof value === 'string') {
      return value.replace(PLACEHOLDER_RE, (whole, name) => this.vault.valueOf(name) ?? whole);
    }
    if (Array.isArray(value)) return value.map(v => this.restoreDeep(v));
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.restoreDeep(v);
      return out;
    }
    return value;
  }

  /** Non-streaming response: restore inside tool calls only. */
  restoreResponse(body: any): any {
    if (!body || !Array.isArray(body.content)) return body;
    return {
      ...body,
      content: body.content.map((b: any) => (b?.type === 'tool_use' ? { ...b, input: this.restoreDeep(b.input) } : b)),
    };
  }
}

/**
 * Claude Code injects context (environment, CLAUDE.md, git status) into user
 * turns as <system-reminder> text. That is machine-written, so it gets the
 * stricter tool-output rules; loose heuristics are for what the human typed.
 */
function userTextMode(text: string): DetectMode {
  return text.trimStart().startsWith('<system-reminder>') ? 'tool' : 'user';
}

function appendSystemNote(system: any): any {
  if (system === undefined || system === null) return [{ type: 'text', text: SYSTEM_NOTE }];
  if (typeof system === 'string') return system.includes(SYSTEM_NOTE) ? system : `${system}\n\n${SYSTEM_NOTE}`;
  if (Array.isArray(system)) {
    if (system.some((b: any) => b?.text === SYSTEM_NOTE)) return system;
    return [...system, { type: 'text', text: SYSTEM_NOTE }];
  }
  return system;
}

/**
 * Streaming restorer for Messages API server-sent events.
 *
 * Tool-call arguments stream as `input_json_delta` fragments, and a
 * placeholder can be split across any number of them. Deltas for tool_use
 * blocks are therefore held back until the block stops, then released as a
 * single restored delta. Every other event passes through untouched.
 */
export class SseRestorer {
  private buf = '';
  private held = new Map<number, string>();

  constructor(private redactor: Redactor) {}

  /** Feed raw stream text; returns text safe to forward now. */
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const raw = this.buf.slice(0, m.index + m[0].length);
      this.buf = this.buf.slice(m.index + m[0].length);
      out += this.handleEvent(raw);
    }
    return out;
  }

  /** End of stream: flush anything left (malformed tails pass through). */
  end(): string {
    const rest = this.buf;
    this.buf = '';
    let out = rest ? this.handleEvent(rest) : '';
    // A stream cut mid tool call: release what we held, restored, so the
    // client sees the same (incomplete) call it would have seen without us.
    for (const [index, json] of this.held) out += deltaEvent(index, this.redactor.restoreJsonText(json));
    this.held.clear();
    return out;
  }

  private handleEvent(raw: string): string {
    const dataLine = raw.split(/\r?\n/).find(l => l.startsWith('data:'));
    if (!dataLine) return raw;
    let data: any;
    try {
      data = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return raw;
    }
    if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      this.held.set(data.index, '');
      if (data.content_block.input && Object.keys(data.content_block.input).length > 0) {
        return reencode(raw, { ...data, content_block: { ...data.content_block, input: this.redactor.restoreDeep(data.content_block.input) } });
      }
      return raw;
    }
    if (data.type === 'content_block_delta' && this.held.has(data.index) && data.delta?.type === 'input_json_delta') {
      this.held.set(data.index, this.held.get(data.index)! + (data.delta.partial_json ?? ''));
      return '';
    }
    if (data.type === 'content_block_stop' && this.held.has(data.index)) {
      const json = this.held.get(data.index)!;
      this.held.delete(data.index);
      return (json ? deltaEvent(data.index, this.redactor.restoreJsonText(json)) : '') + raw;
    }
    return raw;
  }
}

function deltaEvent(index: number, partialJson: string): string {
  const data = { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

function reencode(raw: string, data: any): string {
  const eventLine = raw.split(/\r?\n/).find(l => l.startsWith('event:'));
  return `${eventLine ? eventLine + '\n' : ''}data: ${JSON.stringify(data)}\n\n`;
}
