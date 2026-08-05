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

export function transformAgentForOpenCode(content: string, _filename: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return content;

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

  return opencodeFm + body;
}

export function transformAgentForAgy(content: string, _filename: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return content;

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
    for (const tool of tools) {
      const mapped = agyToolMap[tool] || [tool];
      for (const m of mapped) mappedTools.add(m);
    }

    agyFm += `tools: [${Array.from(mappedTools).join(', ')}]\n`;
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

  return agyFm + body.trim() + '\n' + agyRules;
}
