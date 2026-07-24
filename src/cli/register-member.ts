/**
 * `apra-fleet register-member` (stabilization Issue 26): a shell-drivable
 * wrapper around the same registration logic the `register_member` MCP tool
 * uses. The integ-test-playbook Part 2 "Test scenario" needs to register a
 * member, but the integ-test-runner agent role only has [Read, Bash, Grep,
 * Glob] tools and cannot call MCP tools -- so Part 2 could never complete.
 *
 * This does NOT fork the registration logic. It parses CLI flags into the raw
 * shape accepted by `registerMemberSchema`, runs them through that schema
 * (exactly as the MCP framework validates tool input before dispatch -- same
 * defaults, same validation), then calls the shared `registerMember(params)`
 * function in src/tools/register-member.ts. Both entry points converge on that
 * one function.
 */
import { registerMemberSchema, registerMember } from '../tools/register-member.js';
import { ZodError } from 'zod';

const USAGE = `apra-fleet register-member -- add a machine to the fleet from the shell

Usage:
  apra-fleet register-member --name <name> --path <work-folder> [options]

Required:
  --name <name>            Friendly name (letters, numbers, dots, dashes, underscores)
  --path <folder>          Working directory on the target machine

Common:
  --type <local|remote>    Member type (default: remote)
  --llm <provider>         LLM provider: claude|gemini|codex|copilot|agy|opencode|none (default: claude)
  --category <label>       Optional group label (e.g. "doers")
  --tags <a,b,c>           Comma-separated free-form tags (max 10)
  --unattended <mode>      Permission mode: false|auto|dangerous

Remote members:
  --host <host>            IP or hostname (required for remote)
  --port <n>               SSH port (default: 22)
  --username <user>        SSH username (required for remote)
  --auth <password|key>    Authentication method (required for remote)
  --password <pw>          SSH password (supports {{secure.NAME}} tokens)
  --key-path <path>        Path to SSH private key

Git access:
  --git-access <level>     read|push|admin|issues|full
  --git-repos <a,b>        Comma-separated repos (e.g. "Apra-Labs/ApraPipes")

Models:
  --model-cheap <id>       Curated cheap model
  --model-standard <id>    Curated standard model
  --model-premium <id>     Curated premium model
  --model-tier <k=v>       Per-member tier (k = cheap|standard|premium); repeatable

  --help, -h               Show this help`;

// Flags that take a value (everything else is treated as an error).
const VALUE_FLAGS = new Set([
  '--name', '--path', '--type', '--llm', '--category', '--tags', '--unattended',
  '--host', '--port', '--username', '--auth', '--password', '--key-path',
  '--git-access', '--git-repos',
  '--model-cheap', '--model-standard', '--model-premium', '--model-tier',
]);

interface ParsedFlags {
  values: Record<string, string>;
  modelTier: string[]; // repeatable --model-tier entries
}

function parseFlags(args: string[]): ParsedFlags {
  const values: Record<string, string> = {};
  const modelTier: string[] = [];
  for (let i = 0; i < args.length; i++) {
    let flag = args[i];
    let inlineValue: string | undefined;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq !== -1) {
      inlineValue = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`Unknown or unexpected argument "${args[i]}". Run 'apra-fleet register-member --help'.`);
    }
    const value = inlineValue !== undefined ? inlineValue : args[++i];
    if (value === undefined) {
      throw new Error(`Flag "${flag}" requires a value.`);
    }
    if (flag === '--model-tier') {
      modelTier.push(value);
    } else {
      values[flag] = value;
    }
  }
  return { values, modelTier };
}

/** Build the raw (pre-schema) object registerMemberSchema expects. */
function buildRawInput(parsed: ParsedFlags): Record<string, unknown> {
  const { values, modelTier } = parsed;
  const raw: Record<string, unknown> = {};

  const map: Record<string, string> = {
    '--name': 'friendly_name',
    '--path': 'work_folder',
    '--type': 'member_type',
    '--llm': 'llm_provider',
    '--category': 'category',
    '--unattended': 'unattended',
    '--host': 'host',
    '--username': 'username',
    '--auth': 'auth_type',
    '--password': 'password',
    '--key-path': 'key_path',
    '--git-access': 'git_access',
    '--model-cheap': 'model_cheap',
    '--model-standard': 'model_standard',
    '--model-premium': 'model_premium',
  };
  for (const [flag, key] of Object.entries(map)) {
    if (values[flag] !== undefined) raw[key] = values[flag];
  }

  if (values['--port'] !== undefined) {
    const port = Number(values['--port']);
    if (!Number.isFinite(port)) throw new Error(`--port must be a number (got "${values['--port']}").`);
    raw.port = port;
  }
  if (values['--tags'] !== undefined) {
    raw.tags = values['--tags'].split(',').map(s => s.trim()).filter(Boolean);
  }
  if (values['--git-repos'] !== undefined) {
    raw.git_repos = values['--git-repos'].split(',').map(s => s.trim()).filter(Boolean);
  }
  if (modelTier.length > 0) {
    const tiers: Record<string, string> = {};
    for (const entry of modelTier) {
      const eq = entry.indexOf('=');
      if (eq === -1) throw new Error(`--model-tier expects "key=value" (got "${entry}").`);
      const key = entry.slice(0, eq).trim();
      const val = entry.slice(eq + 1).trim();
      if (!['cheap', 'standard', 'premium'].includes(key)) {
        throw new Error(`--model-tier key must be cheap|standard|premium (got "${key}").`);
      }
      tiers[key] = val;
    }
    raw.model_tiers = tiers;
  }

  return raw;
}

export async function runRegisterMember(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  let raw: Record<string, unknown>;
  try {
    raw = buildRawInput(parseFlags(args));
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (raw.friendly_name === undefined || raw.work_folder === undefined) {
    console.error('Error: --name and --path are required.');
    console.error("Run 'apra-fleet register-member --help' for usage.");
    process.exitCode = 1;
    return;
  }

  // Validate + apply schema defaults exactly as the MCP framework does before
  // dispatching to the same handler.
  let parsed;
  try {
    parsed = registerMemberSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      console.error('Error: invalid arguments:');
      for (const issue of err.issues) {
        const where = issue.path.length ? issue.path.join('.') + ': ' : '';
        console.error(`  - ${where}${issue.message}`);
      }
    } else {
      console.error(`Error: ${(err as Error).message}`);
    }
    process.exitCode = 1;
    return;
  }

  const result = await registerMember(parsed);
  // registerMember returns a human-readable string. The success path always
  // contains "registered successfully"; every failure path returns a message
  // stating the member was NOT registered. Mirror that into an exit code.
  const ok = /registered successfully/i.test(result);
  if (ok) {
    console.log(result);
  } else {
    console.error(result);
    process.exitCode = 1;
  }
}
