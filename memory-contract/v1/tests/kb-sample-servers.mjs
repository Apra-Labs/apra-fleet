// The KB servers behind the http-backed fixture sessions: fleet's own sample
// server (src/commands/kb-server.ts, startKbServer), so every http fixture is
// what that server really answers.
//
// Two servers, chosen by the variant a session names:
//   tagged         serves the http sessions' own project (the HTTP scratch
//                  repo). It holds one INFERRED entry tagged as another
//                  member's capture, so a member's own-scope read must not show it.
//   other-project  serves a different project (a scratch repo of its own, with
//                  a fixed origin), so every request from the http sessions is
//                  a 409 PROJECT_MISMATCH.
//
// startKbServer serves the project of process.cwd(), so each server is started
// from its project's folder (cwd restored afterwards), with an explicit
// database file and the committed obviously-fake token file. Servers start on
// first use: the HTTP scratch repo exists only once the session world is built
// (the seeded entry cites that repo's src/widget.ts, as a capture must).
//
// Node builtins plus the caller-supplied startKbServer, like the rest of this
// directory's harness code (the caller imports it from dist/ or src/).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HTTP_FOREIGN_OWNER_TAG = 'member:contract-http-foreign-owner';
export const HTTP_FOREIGN_ENTRY_TITLE = 'Widget batching (captured by another member)';
/** The 'other-project' server's origin remote: a fixed project slug in every run. */
export const HTTP_OTHER_PROJECT_REMOTE = 'https://example.test/memory-contract-other-project.git';
/** The 'other-project' server's URL as recorded in fixtures (the live port is ephemeral). */
export const HTTP_KB_RECORDED_OTHER_URL = 'http://other-project.kb.example.test';
export const HTTP_KB_VARIANTS = ['tagged', 'other-project'];

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function startFrom(folder, startKbServer, dbPath, tokenFile) {
  const cwd = process.cwd();
  process.chdir(folder);
  let server;
  try {
    server = await startKbServer(0, false, dbPath, tokenFile);
  } finally {
    process.chdir(cwd);
  }
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function seedForeignEntry(url, token) {
  const res = await fetch(`${url}/api/kb/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-KB-Project': await projectOf(url, token) },
    body: JSON.stringify({
      type: 'knowledge',
      title: HTTP_FOREIGN_ENTRY_TITLE,
      summary: 'The widget stage batches work per tick; captured by a member outside this session.',
      content: 'The widget stage batches work per tick.',
      source_files: ['src/widget.ts'],
      symbols: [],
      tags: [HTTP_FOREIGN_OWNER_TAG],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'test',
      source: 'doer',
      confidence: 'INFERRED',
    }),
  });
  if (res.status !== 201) throw new Error(`kb sample server: seeding the foreign entry answered HTTP ${res.status}: ${await res.text()}`);
}

// The server names its own project in a 409 to a request for none.
async function projectOf(url, token) {
  const res = await fetch(`${url}/api/kb/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (res.status !== 409 || typeof body.server_project !== 'string') {
    throw new Error(`kb sample server: expected a 409 naming the server project, got HTTP ${res.status}`);
  }
  return body.server_project;
}

/**
 * @param {object} deps
 * @param {(port: number, generateToken: boolean, dbPath?: string, tokenFile?: string) => Promise<import('node:http').Server>} deps.startKbServer
 * @param {string} deps.tokenFile  file holding the bearer token the servers accept
 * @param {string} deps.scratchDir  a folder this helper may write (databases, the other project's repo)
 * @param {() => string} deps.servedFolder  the http sessions' repo folder (exists once the session world is built)
 * @returns {{ urlFor: (variant: string) => Promise<string>, close: () => Promise<void> }}
 */
export function createKbSampleServers({ startKbServer, tokenFile, scratchDir, servedFolder }) {
  const started = new Map();
  const token = fs.readFileSync(tokenFile, 'utf-8').trim();

  async function start(variant) {
    fs.mkdirSync(scratchDir, { recursive: true });
    if (variant === 'tagged') {
      const s = await startFrom(servedFolder(), startKbServer, path.join(scratchDir, 'kb-sample-tagged.sqlite'), tokenFile);
      await seedForeignEntry(s.url, token);
      return s;
    }
    const other = path.join(scratchDir, 'other-project');
    fs.mkdirSync(other, { recursive: true });
    if (!fs.existsSync(path.join(other, '.git'))) {
      git(other, ['init', '-q']);
      git(other, ['remote', 'add', 'origin', HTTP_OTHER_PROJECT_REMOTE]);
    }
    return startFrom(other, startKbServer, path.join(scratchDir, 'kb-sample-other.sqlite'), tokenFile);
  }

  return {
    async urlFor(variant) {
      if (!HTTP_KB_VARIANTS.includes(variant)) {
        throw new Error(`kb sample server: unknown variant "${variant}" (expected ${HTTP_KB_VARIANTS.join(' or ')})`);
      }
      if (!started.has(variant)) started.set(variant, start(variant));
      return (await started.get(variant)).url;
    },
    async close() {
      for (const pending of started.values()) {
        const { server } = await pending;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(() => resolve()));
      }
      started.clear();
    },
  };
}
