import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';

// A dropped network surfaces as E-KB-HTTP-UNREACHABLE for every connection
// error code, not just the original four. http.request is replaced by an
// emitter that fails with the given code.

afterEach(() => vi.restoreAllMocks());

function failWith(code: string): void {
  vi.spyOn(http, 'request').mockImplementation((() => {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.setTimeout = () => req;
    req.write = () => true;
    req.destroy = () => req;
    req.end = () => {
      setImmediate(() => {
        const err = new Error(`connect failed`) as NodeJS.ErrnoException;
        err.code = code;
        req.emit('error', err);
      });
    };
    return req;
  }) as unknown as typeof http.request);
}

describe('HttpKbProvider connection error codes', () => {
  it.each([
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
  ])('%s is E-KB-HTTP-UNREACHABLE', async (code) => {
    failWith(code);
    const provider = new HttpKbProvider('http://127.0.0.1:9', 'NOT_A_REAL_KEY');
    await expect(provider.query({ query: 'x' })).rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE' });
  });
});
