import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { kbSetupSchema } from '../src/tools/kb-setup.js';

// The 0.4.5 release notes may only name commands and options that exist: every
// `apra-fleet ...` command must be in the help listing in src/index.ts, the
// kb_setup option it names must be in kbSetupSchema, and the file is ASCII.

const root = path.resolve(__dirname, '..');
const notesPath = path.join(root, 'docs', 'release-notes-0.4.5.md');
const notes = fs.readFileSync(notesPath, 'utf-8');
const help = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf-8');

/** Every backticked `apra-fleet ...` command in the notes. */
function namedCommands(text: string): string[] {
  return [...text.matchAll(/`(apra-fleet [^`]+)`/g)].map((m) => m[1]);
}

/** The command words up to the first <arg> / [arg] placeholder. */
function commandWords(cmd: string): string[] {
  const words = cmd.trim().split(/\s+/);
  const cut = words.findIndex((w) => w.startsWith('<') || w.startsWith('['));
  return cut === -1 ? words : words.slice(0, cut);
}

/**
 * True when the help listing has a line starting with the command words. A
 * command with a <placeholder> must match every word before it; one without
 * may carry one trailing plain argument (`kb embedding none`).
 */
function inHelp(cmd: string): boolean {
  const words = commandWords(cmd);
  const hasPlaceholder = words.length < cmd.trim().split(/\s+/).length;
  const shortest = hasPlaceholder ? words.length : Math.max(3, words.length - 1);
  for (let n = words.length; n >= shortest; n--) {
    const prefix = words.slice(0, n).join(' ');
    if (new RegExp(`^\\s+${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(help)) return true;
  }
  return false;
}

describe('release notes 0.4.5', () => {
  it('names the commands the section is about', () => {
    const cmds = namedCommands(notes).map((c) => commandWords(c).join(' '));
    expect(cmds.some((c) => c.startsWith('apra-fleet kb embedding'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('apra-fleet kb model import'))).toBe(true);
  });

  it('every apra-fleet command it names is in the src/index.ts help listing', () => {
    for (const cmd of namedCommands(notes)) {
      expect(inHelp(cmd), `not in the help listing: ${cmd}`).toBe(true);
    }
  });

  it('kb_setup accepts embedding_model', () => {
    expect(notes).toContain('kb_setup');
    expect(notes).toContain('embedding_model');
    expect(Object.keys(kbSetupSchema.shape)).toContain('embedding_model');
  });

  it('is ASCII only and short', () => {
    expect(/[^\x00-\x7F]/.test(notes)).toBe(false);
    expect(notes.split('\n').length).toBeLessThanOrEqual(45);
  });
});
