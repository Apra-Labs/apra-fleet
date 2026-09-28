/**
 * What lazyfleet adds to Claude, told to Claude on every conversation turn.
 *
 * The person never names lazyfleet or learns its words: they ask for a job,
 * and Claude picks the right way to do it (inline, workers, a sprint, a flow).
 * Skills load only when their description matches, which a request like
 * "fill my timesheet every evening" does not, so the proxy appends this short
 * note to the system prompt of every main Claude Code request. It stays the
 * same from turn to turn, so prompt caching is unaffected.
 *
 * Not added to side requests (titles, summaries: no Bash tool), to flow
 * blocks (they carry the x-lazyfleet-role header, see runner.ts), or twice.
 */
import os from 'node:os';
import path from 'node:path';

export const ROLE_HEADER = 'x-lazyfleet-role';

const MARK = 'lazyfleet is installed on this machine.';

export function skillDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'skills', 'fleet');
}

export function guideNote(): string {
  const dir = skillDir();
  return [
    `${MARK} It extends what you can do for the user. They never need to name it or learn its terms: notice when a request fits, and offer it in plain words.`,
    `- A job to be done the same way again and again, or at set times ("every evening", "each Monday", "after every release"), that is not a change to a codebase (filling a timesheet, posting a summary, checking something and reporting it): build it as a flow. Read ${path.join(dir, 'flows.md')} and follow it; the user only approves it on a page you link.`,
    `- A big code job (a whole feature, a batch of issues, work to finish while they are away): offer to hand it to helpers as a sprint. See ${path.join(dir, 'autonomy.md')}.`,
    '- Describe what will happen, not how: "I will set this up to run every weekday at 6pm; approve it once here: <link>", not flow, block, sprint or tool names.',
  ].join('\n');
}

/** A Claude Code turn with tools (not a title or summary side request), and not one of lazyfleet's own flow blocks. */
export function wantsGuide(body: any, headers: Record<string, string | string[] | undefined>): boolean {
  if (headers[ROLE_HEADER]) return false;
  return Array.isArray(body?.tools) && body.tools.some((t: any) => t?.name === 'Bash');
}

export function appendGuide(body: any): any {
  const note = guideNote();
  const system = body.system;
  if (system === undefined || system === null) return { ...body, system: [{ type: 'text', text: note }] };
  if (typeof system === 'string') return system.includes(MARK) ? body : { ...body, system: `${system}\n\n${note}` };
  if (Array.isArray(system)) {
    if (system.some((b: any) => typeof b?.text === 'string' && b.text.startsWith(MARK))) return body;
    return { ...body, system: [...system, { type: 'text', text: note }] };
  }
  return body;
}
