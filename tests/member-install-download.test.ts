/**
 * Remote member install safety (apra-fleet-b4g.69.4):
 *  - the release asset download is time-bounded and checksum-verified, and its
 *    failures are typed, recoverable fleetMcp statuses;
 *  - `install --member --force` does not stop a running server a member install
 *    did not start unless explicitly forced.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { makeTestAgent } from './test-helpers.js';
import {
  parseSha256Sums,
  downloadVerifiedAsset,
  ensureMemberFleetInstall,
  ReleaseDownloadError,
  type MemberFleetInstallDeps,
} from '../src/services/member-fleet-install.js';

// ---------------------------------------------------------------------------
// Download integrity (real downloadVerifiedAsset over an injected fetch)
// ---------------------------------------------------------------------------

const ASSET = 'apra-fleet-installer-linux-x64';
const BASE = 'https://example.test/releases/download/v0.4.4/';
const BODY = Buffer.from('pretend-binary');
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');

function fetchFor(routes: Record<string, () => Promise<Response> | Response>): typeof fetch {
  return (async (url: string) => {
    const h = routes[url];
    if (!h) return new Response('nope', { status: 404 });
    return h();
  }) as unknown as typeof fetch;
}

describe('release asset download integrity', () => {
  it('parses a sha256sum-format list', () => {
    expect(parseSha256Sums(`${SHA}  ${ASSET}\n${'a'.repeat(64)} *other\n`, ASSET)).toBe(SHA);
    expect(parseSha256Sums(`${SHA}  other\n`, ASSET)).toBeNull();
  });

  it('a verified asset is written and its path returned', async () => {
    const p = await downloadVerifiedAsset(BASE + ASSET, ASSET, {
      fetchImpl: fetchFor({
        [BASE + 'SHA256SUMS']: () => new Response(`${SHA}  ${ASSET}\n`),
        [BASE + ASSET]: () => new Response(BODY),
      }),
    });
    try { expect(fs.readFileSync(p).equals(BODY)).toBe(true); } finally { fs.rmSync(p.replace(ASSET, ''), { recursive: true, force: true }); }
  });

  it('a checksum mismatch throws checksum-mismatch and writes nothing', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('apra-fleet-member-install-')).length;
    await expect(downloadVerifiedAsset(BASE + ASSET, ASSET, {
      fetchImpl: fetchFor({
        [BASE + 'SHA256SUMS']: () => new Response(`${'0'.repeat(64)}  ${ASSET}\n`),
        [BASE + ASSET]: () => new Response(BODY),
      }),
    })).rejects.toMatchObject({ name: 'ReleaseDownloadError', reason: 'checksum-mismatch' });
    expect(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('apra-fleet-member-install-')).length).toBe(before);
  });

  it('a missing published checksum fails closed as checksum-unavailable', async () => {
    await expect(downloadVerifiedAsset(BASE + ASSET, ASSET, {
      fetchImpl: fetchFor({ [BASE + ASSET]: () => new Response(BODY) }),
    })).rejects.toMatchObject({ reason: 'checksum-unavailable' });
  });

  it('a hung download is bounded by the timeout and typed download-timeout', async () => {
    const hang: typeof fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
    })) as unknown as typeof fetch;
    await expect(downloadVerifiedAsset(BASE + ASSET, ASSET, { fetchImpl: hang, timeoutMs: 30 }))
      .rejects.toMatchObject({ reason: 'download-timeout' });
  });

  it('a non-200 asset download is download-failed', async () => {
    await expect(downloadVerifiedAsset(BASE + ASSET, ASSET, {
      fetchImpl: fetchFor({ [BASE + 'SHA256SUMS']: () => new Response(`${SHA}  ${ASSET}\n`) }),
    })).rejects.toMatchObject({ reason: 'download-failed' });
  });
});

function depsWithDownloadError(err: Error): MemberFleetInstallDeps {
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  return {
    exec: async (_a, command) => (command.includes('--version') ? ok('__APRA_FLEET_NO_INSTALL__\n') : ok('x86_64\n')),
    transfer: async () => ({ success: [], failed: [] }),
    resolveHome: async () => '/home/bella',
    orchestratorPlatform: () => ({ os: 'macos', arch: 'arm64' }),
    orchestratorExecutable: () => null,
    orchestratorVersion: () => 'v0.4.4',
    downloadReleaseAsset: async () => { throw err; },
    removeLocal: () => {},
  };
}

describe('download failures surface as typed, recoverable fleetMcp statuses', () => {
  for (const reason of ['download-timeout', 'checksum-mismatch', 'checksum-unavailable'] as const) {
    it(`${reason} -> unavailable(${reason}), never a throw`, async () => {
      const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), depsWithDownloadError(new ReleaseDownloadError(reason, 'x')));
      expect(r).toMatchObject({ state: 'unavailable', reason });
    });
  }
});

describe('a refused install over a running full-install server is typed full-install-running', () => {
  it('maps the installer refusal code and names the override', async () => {
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    let installed = false;
    const deps: MemberFleetInstallDeps = {
      ...depsWithDownloadError(new Error('unused')),
      orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
      orchestratorExecutable: () => '/opt/fleet/apra-fleet',
      transfer: async (_a, p) => ({ success: p, failed: [] }),
      exec: async (_a, command) => {
        if (command.includes('--version')) return ok('__APRA_FLEET_NO_INSTALL__\n');
        if (command.includes('uname -m')) return ok('x86_64\n');
        installed = true;
        return { stdout: '', stderr: 'Error: E-FULL-INSTALL-RUNNING: pid 42 runs from /x', code: 3 };
      },
    };
    const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), deps);
    expect(installed).toBe(true);
    expect(r).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect((r as { detail: string }).detail).toContain('--force-stop-full-install');
  });
});

