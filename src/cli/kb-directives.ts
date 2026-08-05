// F1 (D1) human-terminal directive activation CLI.
//
// TRUST RATIONALE: MCP gives no user-vs-agent identity signal -- env vars and
// prompt-level confirmation are forgeable by construction. The only channel an
// agent cannot quietly use is a command the human runs in their OWN terminal.
// So a user-directive captured over MCP is only ever a PENDING PROPOSAL, and
// ACTIVATION (approve / add) happens HERE, in the CLI, never over MCP. These
// commands open the SAME project KB the running server uses (scope resolved from
// the current working directory, exactly like the MCP provider construction), so
// an approval is visible to the running server without a restart -- same sqlite
// file. Because kb_capture (M1) forces every directive proposal to scope=project,
// there is no proposal this project CLI cannot reach; a future
// `add-directive --global` is explicitly out of scope.

import type { KBEntry } from '../services/knowledge/types.js';

// Minimal structural type -- the four directive primitives on SqliteProvider.
// Kept structural so tests can pass a real temp SqliteProvider directly.
export interface DirectiveProvider {
  listDirectives(): Promise<KBEntry[]>;
  approveDirective(id: string): Promise<KBEntry>;
  rejectDirective(id: string): Promise<KBEntry>;
  addDirective(text: string, symbols?: string[]): Promise<KBEntry>;
}

function directiveStatus(e: KBEntry): string {
  if (e.superseded_at) return 'rejected';
  if (e.confidence === 'CONFIRMED') return 'active';
  return 'pending';
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// -- list --

export async function listDirectivesCmd(provider: DirectiveProvider): Promise<number> {
  const rows = await provider.listDirectives();
  if (rows.length === 0) {
    console.log('No directives. Pending proposals appear here once an agent captures a user-directive.');
    return 0;
  }

  const header = ['STATUS', 'ID', 'PROPOSER', 'CREATED', 'TITLE'];
  const table = rows.map(e => [
    directiveStatus(e),
    e.id,
    e.author || 'unknown',
    (e.created_at || '').slice(0, 19),
    e.title,
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...table.map(r => r[i].length)));
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  for (const r of table) {
    console.log(r.map((c, i) => pad(c, widths[i])).join('  '));
  }
  return 0;
}

// -- approve --

export async function approveDirectiveCmd(provider: DirectiveProvider, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage: apra-fleet kb approve-directive <id>');
    return 1;
  }
  try {
    const entry = await provider.approveDirective(id);
    console.log('Activated directive ' + entry.id + ' (' + entry.confidence + ', author=' + entry.author + ').');
    console.log('  ' + entry.title);
    return 0;
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

// -- reject --

export async function rejectDirectiveCmd(provider: DirectiveProvider, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage: apra-fleet kb reject-directive <id>');
    return 1;
  }
  try {
    const entry = await provider.rejectDirective(id);
    console.log('Rejected directive ' + entry.id + ' (superseded, audit trail kept).');
    console.log('  ' + entry.title);
    return 0;
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

// -- add (creates an already-active directive: human terminal = trust root) --

export function parseSymbols(args: string[]): { text: string | undefined; symbols: string[] } {
  const symbolsIdx = args.indexOf('--symbols');
  let symbols: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (i === symbolsIdx) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    positional.push(args[i]);
  }
  if (symbolsIdx !== -1 && symbolsIdx + 1 < args.length) {
    symbols = args[symbolsIdx + 1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  return { text: positional[0], symbols };
}

export async function addDirectiveCmd(provider: DirectiveProvider, args: string[]): Promise<number> {
  const { text, symbols } = parseSymbols(args);
  if (!text) {
    console.error('Usage: apra-fleet kb add-directive "<text>" [--symbols a,b,c]');
    return 1;
  }
  try {
    const entry = await provider.addDirective(text, symbols.length > 0 ? symbols : undefined);
    console.log('Added active directive ' + entry.id + ' (' + entry.confidence + ', author=' + entry.author + ').');
    console.log('  ' + entry.title);
    return 0;
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

// -- top-level dispatch (resolves the real project provider) --

function usage(): void {
  console.error('Usage:');
  console.error('  apra-fleet kb directives                              List pending + active directives');
  console.error('  apra-fleet kb approve-directive <id>                  Activate a pending proposal');
  console.error('  apra-fleet kb reject-directive <id>                   Reject a proposal or retire a directive');
  console.error('  apra-fleet kb add-directive "<text>" [--symbols a,b]  Create an already-active directive');
}

export async function runKbDirectives(subCmd: string, rest: string[]): Promise<number> {
  const { getKbProviders } = await import('../services/knowledge/kb-providers.js');
  const providers = await getKbProviders();
  const provider = providers.project;

  if (subCmd === 'directives') {
    return listDirectivesCmd(provider);
  } else if (subCmd === 'approve-directive') {
    return approveDirectiveCmd(provider, rest[0]);
  } else if (subCmd === 'reject-directive') {
    return rejectDirectiveCmd(provider, rest[0]);
  } else if (subCmd === 'add-directive') {
    return addDirectiveCmd(provider, rest);
  }
  usage();
  return 1;
}
