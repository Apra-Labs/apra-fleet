// Per-install member access secret (apra-fleet-b4g.122.4).
//
// Every apra-fleet install keeps one random secret in an owner-only file in
// its OWN data dir (<data dir>/member-access.key, mode 0600). Its server
// accepts a `?member=<uuid>` MCP session only when the request presents that
// secret in the MEMBER_SECRET_HEADER header (src/services/http-transport.ts).
// The server binds loopback, so without this any local user's session could
// reach any member install on the host; with it, only a reader of the
// install's data dir -- its own user -- can open a member session there.
//
// Who presents it:
//  - the client's connectFleetMember (packages/apra-fleet-client), which reads
//    the secret from the same data dir it resolves the server from -- so the
//    `apra-fleet call` verb on a member and the engine's memberCall work;
//  - Claude sessions execute_prompt starts: the per-session MCP config carries
//    it as an http header (session-mcp-config.ts);
//  - the per-folder member MCP entry compose_permissions writes (claude local
//    scope in ~/.claude.json, opencode's opencode.json).
//
// For a LOCAL member the orchestrator's own secret is used (it shares this
// server). For a REMOTE member the orchestrator reads its install's secret on
// the member during the fleetMcp probe -- and creates it there when an older
// install has none and an install was requested (fleet_install "auto") -- and
// keeps it encrypted in the registry (Agent.encryptedMemberMcpSecret).
//
// The secret NEVER appears in a member-bound command string: it is created on
// the member through the owner-only secret-file channel (SFTP / private temp
// file) and moved into place with a content-free command, and every config
// file carrying it is delivered the same way. Reading it back uses `cat` /
// Get-Content, whose command names only the path.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Agent } from '../types.js';
import { FLEET_DIR } from '../paths.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../utils/agent-helpers.js';
import { decryptPassword } from '../utils/crypto.js';
import { joinMemberPath, quotePosixPath, quotePwshPath, readMemberFile, type MemberExecFn } from './member-config-io.js';

/** File name of the secret inside an install's data dir. */
export const MEMBER_ACCESS_SECRET_FILE = 'member-access.key';

/** The HTTP header a `?member=` request carries the secret in. A dedicated
 *  header (not Authorization) so it never meets the member-JWT bearer check. */
export const MEMBER_SECRET_HEADER = 'X-Apra-Fleet-Member-Secret';

const SECRET_RE = /^[0-9a-f]{64}$/;

/** True for a well-formed secret (64 lowercase hex chars). */
export function isValidMemberAccessSecret(v: unknown): v is string {
  return typeof v === 'string' && SECRET_RE.test(v);
}

