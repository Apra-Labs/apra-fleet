/**
 * Transform Claude-format agent files to OpenCode format at install time.
 *
 * Claude frontmatter: name, description, tools (comma/list)
 * OpenCode frontmatter: description, mode: subagent, permission map (no name)
 *
 * NOTE: This mirrors apra-pm/install.mjs:transformAgentForOpenCode -- keep both in sync
 * when adding new tool mappings or frontmatter fields.
 */

interface PermissionMap {
  edit: 'allow' | 'deny';
  write: 'allow' | 'deny';
  bash: 'allow' | 'deny';
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

interface ParsedAgent {
  name: string | undefined;
  description: string;
  tools: string[];
  hasTools: boolean;
  body: string;
}

function parseAgentFile(content: string): ParsedAgent | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  let description = '';
  let tools: string[] = [];
  let hasTools = false;

  for (const line of frontmatter.split('\n')) {
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();
    const toolsMatch = line.match(/^tools:\s*(.+)/);
    if (toolsMatch) {
      hasTools = true;
      tools = parseToolsList(toolsMatch[1].trim());
    }
  }

  let name: string | undefined;
  const nameMatch = frontmatter.match(/^name:\s*(.+)/m);
  if (nameMatch) name = nameMatch[1].trim();

  return { name, description, tools, hasTools, body };
}

export function transformAgentForOpenCode(content: string, _filename: string): string {
  const parsed = parseAgentFile(content);
  if (!parsed) return content;

  const perm = parsed.hasTools ? buildPermissionMap(parsed.tools) : buildDefaultPermissionMap();

  const opencodeFm = [
    '---',
    `description: ${parsed.description}`,
    'mode: subagent',
    'permission:',
    `  edit: ${perm.edit}`,
    `  write: ${perm.write}`,
    `  bash: ${perm.bash}`,
    '---',
    '',
  ].join('\n');

  return opencodeFm + parsed.body;
}

/**
 * Transform Claude-format agent files to AGY format at install time.
 * Parses the legacy `tools: [...]` array and maps it to AGY `<rule><auto_approve>` XML blocks.
 */
export function transformAgentForAgy(content: string, _filename: string): string {
  const parsed = parseAgentFile(content);
  if (!parsed) return content;

  let agyFm = '---\n';
  if (parsed.name) agyFm += `name: ${parsed.name}\n`;
  if (parsed.description) agyFm += `description: ${parsed.description}\n`;
  
  if (parsed.hasTools) {
    const agyToolMap: Record<string, string[]> = {
      'Read': ['view_file'],
      'Grep': ['grep_search'],
      'Glob': ['list_dir'],
      'Bash': ['run_command'],
      'Write': ['write_to_file', 'replace_file_content', 'multi_replace_file_content'],
      'Edit': ['replace_file_content', 'multi_replace_file_content'],
      'Agent': ['invoke_subagent', 'send_message']
    };
    
    const mappedTools = new Set<string>();
    for (const tool of parsed.tools) {
      const mapped = agyToolMap[tool] || [tool];
      for (const m of mapped) mappedTools.add(m);
    }
    
    agyFm += `tools: [${Array.from(mappedTools).join(', ')}]\n`;
  }
  
  agyFm += '---\n\n';

  let agyRules = '';
  if (parsed.hasTools && parsed.tools.length > 0) {
    agyRules += '\n<!-- AGY Sandbox Pre-approvals -->\n';
    agyRules += '<rule>\n  <auto_approve>\n';
    
    const toolSet = new Set(parsed.tools.map(t => t.toLowerCase()));

    // Map Read/Glob/Grep to File Read
    if (toolSet.has('read') || toolSet.has('glob') || toolSet.has('grep')) {
      agyRules += '    <permission action="read_file" target="*" />\n';
    }

    // Map Write/Edit to File Write (which implicitly grants read as well in AGY)
    if (toolSet.has('write') || toolSet.has('edit')) {
      agyRules += '    <permission action="write_file" target="*" />\n';
    }

    // Map Bash to generic command execution (can be scoped down later if needed)
    if (toolSet.has('bash')) {
      // Common safe targets could be 'git', 'bd', 'npm', 'node', 'npx', 'tsc'
      // Or '*' for full sandbox capability matching the original 'Bash' intent
      agyRules += '    <permission action="command" target="*" />\n';
    }

    // Map Agent to subagent invocation
    if (toolSet.has('agent')) {
      agyRules += '    <permission action="invoke_subagent" target="*" />\n';
      agyRules += '    <permission action="send_message" target="*" />\n';
    }

    // Forward-compatible mappings for idioms likely to be added
    if (toolSet.has('mcp')) {
      agyRules += '    <permission action="mcp" target="*" />\n';
    }
    if (toolSet.has('fetch') || toolSet.has('curl')) {
      agyRules += '    <permission action="read_url" target="*" />\n';
    }

    agyRules += '  </auto_approve>\n</rule>\n';
  }

  return agyFm + parsed.body.trim() + '\n' + agyRules;
}
