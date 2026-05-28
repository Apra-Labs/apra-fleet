import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { isContainedInWorkFolder } from '../utils/platform.js';
import { LogScope } from '../utils/log-helpers.js';
import { validateSubstitutionKeys, applySubstitutions } from '../services/substitution-engine.js';
import type { Agent } from '../types.js';

export const sendFilesSchema = z.object({
  ...memberIdentifier,
  local_paths: z.array(z.string()).describe('Array of local file paths to upload'),
  dest_subdir: z.string().optional().describe(
    'Destination subdirectory relative to work_folder on the member. ' +
    'Defaults to work_folder root (equivalent to "."). ' +
    'Paths outside work_folder are rejected.'
  ),
  substitutions: z.record(z.string(), z.string()).optional().describe(
    'Optional map of token name to replacement value. ' +
    'When provided, every occurrence of {{name}} in each file is replaced before transfer. ' +
    'Keys must match [A-Za-z_][A-Za-z0-9_]*. Missing tokens cause the call to fail with no files written. ' +
    'Extra keys are silently ignored. Values are never logged.'
  ),
});

export type SendFilesInput = z.infer<typeof sendFilesSchema>;

export async function sendFiles(input: SendFilesInput, extra?: any): Promise<string> {
  // Validate substitution keys FIRST -- before any file I/O, before setting busy.
  // Satisfies the invariant: key rejection has zero side effects.
  if (input.substitutions !== undefined) {
    const keyCheck = validateSubstitutionKeys('send_files', input.substitutions);
    if (!keyCheck.ok) return keyCheck.error;
  }

  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `Failed to upload files to "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  if (input.dest_subdir?.includes('\0')) {
    return `⛔ Invalid dest_subdir: null bytes are not allowed.`;
  }

  // Path security: verify dest_subdir stays within work_folder
  let resolvedPath: string | undefined;
  if (input.dest_subdir) {
    if (agent.agentType === 'local') {
      const resolved = path.resolve(agent.workFolder, input.dest_subdir);
      const workFolderNorm = path.resolve(agent.workFolder);
      if (resolved !== workFolderNorm && !resolved.startsWith(workFolderNorm + path.sep)) {
        return 'dest_subdir resolves outside member work_folder -- write blocked';
      }
      resolvedPath = resolved;
    } else {
      if (!isContainedInWorkFolder(agent.workFolder, input.dest_subdir)) {
        return 'dest_subdir resolves outside member work_folder -- write blocked';
      }
      const normWorkFolder = agent.workFolder.replace(/\\/g, '/').replace(/\/$/, '');
      const normSubdir = input.dest_subdir.replace(/\\/g, '/');
      const isAbsolute = /^[A-Za-z]:/.test(normSubdir) || normSubdir.startsWith('/');
      resolvedPath = isAbsolute ? normSubdir : `${normWorkFolder}/${normSubdir}`;
    }
  }

  // Pre-flight: detect basename collisions that would silently overwrite files
  const seen = new Map<string, string>();
  const collisionLines: string[] = [];
  for (const p of input.local_paths) {
    const bn = path.basename(p);
    const first = seen.get(bn);
    if (first !== undefined) {
      collisionLines.push(`  ${bn}: "${first}" and "${p}"`);
    } else {
      seen.set(bn, p);
    }
  }
  if (collisionLines.length > 0) {
    return `⛔ Basename collision: these files share a name and would overwrite each other at destination:\n${collisionLines.join('\n')}`;
  }

  // Substitution phase: read files, apply engine, write temp files.
  // This happens before setting busy so failures leave status unchanged.
  let transferPaths = input.local_paths;
  let tempDir: string | undefined;
  let warningLine = '';

  if (input.substitutions !== undefined) {
    let fileContents: string[];
    try {
      fileContents = input.local_paths.map(p => fs.readFileSync(p, 'utf-8'));
    } catch (err: any) {
      return `send_files: failed to read source file: ${err.message}`;
    }

    const subInputs = input.local_paths.map((p, i) => ({
      label: path.basename(p),
      content: fileContents[i],
    }));

    const result = applySubstitutions('send_files', subInputs, input.substitutions);
    if (!result.ok) return result.error;

    // Write transformed content to temp dir preserving basenames; transfer those paths.
    const tmpId = `apra-fleet-subst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempDir = path.join(os.tmpdir(), tmpId);
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      transferPaths = input.local_paths.map((p, i) => {
        const tmpPath = path.join(tempDir!, path.basename(p));
        fs.writeFileSync(tmpPath, result.outputs[i], 'utf-8');
        return tmpPath;
      });
    } catch (err: any) {
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      return `send_files: failed to prepare substituted files: ${err.message}`;
    }
  } else {
    // No substitutions: heuristic warning check (best-effort -- skip if file is unreadable).
    try {
      const fileContents = input.local_paths.map(p => fs.readFileSync(p, 'utf-8'));
      const subInputs = input.local_paths.map((p, i) => ({
        label: path.basename(p),
        content: fileContents[i],
      }));
      const result = applySubstitutions('send_files', subInputs, undefined);
      if (result.ok && result.warning) {
        warningLine = `\n⚠️ ${result.warning}`;
      }
    } catch { /* binary file or missing file -- skip warning */ }
  }

  const strategy = getStrategy(agent);
  const dest = resolvedPath ?? agent.workFolder;
  const scope = new LogScope('send_files', `${input.local_paths.length} file(s) -> ${dest}`, agent);

  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.transferFiles(transferPaths, input.dest_subdir, extra?.signal);

    touchAgent(agent.id); // T7: idle manager resets its timer via touchAgent

    let output = '';

    if (result.success.length > 0) {
      output += `✅ Successfully uploaded ${result.success.length} file(s) to ${agent.friendlyName}:\n`;
      for (const f of result.success) {
        output += `  - ${f}\n`;
      }
    }

    if (result.failed.length > 0) {
      output += `\n❌ Failed to upload ${result.failed.length} file(s):\n`;
      for (const f of result.failed) {
        output += `  - ${f.path}: ${f.error}\n`;
      }
    }

    output += `\nDestination: ${resolvedPath ?? agent.workFolder}`;

    if (warningLine) output += warningLine;

    if (result.failed.length > 0 && result.success.length > 0)
      scope.fail(`${result.success.length} ok, ${result.failed.length} failed`);
    else if (result.failed.length > 0)
      scope.abort(`all ${result.failed.length} file(s) failed`);
    else
      scope.ok(`${result.success.length} file(s)`);

    return output;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    scope.abort(err.message);
    return `Failed to upload files to "${agent.friendlyName}": ${err.message}`;
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}