/** A fresh random secret. */
export function generateMemberAccessSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Absolute path of the secret file in `dataDir` (default: this process's data dir). */
export function memberAccessSecretPath(dataDir: string = FLEET_DIR): string {
  return path.join(dataDir, MEMBER_ACCESS_SECRET_FILE);
}

/** The secret stored at `filePath`, or null when missing, unreadable or malformed. */
export function readMemberAccessSecret(filePath: string = memberAccessSecretPath()): string | null {
  try {
    const v = fs.readFileSync(filePath, 'utf8').trim();
    return isValidMemberAccessSecret(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The secret at `filePath`, created (owner-only, 0600) when missing or
 * malformed. Creation is exclusive (`wx`): two processes racing to create it
 * agree on whichever landed first. Windows ignores the mode; the file then
 * inherits the user profile's ACL, as fleet.key does.
 */
export function getOrCreateMemberAccessSecret(filePath: string = memberAccessSecretPath()): string {
  const existing = readMemberAccessSecret(filePath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const secret = generateMemberAccessSecret();
  try {
    fs.writeFileSync(filePath, secret + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return secret;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Present but malformed (EEXIST): another writer won the race, or a corrupt
  // file sits there. Use a valid one; replace a corrupt one.
  const raced = readMemberAccessSecret(filePath);
  if (raced) return raced;
  fs.writeFileSync(filePath, secret + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }
  return secret;
}

/** Constant-time comparison of a presented header value with the expected secret. */
export function memberAccessSecretMatches(presented: string | string[] | undefined, expected: string | null): boolean {
  if (!expected || typeof presented !== 'string') return false;
  const a = Buffer.from(presented.trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The secret a session for `agent` must present to the member's own server:
 * this install's own secret for a local member (it shares this server), the
 * stored copy of the member install's secret for a remote one (null until a
 * fleetMcp probe read it -- an install older than the secret does not check it).
 */
export function memberMcpSecret(agent: Pick<Agent, 'agentType' | 'encryptedMemberMcpSecret'>): string | null {
  if (agent.agentType === 'local') {
    try { return getOrCreateMemberAccessSecret(); } catch { return null; }
  }
  if (!agent.encryptedMemberMcpSecret) return null;
  try {
    const v = decryptPassword(agent.encryptedMemberMcpSecret);
    return isValidMemberAccessSecret(v) ? v : null;
  } catch {
    return null;
  }
}

/** The headers a member MCP entry/config carries for `agent` (undefined when no secret is known). */
export function memberMcpHeaders(agent: Pick<Agent, 'agentType' | 'encryptedMemberMcpSecret'>): Record<string, string> | undefined {
  const secret = memberMcpSecret(agent);
  return secret ? { [MEMBER_SECRET_HEADER]: secret } : undefined;
}

// ---------------------------------------------------------------------------
// Remote members: the secret in the member install's data dir
// ---------------------------------------------------------------------------

/** <home>/.apra-fleet/data/member-access.key on the member (the member-install marker's dir). */
export function memberAccessSecretPathFor(home: string, agent: Agent): string {
  return joinMemberPath(home, `.apra-fleet/data/${MEMBER_ACCESS_SECRET_FILE}`, getAgentOS(agent) === 'windows', getAgentShell(agent));
}

/**
 * The content-free command that moves a staged secret file into `target`
 * (creating its directory). POSIX also forces 0600 on the result; the staged
 * file is owner-only already. Carries resolved, quoted paths only.
 */
export function moveStagedFileCommand(staged: string, target: string, posix: boolean): string {
  if (posix) {
    const dir = target.split('/').slice(0, -1).join('/');
    return `mkdir -p ${quotePosixPath(dir)} && mv -f ${quotePosixPath(staged)} ${quotePosixPath(target)} && chmod 600 ${quotePosixPath(target)}`;
  }
  const t = target.replace(/\//g, '\\');
  const dir = t.split('\\').slice(0, -1).join('\\');
  return `New-Item -ItemType Directory -Force -Path ${quotePwshPath(dir)} | Out-Null; Move-Item -Force -LiteralPath ${quotePwshPath(staged.replace(/\//g, '\\'))} -Destination ${quotePwshPath(t)}`;
}

/** Stages content in a fresh owner-only file on the member; returns its path. */
export type StageSecretFileFn = (agent: Agent, content: string) => Promise<string>;

/**
 * Writes `content` to the member-side `target` WITHOUT it ever appearing in a
 * command string: staged through the owner-only secret-file channel, then
 * moved into place by a content-free command. A failed move removes the
 * staged file (best effort, via `removeStaged`). Throws on failure.
 */
export async function deliverMemberFileViaSecretChannel(
  agent: Agent,
  exec: MemberExecFn,
  target: string,
  content: string,
  stage: StageSecretFileFn,
  removeStaged?: (agent: Agent, filePath: string) => Promise<void>,
): Promise<void> {
  const posix = isPosixShell(getAgentOS(agent), getAgentShell(agent));
  const staged = await stage(agent, content);
  const r = await exec(moveStagedFileCommand(staged, target, posix), 15000);
  if (r.code !== 0) {
    if (removeStaged) { try { await removeStaged(agent, staged); } catch { /* best effort */ } }
    throw new Error(`moving the staged file into ${target} failed (exit ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
}

export type RemoteMemberSecretResult =
  | { kind: 'found'; secret: string }
  | { kind: 'created'; secret: string }
  | { kind: 'absent'; detail: string }
  | { kind: 'failed'; detail: string };

/**
 * Reads the member install's secret; when it has none (an install older than
 * the secret) and `create` is set (an install was requested: fleet_install
 * "auto"), creates one there through the secret-file channel and verifies it
 * landed. Never throws.
 */
export async function ensureRemoteMemberAccessSecret(
  agent: Agent,
  home: string,
  deps: { exec: MemberExecFn; stage?: StageSecretFileFn; removeStaged?: (agent: Agent, filePath: string) => Promise<void> },
  create: boolean,
): Promise<RemoteMemberSecretResult> {
  const posix = isPosixShell(getAgentOS(agent), getAgentShell(agent));
  const target = memberAccessSecretPathFor(home, agent);
  const read = async (): Promise<string | null> => {
    const v = (await readMemberFile(deps.exec, target, posix)).trim();
    return isValidMemberAccessSecret(v) ? v : null;
  };
  try {
    const existing = await read();
    if (existing) return { kind: 'found', secret: existing };
    if (!create || !deps.stage) {
      return { kind: 'absent', detail: `the member install has no member access secret at ${target} (an install older than the secret, whose server does not check it); run update_member with fleet_install "auto" to create it` };
    }
    const secret = generateMemberAccessSecret();
    await deliverMemberFileViaSecretChannel(agent, deps.exec, target, secret + '\n', deps.stage, deps.removeStaged);
    const back = await read();
    if (back !== secret) return { kind: 'failed', detail: `the member access secret written to ${target} did not read back` };
    return { kind: 'created', secret };
  } catch (err: unknown) {
    return { kind: 'failed', detail: `the member access secret at ${target} could not be read or created: ${err instanceof Error ? err.message : String(err)}` };
  }
}
