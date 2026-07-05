import path from 'node:path';

/** Visual class of a line, so the renderer can color it. */
export type LineKind = 'info' | 'add' | 'del' | 'dim' | 'out';

/** One human-readable line derived from a transcript event. */
export interface FormattedEvent {
  /** HH:MM:SS from the event timestamp, or null (detail lines have no time). */
  time: string | null;
  /** The summary text, without member prefix or color. */
  text: string;
  /** Visual class; defaults to 'info'. */
  kind?: LineKind;
}

const MAX_DETAIL_LINES = 20; // cap per edit/write/result block in verbose mode

/** Collapse whitespace and cap length -- for summary lines (prose). */
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

/** Render a block of text as capped, prefixed detail lines of a given kind. */
function detailLines(text: string, prefix: string, kind: LineKind): FormattedEvent[] {
  const lines = text.split('\n');
  const out: FormattedEvent[] = [];
  for (const line of lines.slice(0, MAX_DETAIL_LINES)) {
    out.push({ time: null, kind, text: '    ' + prefix + clip(line, 200) });
  }
  if (lines.length > MAX_DETAIL_LINES) {
    out.push({ time: null, kind: 'dim', text: `    ... (${lines.length - MAX_DETAIL_LINES} more lines)` });
  }
  return out;
}

/** Short detail string for a tool_use block, e.g. the file or command it acts on. */
function toolDetail(tool: string, input: any): string {
  if (!input || typeof input !== 'object') return tool;
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return input.file_path ? `${tool} ${path.basename(String(input.file_path))}` : tool;
    case 'Bash':
      return `Bash: ${truncate(String(input.description || input.command || ''), 60)}`;
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

/** In verbose mode, the detail lines that follow a tool_use header. */
function toolVerboseDetail(tool: string, input: any): FormattedEvent[] {
  if (!input || typeof input !== 'object') return [];
  switch (tool) {
    case 'Edit':
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
    case 'Bash':
      return typeof input.command === 'string' ? detailLines(input.command, '$ ', 'dim') : [];
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

/** Format a Claude transcript event into zero or more display lines. */
function formatClaude(ev: any, verbose: boolean): FormattedEvent[] {
  const time = timeOf(ev);
  const content = ev.message?.content;

  // Assistant turns: text, tool calls, and (verbose) thinking.
  if (ev.type === 'assistant') {
    if (!Array.isArray(content)) return [];
    const out: FormattedEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ time, text: `assistant: ${truncate(block.text, verbose ? 400 : 100)}` });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        out.push({ time, text: `> ${toolDetail(block.name, block.input)}` });
        if (verbose) out.push(...toolVerboseDetail(block.name, block.input));
      } else if (block.type === 'thinking' && verbose && typeof block.thinking === 'string' && block.thinking.trim()) {
        out.push({ time, kind: 'dim', text: `(thinking) ${truncate(block.thinking, 240)}` });
      }
    }
    return out;
  }

  // User turns: only tool results, and only in verbose mode (the initial prompt
  // and non-result user content are skipped).
  if (ev.type === 'user' && verbose && Array.isArray(content)) {
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
 * back to a compact raw preview. When verbose is true, edits show diffs,
 * writes show content, bash shows the full command + output, and thinking is
 * included.
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
  return preview ? [{ time: timeOf(ev), text: preview }] : [];
}
