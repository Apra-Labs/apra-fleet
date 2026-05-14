import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const brainWriteSchema = z.object({
  ...memberIdentifier,
  content: z.string().describe('The knowledge or information to store in the brain'),
  collection: z.string().optional().describe('Optional brain collection or namespace'),
  metadata: z.string().optional().describe('Optional JSON metadata to attach to the stored knowledge'),
});

export type BrainWriteInput = z.infer<typeof brainWriteSchema>;

export async function brainWrite(input: BrainWriteInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain stores pages via put_page. Generate a unique slug under the
  // collection namespace (or "notes" if none given). Metadata is embedded
  // in YAML frontmatter inside the content.
  const ns = input.collection ?? 'notes';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = `${ns}/${ts}`;
  const frontmatter = input.metadata
    ? `---\ntags: [${ns}]\nmetadata: ${input.metadata}\n---\n`
    : `---\ntags: [${ns}]\n---\n`;
  return callGbrainTool('put_page', {
    slug,
    content: frontmatter + input.content,
  });
}
