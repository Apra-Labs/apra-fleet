/**
 * Transform Claude-format agent files to OpenCode format at install time.
 *
 * Claude frontmatter: name, description, tools (comma/list)
 * OpenCode frontmatter: description, mode: subagent, permission map (no name)
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
