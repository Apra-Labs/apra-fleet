import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const activateSkillSchema = z.object({
  name: z.string().describe('The name of the skill to activate (e.g. "pm", "fleet")'),
});

export type ActivateSkillInput = z.infer<typeof activateSkillSchema>;

export async function activateSkill(input: ActivateSkillInput): Promise<string> {
  const home = os.homedir();
  const skillDirs = [
    path.join(home, '.claude', 'skills', input.name),
    path.join(home, '.gemini', 'skills', input.name),
    path.join(home, '.codex', 'skills', input.name),
    path.join(home, '.copilot', 'skills', input.name),
  ];

  for (const dir of skillDirs) {
    const skillFile = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      const content = fs.readFileSync(skillFile, 'utf-8');
      return `✓ Skill "${wrapQuote(input.name)}" activated.\n\n${content}`;
    }
  }

  return `⋽ Skill "${wrapQuote(input.name)}" not found. Ensure it is installed via "apra-fleet install --skill ${input.name}".`; 
}

function wrapQuote(s: string) { return '\"' + s + '\"'; }
