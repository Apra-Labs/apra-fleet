/**
 * Transform Claude-format agent files to OpenCode format at install time.
 *
 * Claude frontmatter: name, description, tools (comma/list)
 * OpenCode frontmatter: description, mode: subagent, permission map (no name)
 *
 * NOTE: packages/apra-fleet-se/apra-pm/install.mjs is NOT an npm workspace (see the
 * comment at its own transformAgentForAgy/transformAgentForOpenCode) and carries its
 * own copies of the following symbols from this file -- keep BOTH sides in sync
 * whenever adding new tool mappings or frontmatter fields:
 *   - transformAgentForOpenCode
 *   - transformAgentForAgy
 *   - agyToolMap
 *   - OPENCODE_NATIVE_TOOLS
 *   - CONDITIONAL_MARKER_RE
 *   - resolveConditionalBody
 *   - toolAvailability
 *   - readFrontmatterTools
 * tests/agent-transform-apra-pm-sync.test.ts asserts agyToolMap and
 * OPENCODE_NATIVE_TOOLS stay byte-identical between the two files, so drift in
 * those two fails a suite instead of shipping; the rest of the list above has no
 * automated guard -- update both files by hand.
 */

interface PermissionMap {
  edit: 'allow' | 'deny';
  write: 'allow' | 'deny';
  bash: 'allow' | 'deny';
}

// --- Provider-conditional body blocks ---------------------------------------
//
// Dropping a tool from a transformed agent's frontmatter is only half a fix: the
// PROSE that tells the agent to call that tool has to go with it, or the installed
// prompt instructs the agent to use a tool it does not have. This is the generic
// mechanism for that, keyed off the SAME notion of "which tools survive" that
// drives the frontmatter for each provider.
//
// Marker convention (HTML comments, so a marker is invisible in rendered markdown
// and inert if some other reader ignores it):
//
//   <!-- if-tool: SomeTool -->
//   ...prose that only makes sense when the agent has SomeTool...
//   <!-- else-tool: SomeTool -->
//   ...provider-neutral fallback prose...
//   <!-- end-tool: SomeTool -->
//
// Resolution, per provider:
//   tool available   -> keep the if-branch, drop the else-branch, drop the markers
//   tool unavailable -> keep the else-branch, drop the if-branch, drop the markers
//
// The else-branch is optional; `<!-- if-tool: X -->` ... `<!-- end-tool: X -->`
// with no else simply deletes the block when X is unavailable.
//
// Blocks nest and repeat: an inner block is resolved into its enclosing branch
// before that branch is chosen or discarded, so prose inside a discarded branch
// disappears along with it.
//
// This mechanism is deliberately tool-name-generic. It knows nothing about any
// particular tool, MCP server, or target repository -- the tool name is whatever
// the marker says, and availability is decided by the per-provider tool sets
// below. See docs/generic-engine-boundary.md.
//
// Malformed markers are a HARD ERROR, not a warning: a half-rendered prompt that
// ships is worse than an install that stops and says which file is broken.

/** Matches any conditional marker anywhere, swallowing its line when it sits alone. */
const CONDITIONAL_MARKER_RE =
  /[ \t]*<!--[ \t]*(if-tool|else-tool|end-tool):[ \t]*([^\s>]+)[ \t]*-->[ \t]*(?:\r?\n)?/g;

type MarkerKind = 'if-tool' | 'else-tool' | 'end-tool';

interface ConditionalMarker {
  kind: MarkerKind;
  tool: string;
  start: number;
  end: number;
}

interface ConditionalFrame {
  tool: string;
  seenElse: boolean;
  ifBuf: string;
  elseBuf: string;
}

/**
 * Thrown when a conditional block is unclosed, unmatched, or mismatched. Surfaced
 * at install time rather than swallowed -- see the note above.
 */
export class ConditionalMarkerError extends Error {
  constructor(label: string, detail: string) {
    super(`[agent-transform] ${label}: ${detail}`);
    this.name = 'ConditionalMarkerError';
  }
}

