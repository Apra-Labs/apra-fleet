import path from 'node:path';

/** Visual class of a line body, so the renderer can color it. */
export type LineKind = 'info' | 'add' | 'del' | 'dim' | 'out';

/** Action marker shown before a line: read-only tool, edit/write, bash, or none. */
export type Marker = '' | '>' | '*' | '$';

/** One human-readable line derived from a transcript event. */
export interface FormattedEvent {
  /** HH:MM:SS from the event timestamp, or null (detail lines carry no time). */
  time: string | null;
  /** Action marker; '' for prose and detail lines. */
  marker: Marker;
  /** The body text -- no marker, no leading indent (the renderer adds those). */
  text: string;
  /** Body color class; defaults to 'info'. */
  kind: LineKind;
  /** Detail line (diff/content/output) -- rendered indented, without a timestamp. */
  detail?: boolean;
}

const DETAIL_CAP = 40; // cap per output/diff/result block (thinking is the only -v-gated content)

/** Collapse whitespace and cap length -- for prose. */
function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 3) + '...' : oneLine;
}

/** Cap length without collapsing whitespace -- for code/detail lines. */
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function timeOf(ev: any): string | null {
  if (!ev || typeof ev.timestamp !== 'string') return null;
  const d = new Date(ev.timestamp);
  if (isNaN(d.getTime())) return null;
  return d.toTimeString().slice(0, 8);
}

/** Render a block of text as capped detail lines of a given kind, with an optional per-line prefix. */
function detailLines(text: string, prefix: string, kind: LineKind, cap: number = DETAIL_CAP): FormattedEvent[] {
  const lines = text.split('\n');
  const out: FormattedEvent[] = [];
  for (const line of lines.slice(0, cap)) {
    out.push({ time: null, marker: '', kind, detail: true, text: prefix + clip(line, 200) });
  }
  if (lines.length > cap) {
    out.push({ time: null, marker: '', kind: 'dim', detail: true, text: `... (${lines.length - cap} more lines)` });
  }
  return out;
}

/** Marker for a tool: '*' mutating, '$' bash, '>' everything else (read-only). */
function toolMarker(tool: string): Marker {
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return '*';
    case 'Bash':
      return '$';
    default:
      return '>';
  }
}

/** Header body for a tool_use block (marker rendered separately). */
function toolHeader(tool: string, input: any): string {
  if (!input || typeof input !== 'object') return tool;
  switch (tool) {
    case 'Read':
      return input.file_path ? `${tool} ${path.basename(String(input.file_path))}` : tool;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (!input.file_path) return tool;
      const name = path.basename(String(input.file_path));
      // Compact +added/-removed summary so the default view conveys edit size.
      const rm = typeof input.old_string === 'string' && input.old_string.length ? input.old_string.split('\n').length : 0;
      const add = typeof input.new_string === 'string' && input.new_string.length ? input.new_string.split('\n').length : 0;
      const delta = add || rm ? ` (+${add} -${rm})` : '';
      return `${tool} ${name}${delta}`;
    }
    case 'Write': {
      if (!input.file_path) return tool;
      const name = path.basename(String(input.file_path));
      const n = typeof input.content === 'string' ? input.content.split('\n').length : 0;
      return `${tool} ${name}${n ? ` (${n} lines)` : ''}`;
    }
    case 'Bash': {
      // Body after the '$' marker is the command itself (first line).
      const cmd = typeof input.command === 'string' ? input.command.split('\n')[0] : '';
      return cmd ? clip(cmd, 100) : truncate(String(input.description || 'Bash'), 60);
    }
    case 'Grep':
    case 'Glob':
      return input.pattern ? `${tool} ${truncate(String(input.pattern), 40)}` : tool;
    case 'Task':
    case 'Agent':
      return input.description ? `${tool}: ${truncate(String(input.description), 50)}` : tool;
    default:
      return input.description ? `${tool}: ${truncate(String(input.description), 50)}` : tool;
  }
}

/**
 * Detail lines that follow a tool_use header: full edit diffs, written file
 * contents, and multi-line command bodies. All shown by default -- thinking is
 * the only content reserved for verbose.
 */
function toolDetail(tool: string, input: any): FormattedEvent[] {
  if (!input || typeof input !== 'object') return [];
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const out: FormattedEvent[] = [];
      if (typeof input.old_string === 'string' && input.old_string.length > 0) {
        out.push(...detailLines(input.old_string, '- ', 'del'));
      }
      if (typeof input.new_string === 'string') {
        out.push(...detailLines(input.new_string, '+ ', 'add'));
      }
      return out;
    }
    case 'Write':
      return typeof input.content === 'string' ? detailLines(input.content, '+ ', 'add') : [];
    case 'Bash': {
      // Header shows line 1; show any continuation lines dimmed.
      if (typeof input.command !== 'string') return [];
      const rest = input.command.split('\n').slice(1);
      return rest.length > 0 ? detailLines(rest.join('\n'), '', 'dim') : [];
    }
    default:
      return [];
  }
}

/** Extract the text of a tool_result block's content (string or array form). */
function toolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
      .join('\n');
  }
  return '';
}

function formatClaude(ev: any, verbose: boolean): FormattedEvent[] {
  const time = timeOf(ev);
  const content = ev.message?.content;

  if (ev.type === 'assistant') {
    if (!Array.isArray(content)) return [];
    const out: FormattedEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        // Prose: no label, no marker.
        out.push({ time, marker: '', kind: 'info', text: truncate(block.text, 400) });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        out.push({ time, marker: toolMarker(block.name), kind: 'info', text: toolHeader(block.name, block.input) });
        out.push(...toolDetail(block.name, block.input));
      } else if (block.type === 'thinking' && verbose && typeof block.thinking === 'string' && block.thinking.trim()) {
        // Thinking is the ONLY content reserved for verbose (-v).
        out.push({ time, marker: '', kind: 'dim', text: `thinking: ${truncate(block.thinking, 240)}` });
      }
    }
    return out;
  }

  // Tool results (command/tool output) are the "logs" -- always shown.
  if (ev.type === 'user' && Array.isArray(content)) {
    const out: FormattedEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
      const text = toolResultText(block.content).trim();
      if (!text) continue;
      out.push(...detailLines(text, block.is_error ? '! ' : '', block.is_error ? 'del' : 'out'));
    }
    return out;
  }

  return [];
}

/**
 * Parse and format one raw transcript JSONL line for the given provider.
 * Returns [] to skip the line. Claude is fully parsed; other providers fall
 * back to a compact raw preview. Everything -- edit diffs, written content,
 * command bodies and outputs -- is shown by default; verbose adds only the
 * model's thinking/reasoning.
 */
export function formatTranscriptLine(provider: string, raw: string, verbose = false): FormattedEvent[] {
  const line = raw.trim();
  if (!line) return [];
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }

  if (provider === 'claude') return formatClaude(ev, verbose);

  const preview = truncate(typeof ev === 'string' ? ev : JSON.stringify(ev), 100);
  return preview ? [{ time: timeOf(ev), marker: '', kind: 'info', text: preview }] : [];
}
