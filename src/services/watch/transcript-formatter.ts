import path from 'node:path';

/** One human-readable line derived from a transcript event. */
export interface FormattedEvent {
  /** HH:MM:SS from the event timestamp, or null if unavailable. */
  time: string | null;
  /** The summary text, without member prefix or color. */
  text: string;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 3) + '...' : oneLine;
}

function timeOf(ev: any): string | null {
  if (!ev || typeof ev.timestamp !== 'string') return null;
  const d = new Date(ev.timestamp);
  if (isNaN(d.getTime())) return null;
  return d.toTimeString().slice(0, 8);
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

/** Format a Claude transcript event into zero or more display lines. */
function formatClaude(ev: any): FormattedEvent[] {
  const time = timeOf(ev);
  if (ev.type !== 'assistant') return [];
  const content = ev.message?.content;
  if (!Array.isArray(content)) return [];

  const out: FormattedEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      out.push({ time, text: `assistant: ${truncate(block.text, 100)}` });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      out.push({ time, text: `> ${toolDetail(block.name, block.input)}` });
    }
    // thinking and other block types are intentionally suppressed
  }
  return out;
}

/**
 * Parse and format one raw transcript JSONL line for the given provider.
 * Returns [] to skip the line (parse error, suppressed event type, etc.).
 * Claude is fully parsed; other providers fall back to a compact raw preview.
 */
export function formatTranscriptLine(provider: string, raw: string): FormattedEvent[] {
  const line = raw.trim();
  if (!line) return [];
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }

  if (provider === 'claude') return formatClaude(ev);

  // Fallback for providers whose transcript format is not yet parsed: show a
  // compact preview so the stream is not silent, rather than pretending support.
  const preview = truncate(typeof ev === 'string' ? ev : JSON.stringify(ev), 100);
  return preview ? [{ time: timeOf(ev), text: preview }] : [];
}