function scanConditionalMarkers(text: string): ConditionalMarker[] {
  const re = new RegExp(CONDITIONAL_MARKER_RE.source, 'g');
  const markers: ConditionalMarker[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    markers.push({
      kind: m[1] as MarkerKind,
      tool: m[2],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return markers;
}

/**
 * Resolve every conditional block in `text` against a tool-availability predicate.
 *
 * @param text       any agent file content (frontmatter carries no markers)
 * @param isAvailable answers "does this provider give the agent this tool?"
 * @param label      file label used in error messages
 */
export function resolveConditionalBody(
  text: string,
  isAvailable: (tool: string) => boolean,
  label: string
): string {
  const markers = scanConditionalMarkers(text);
  if (markers.length === 0) return text;

  const stack: ConditionalFrame[] = [];
  let root = '';

  const append = (chunk: string): void => {
    if (!chunk) return;
    const top = stack[stack.length - 1];
    if (!top) {
      root += chunk;
    } else if (top.seenElse) {
      top.elseBuf += chunk;
    } else {
      top.ifBuf += chunk;
    }
  };

  let cursor = 0;
  for (const marker of markers) {
    append(text.slice(cursor, marker.start));
    cursor = marker.end;

    const top = stack[stack.length - 1];
    if (marker.kind === 'if-tool') {
      stack.push({ tool: marker.tool, seenElse: false, ifBuf: '', elseBuf: '' });
      continue;
    }
    if (!top) {
      throw new ConditionalMarkerError(
        label,
        `<!-- ${marker.kind}: ${marker.tool} --> has no matching <!-- if-tool: ${marker.tool} -->`
      );
    }
    if (top.tool !== marker.tool) {
      throw new ConditionalMarkerError(
        label,
        `<!-- ${marker.kind}: ${marker.tool} --> does not match the open ` +
          `<!-- if-tool: ${top.tool} -->`
      );
    }
    if (marker.kind === 'else-tool') {
      if (top.seenElse) {
        throw new ConditionalMarkerError(
          label,
          `duplicate <!-- else-tool: ${marker.tool} --> in one conditional block`
        );
      }
      top.seenElse = true;
      continue;
    }
    // end-tool: pop and fold the chosen branch into the enclosing buffer.
    stack.pop();
    append(isAvailable(top.tool) ? top.ifBuf : top.elseBuf);
  }
  append(text.slice(cursor));

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    throw new ConditionalMarkerError(
      label,
      `unclosed <!-- if-tool: ${unclosed.tool} --> (missing <!-- end-tool: ${unclosed.tool} -->)`
    );
  }
  return root;
}

/**
 * Tools Antigravity can express. The keys ARE the availability set for agy: a tool
 * with no mapping is dropped from the frontmatter, so its prose must go too.
 */
const agyToolMap: Record<string, string[]> = {
  'Read': ['view_file'],
  'Grep': ['grep_search'],
  'Glob': ['list_dir'],
  'Bash': ['run_command'],
  'Write': ['write_to_file', 'replace_file_content'],
  'Edit': ['replace_file_content'],
  'Agent': ['invoke_subagent', 'send_message']
};

/**
 * OpenCode's native subagent toolset, in Claude tool names.
 *
 * transformAgentForOpenCode emits no `tools:` line at all (OpenCode grants its
 * built-ins and gates the dangerous ones through the permission map), so unlike
 * agy there is no emitted frontmatter to read availability back off. It has to be
 * stated explicitly, and this is that statement: anything NOT listed here is
 * unavailable under OpenCode and its prose is resolved to the else-branch.
 */
export const OPENCODE_NATIVE_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Agent'];

/** A frontmatter `tools: [...]` list that means "everything this provider has". */
function isWildcardTools(tools: string[]): boolean {
  return tools.some(t => t === '*');
}

/**
 * Build the availability predicate for a provider.
 *
 * @param declared frontmatter tools of the SOURCE (Claude-format) agent, or null
 *                 when the file declares none (then the agent has whatever the
 *                 provider gives it, so every tool counts as available)
 * @param supported tools the provider can express, or null for "all of them"
 *                  (the Claude/raw path, whose frontmatter is authored for it)
 */
function toolAvailability(
  declared: string[] | null,
  supported: readonly string[] | null
): (tool: string) => boolean {
  const declaredSet =
    declared === null || isWildcardTools(declared) ? null : new Set(declared);
  const supportedSet = supported === null ? null : new Set(supported);
  return (tool: string) =>
    (declaredSet === null || declaredSet.has(tool)) &&
    (supportedSet === null || supportedSet.has(tool));
}

function parseToolsList(toolsRaw: string): string[] {
  return toolsRaw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

function buildPermissionMap(tools: string[]): PermissionMap {
  const toolSet = new Set(tools);
  return {
    edit: toolSet.has('Edit') ? 'allow' : 'deny',
    write: toolSet.has('Write') ? 'allow' : 'allow',
    bash: toolSet.has('Bash') ? 'allow' : 'deny',
  };
}

function buildDefaultPermissionMap(): PermissionMap {
  return { edit: 'deny', write: 'allow', bash: 'deny' };
}

export function transformAgentForOpenCode(content: string, _filename: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  // No frontmatter to rewrite, but markers must never survive on any path.
  if (!fmMatch) {
    return resolveConditionalBody(
      content,
      toolAvailability(null, OPENCODE_NATIVE_TOOLS),
      _filename
    );
  }

  const frontmatter = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  let description = '';
  let tools: string[] = [];
  let hasTools = false;

  for (const line of frontmatter.split('\n')) {
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) {
      description = descMatch[1].trim();
    }
    const toolsMatch = line.match(/^tools:\s*(.+)/);
    if (toolsMatch) {
      hasTools = true;
      tools = parseToolsList(toolsMatch[1].trim());
    }
  }

  const perm = hasTools ? buildPermissionMap(tools) : buildDefaultPermissionMap();

  const resolvedBody = resolveConditionalBody(
    body,
    toolAvailability(hasTools ? tools : null, OPENCODE_NATIVE_TOOLS),
    _filename
  );

  const opencodeFm = [
    '---',
    `description: ${description}`,
    'mode: subagent',
    'permission:',
    `  edit: ${perm.edit}`,
    `  write: ${perm.write}`,
    `  bash: ${perm.bash}`,
    '---',
    '',
  ].join('\n');

  return opencodeFm + resolvedBody;
}

/**
 * The Claude/raw install path. Claude reads the source frontmatter as-authored, so
 * nothing is rewritten -- but the markers themselves must still be stripped, or they
 * ship verbatim into the installed agent file. Every conditional keeps its if-branch,
 * because for Claude the tool map is the identity map over the declared tools.
 *
 * Non-agent assets travel this path too (schemas/*.json, _shared/*.md); they carry no
 * frontmatter and no markers, so they pass through untouched.
 */
export function transformAgentForClaude(content: string, filename: string): string {
  const declared = readFrontmatterTools(content);
  return resolveConditionalBody(content, toolAvailability(declared, null), filename);
}

/** Source (Claude-format) frontmatter tools, or null when the file declares none. */
function readFrontmatterTools(content: string): string[] | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return null;
  for (const line of fmMatch[1].split('\n')) {
    const toolsMatch = line.match(/^tools:\s*(.+)/);
    if (toolsMatch) return parseToolsList(toolsMatch[1].trim());
  }
  return null;
}

export function transformAgentForAgy(content: string, _filename: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  // No frontmatter to rewrite, but markers must never survive on any path.
  if (!fmMatch) {
    return resolveConditionalBody(
      content,
      toolAvailability(null, Object.keys(agyToolMap)),
      _filename
    );
  }

  const frontmatter = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  let name = '';
  let description = '';
  let tools: string[] = [];
  let hasTools = false;

  for (const line of frontmatter.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) {
      name = nameMatch[1].trim();
    }
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) {
      description = descMatch[1].trim();
    }
    const toolsMatch = line.match(/^tools:\s*(.+)/);
    if (toolsMatch) {
      hasTools = true;
      tools = parseToolsList(toolsMatch[1].trim());
    }
  }

  let agyFm = '---\n';
  if (name) agyFm += `name: ${name}\n`;
  if (description) agyFm += `description: ${description}\n`;

  if (hasTools) {
    const mappedTools = new Set<string>();
    const unmappedTools: string[] = [];
    for (const tool of tools) {
      const mapped = agyToolMap[tool];
      if (mapped) {
        for (const m of mapped) mappedTools.add(m);
      } else {
        unmappedTools.push(tool);
      }
    }

    if (unmappedTools.length > 0) {
      console.warn(
        `[agy] dropping tools with no Antigravity equivalent from agent "${name || _filename}": ${unmappedTools.join(', ')}`
      );
    }

    if (mappedTools.size > 0) {
      agyFm += `tools: [${Array.from(mappedTools).join(', ')}]\n`;
    }
  }

  agyFm += '---\n\n';

  let agyRules = '';
  if (hasTools && tools.length > 0) {
    agyRules += '\n<!-- AGY Sandbox Pre-approvals -->\n';
    agyRules += '<rule>\n  <auto_approve>\n';

    const toolSet = new Set(tools.map(t => t.toLowerCase()));

    if (toolSet.has('read') || toolSet.has('glob') || toolSet.has('grep')) {
      agyRules += '    <permission action="read_file" target="*" />\n';
    }

    if (toolSet.has('write') || toolSet.has('edit')) {
      agyRules += '    <permission action="write_file" target="*" />\n';
    }

    if (toolSet.has('bash')) {
      agyRules += '    <permission action="command" target="*" />\n';
    }

    if (toolSet.has('agent')) {
      agyRules += '    <permission action="invoke_subagent" target="*" />\n';
      agyRules += '    <permission action="send_message" target="*" />\n';
    }

    if (toolSet.has('mcp')) {
      agyRules += '    <permission action="mcp" target="*" />\n';
    }
    if (toolSet.has('fetch') || toolSet.has('curl')) {
      agyRules += '    <permission action="read_url" target="*" />\n';
    }

    agyRules += '  </auto_approve>\n</rule>\n';
  }

  // Same tool map that decided the frontmatter above decides the prose: a tool with
  // no Antigravity equivalent loses its instructions along with its tools entry.
  const resolvedBody = resolveConditionalBody(
    body,
    toolAvailability(hasTools ? tools : null, Object.keys(agyToolMap)),
    _filename
  );

  return agyFm + resolvedBody.trim() + '\n' + agyRules;
}
