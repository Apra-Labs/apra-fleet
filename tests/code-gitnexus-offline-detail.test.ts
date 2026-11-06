import { describe, it, expect, vi, beforeEach } from 'vitest';

// The offline result must carry the real reason a gitnexus child failed: was it
// a timeout, in which stage, and what the child wrote to stderr, with no
// credential in the text. A nightly failure was undiagnosable because all of
// this was dropped.
//
// FALSIFICATION: removing captureChildStderr's listener fails every stderr
// assertion; treating every error as non-timeout in childFailureDetail fails
// the two TIMEOUT tests; removing scrubChildText fails the credential test.
//
// Isolation: the real MCP SDK client and stdio transport against a small local
// node child (no npx, no gitnexus). Only the command and the SDK timeouts are
// replaced. No repo is passed, so no index or disk state is involved.

const h = vi.hoisted(() => ({ script: '', connectTimeoutMs: 30_000, callTimeoutMs: 30_000, connectError: '' }));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>();
  class LocalChildTransport extends actual.StdioClientTransport {
    constructor(params: ConstructorParameters<typeof actual.StdioClientTransport>[0]) {
      super({ ...params, command: process.execPath, args: ['-e', h.script] });
    }
  }
  return { ...actual, StdioClientTransport: LocalChildTransport };
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/index.js')>();
  type Base = InstanceType<typeof actual.Client>;
  class ShortTimeoutClient extends actual.Client {
    async connect(...[transport, options]: Parameters<Base['connect']>) {
      if (h.connectError) throw new Error(h.connectError);
      return super.connect(transport, { ...options, timeout: h.connectTimeoutMs });
    }
    callTool(...[params, schema, options]: Parameters<Base['callTool']>) {
      return super.callTool(params, schema, { ...options, timeout: h.callTimeoutMs });
    }
  }
  return { ...actual, Client: ShortTimeoutClient };
});
vi.mock('../src/utils/find-on-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/find-on-path.js')>();
  return { ...actual, npxUnavailableReason: () => null };
});

import { GitNexusProvider } from '../src/tools/code-intelligence-gitnexus.js';
import { missingOnServerPathMessage } from '../src/utils/find-on-path.js';

const writesStderr = (text: string) => `process.stderr.write(${JSON.stringify(text)});`;
const staysSilent = 'setInterval(() => {}, 1000);';
// Answers the MCP handshake, then never answers anything else.
const answersHandshakeOnly = `
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {
          protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
        } }) + '\\n');
      }
    }
  });`;

async function offlineText(): Promise<string> {
  const result = await new GitNexusProvider().query({ query: 'x' }) as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/^Code intelligence is offline/);
  return result.content[0].text;
}

describe('gitnexus offline result carries the real reason', () => {
  beforeEach(() => {
    h.connectTimeoutMs = 30_000;
    h.callTimeoutMs = 30_000;
    h.connectError = '';
  });

  describe('the npx-not-on-PATH advice', () => {
    const pathAdvice = () => missingOnServerPathMessage('npx');
    const stderrWithEnoent = 'npm error enoent ENOENT: no such file, open C:\\cache\\_npx\\4f55926e\\package.json\n' +
      'Error: spawn npx ENOENT';

    it('appears when spawning npx itself fails', async () => {
      h.connectError = 'spawn npx ENOENT';
      const text = await offlineText();
      expect(text).toContain('spawn npx ENOENT');
      expect(text).toContain(pathAdvice());
    }, 30_000);

    it('does not appear when a child that died during connect wrote ENOENT and an _npx path', async () => {
      h.script = writesStderr(stderrWithEnoent) + 'process.exitCode = 3;';
      const text = await offlineText();
      expect(text).toContain('_npx');
      expect(text).toContain('spawn npx ENOENT');
      expect(text).not.toContain(pathAdvice());
    }, 40_000);

    it('does not appear when a call failed and the child wrote ENOENT and an _npx path', async () => {
      h.script = writesStderr(stderrWithEnoent) + answersHandshakeOnly;
      h.callTimeoutMs = 300;
      const text = await offlineText();
      expect(text).toContain('_npx');
      expect(text).not.toContain(pathAdvice());
    }, 40_000);
  });

  it('a child that never answers the handshake reports a connect TIMEOUT and its stderr', async () => {
    h.script = writesStderr('npm warn installing') + staysSilent;
    h.connectTimeoutMs = 4000;
    const text = await offlineText();
    expect(text).toMatch(/TIMEOUT during connect after \d+ ms: MCP error -32001: Request timed out/);
    expect(text).toContain('child stderr: npm warn installing');
  }, 30_000);

  it('a connected child that does not answer a call reports a call TIMEOUT and its stderr', async () => {
    h.script = writesStderr('opening index') + answersHandshakeOnly;
    h.callTimeoutMs = 300;
    const text = await offlineText();
    expect(text).toMatch(/TIMEOUT during call of query after \d+ ms: MCP error -32001: Request timed out/);
    expect(text).toContain('child stderr: opening index');
  }, 40_000);

  it('a child that dies during connect is a failure, not a timeout, with its stderr', async () => {
    h.script = writesStderr('npm error code 1\nnpm error gyp failed') + 'process.exitCode = 3;';
    const text = await offlineText();
    expect(text).not.toContain('TIMEOUT');
    expect(text).toMatch(/failed during connect after \d+ ms: .*Connection closed/);
    expect(text).toContain('child stderr: npm error code 1 npm error gyp failed');
  }, 40_000);

  it('says so when the child wrote nothing to stderr', async () => {
    h.script = 'process.exitCode = 3;';
    expect(await offlineText()).toContain('child stderr: (empty)');
  }, 40_000);

  it('keeps only the end of stderr and no credential in it', async () => {
    const secrets = ['npm_abcdefghijklmnopqrstuvwxyz', 'hunter2pass', 'ghp_abcdefghijklmnopqrstuvwxyz', 'sessiontokenvalue'];
    h.script = writesStderr(
      `${'x'.repeat(5000)}\n` +
      `npm error //registry.npmjs.org/:_authToken=${secrets[0]}\n` +
      `npm error fetch https://bob:${secrets[1]}@registry.example/pkg\n` +
      `npm error token ${secrets[2]}\n` +
      `npm error Authorization: Bearer ${secrets[3]}\n` +
      'last line',
    ) + 'process.exitCode = 3;';
    const text = await offlineText();
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain('registry.example/pkg');
    expect(text).toMatch(/last line\)$/);
    const stderr = text.slice(text.indexOf('child stderr: ') + 'child stderr: '.length);
    expect(stderr.length).toBeLessThanOrEqual(2001);
  }, 40_000);
});
