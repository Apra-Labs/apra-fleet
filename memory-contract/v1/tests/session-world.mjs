// Materialise roundtrip-harness.mjs's ENVIRONMENT for an IN-PROCESS provider:
// the scratch repos on this host's disk, one registered fleet member per
// ENVIRONMENT.sessions entry, and one set of tool handlers per session
// registered under that member's session scope -- so a kb_* call dispatched
// through a session's handlers resolves that member's own KB, exactly as an
// MCP member session (?member=<id>) would.
//
// Shared by the sqlite round-trip adapter (tests/memory-contract-roundtrip.test.ts)
// and the fixture recorder (record-fixtures.mjs) so both build the identical
// world. Like the harness, it imports nothing from src/ or dist/: the fleet
// functions it needs are injected by the caller.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {object} env       roundtrip-harness.mjs ENVIRONMENT
 * @param {string} root      scratch root (already created)
 * @param {object} deps
 * @param {(key: string) => string} deps.remoteUrl   origin URL for a `remotes` key
 * @param {(agent: object) => void} deps.addAgent
 * @param {(id: string) => boolean} deps.removeAgent
 * @param {(server: object, scope?: object) => Promise<void>} deps.registerAllTools
 * @param {(memberId: string, channelCapable: boolean) => object} deps.memberToolScope
 */
export async function materializeSessionWorld(env, root, deps) {
  const repoPaths = new Map();
  for (const repo of env.repos) {
    const dir = path.join(root, repo.dir);
    fs.mkdirSync(dir, { recursive: true });
    repoPaths.set(repo.key, dir);
    for (const [rel, contents] of Object.entries(repo.files)) {
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, 'utf-8');
    }
    if (repo.git) {
      git(dir, ['init', '-q']);
      // A local identity so kb_export's auto-commit never depends on host config.
      git(dir, ['config', 'user.email', 'contract@example.test']);
      git(dir, ['config', 'user.name', 'contract']);
      if (repo.remote) git(dir, ['remote', 'add', 'origin', deps.remoteUrl(repo.remote)]);
    }
  }

  const memberIds = [];
  const sessionHandlers = new Map();
  const runTag = crypto.randomUUID().slice(0, 8);
  for (const [key, session] of Object.entries(env.sessions)) {
    const workFolder = session.repo ? repoPaths.get(session.repo) : path.join(root, session.dir);
    if (!workFolder) throw new Error(`session ${key} names unknown repo ${session.repo}`);
    const id = crypto.randomUUID();
    deps.addAgent({
      id,
      // Unique per run so a shared test registry never sees a name collision;
      // the label is what error messages print, so it is mapped back below.
      friendlyName: `${session.member}-${runTag}`,
      agentType: session.kind === 'remote' ? 'remote' : 'local',
      workFolder,
      createdAt: new Date().toISOString(),
      ...(session.kind === 'remote'
        ? { host: 'contract-remote.example.test', port: 22, username: 'contract', authType: 'key', gitRepos: [deps.remoteUrl(session.remote)] }
        : {}),
    });
    memberIds.push(id);

    const handlers = new Map();
    const fakeServer = {
      tool: (name, _description, _shape, handler) => { handlers.set(name, handler); },
      server: { sendLoggingMessage: async () => {} },
    };
    await deps.registerAllTools(fakeServer, deps.memberToolScope(id, false));
    sessionHandlers.set(key, handlers);
  }

  // Live member label -> recorded member label, for message normalisation.
  const memberLiterals = Object.values(env.sessions).map((s) => [s.member, `${s.member}-${runTag}`]);

  return {
    repoPaths,
    sessionHandlers,
    memberLiterals,
    cleanup() {
      for (const id of memberIds) deps.removeAgent(id);
    },
  };
}
