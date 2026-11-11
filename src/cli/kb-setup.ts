// `apra-fleet kb-setup --remote <url> --token-ref <NAME>`
//
// Points this install's KB at a remote KB server whose token comes from fleet
// secret NAME, then checks it with one KB call. provision_kb_auth runs it on a
// remote member over SSH, right after pushing the secret there: member sessions
// never get the kb_setup tool, so this verb is the member-side channel. It calls
// kbSetup in-process, with the same checks (a missing, expired or deny secret is
// refused), writes the config only when it does not already name this remote and
// secret, and never installs a git hook.
//
// The last stdout line is JSON for the orchestrator:
//   {"kbSetup":"written"|"unchanged","previous"?:<what a write replaced>,"verification":"verified"|"rejected"|"unreachable"|"unverified"}
// previous (only with written) is missing, not-http (sqlite), other-remote,
// other-token or unreadable. A failed verification keeps what was written.
// A refusal exits 1 with {"error":"refused"} and the reason on stderr. No line
// carries a token.
//
// --check writes nothing, needs no secret and makes no KB call: it prints
// {"check":<kbConfigMatch>} (match, missing, not-http, other-remote,
// other-token or unreadable), so the orchestrator can leave a member KB that is
// set up for something else alone before it mints anything.
//
// --keep makes the write itself refuse a config set up for something else
// (other-remote, other-token, not-http, unreadable), in the process that
// writes, so a change made after the --check is never overwritten. It exits 1
// with {"error":"kept","check":<what it found>}. No config, or one already
// naming this remote and secret, goes ahead.

import { kbConfigMatch } from '../services/knowledge/kb-config.js';
import { HttpKbProvider, KbHttpAuthError, isConnectionError } from '../services/knowledge/http-provider.js';
import { SqliteProvider } from '../services/knowledge/sqlite-provider.js';
import { assertKbTokenSecretUsable, kbSetup } from '../tools/kb-setup.js';
import { formatSecretToken } from '../services/secret-token.js';

export const KB_SETUP_USAGE = 'Usage: apra-fleet kb-setup --remote <http(s) url> --token-ref <secret name> [--check | --keep]';

const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export type KbSetupVerification = 'verified' | 'rejected' | 'unreachable' | 'unverified';

interface Io {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultIo: Io = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/**
 * What a failed KB call says about the token. Only a successful answer verifies
 * it: any other status (a 404 from a wrong --remote, say) is unverified.
 */
export function classifyVerifyError(err: unknown): KbSetupVerification {
  if (err instanceof KbHttpAuthError) return err.reason === 'rejected' ? 'rejected' : 'unverified';
  if (isConnectionError(err)) return 'unreachable';
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'HTTP_401' || code === 'HTTP_403') return 'rejected';
  return 'unverified';
}

/** One authenticated KB call with the secret, through the same provider code the fleet server uses. */
async function verify(remote: string, name: string): Promise<KbSetupVerification> {
  const provider = new HttpKbProvider(remote, { secretName: name }, new SqliteProvider(':memory:'));
  try {
    await provider.verifyAuth();
    return 'verified';
  } catch (err) {
    return classifyVerifyError(err);
  } finally {
    provider.dispose();
  }
}

function parseArgs(args: string[]): { remote: string; name: string; check: boolean; keep: boolean } | null {
  let remote: string | undefined;
  let name: string | undefined;
  let check = false;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') check = true;
    else if (a === '--keep') keep = true;
    else if (a === '--remote' && args[i + 1] !== undefined) remote = args[++i];
    else if (a === '--token-ref' && args[i + 1] !== undefined) name = args[++i];
    else return null;
  }
  if (!remote || !name || !NAME_REGEX.test(name)) return null;
  return { remote, name, check, keep };
}

/** Run the verb; returns the process exit code. */
export async function runKbSetupCli(args: string[], io: Io = defaultIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.log(KB_SETUP_USAGE);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed) {
    io.error(KB_SETUP_USAGE);
    io.log(JSON.stringify({ error: 'usage' }));
    return 1;
  }
  const { remote, name } = parsed;
  if (parsed.check) {
    io.log(JSON.stringify({ check: kbConfigMatch(remote, name) }));
    return 0;
  }
  let previous: string | undefined;
  try {
    // The same refusals as the kb_setup tool, also when the config already matches.
    assertKbTokenSecretUsable(name);
    const match = kbConfigMatch(remote, name);
    if (parsed.keep && match !== 'match' && match !== 'missing') {
      io.error(`Error: the KB config here is set up for something else (${match}); --keep leaves it as it is`);
      io.log(JSON.stringify({ error: 'kept', check: match }));
      return 1;
    }
    if (match !== 'match') {
      await kbSetup({ provider: 'http', remote, token: formatSecretToken(name) }, undefined, { hook: false });
      previous = match;
    }
  } catch (err) {
    io.error(`Error: ${(err as Error).message}`);
    io.log(JSON.stringify({ error: 'refused' }));
    return 1;
  }
  const verification = await verify(remote, name);
  io.log(JSON.stringify(previous ? { kbSetup: 'written', previous, verification } : { kbSetup: 'unchanged', verification }));
  return 0;
}
