/**
 * Unit tests for the concrete email providers (src/providers/email/sendgrid.ts,
 * src/providers/email/smtp.ts). Network I/O is mocked: global fetch for
 * SendGrid, and node:net/node:tls sockets (via an in-memory EventEmitter) for
 * SMTP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

import { SendGridProvider } from '../src/providers/email/sendgrid.js';

describe('SendGridProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends a plain-text message and returns the message id from response headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name === 'x-message-id' ? 'sg-abc-123' : null) },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new SendGridProvider({ apiKey: 'key-1', from: 'from@example.com' });
    const result = await provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' });

    expect(result).toEqual({ messageId: 'sg-abc-123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer key-1' }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.personalizations[0].to).toEqual([{ email: 'to@example.com' }]);
    expect(body.from).toEqual({ email: 'from@example.com' });
  });

  it('includes cc, bcc, html and attachments when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => null } });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new SendGridProvider({ apiKey: 'key-1', from: 'from@example.com' });
    await provider.send({
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'Hi',
      body: 'Hello',
      html: '<p>Hello</p>',
      attachments: [{ filename: 'a.txt', content: 'YWJj', contentType: 'text/plain' }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.personalizations[0].cc).toEqual([{ email: 'cc@example.com' }]);
    expect(body.personalizations[0].bcc).toEqual([{ email: 'bcc@example.com' }]);
    expect(body.content).toEqual([
      { type: 'text/plain', value: 'Hello' },
      { type: 'text/html', value: '<p>Hello</p>' },
    ]);
    expect(body.attachments).toEqual([{ filename: 'a.txt', content: 'YWJj', type: 'text/plain' }]);
  });

  it('falls back to a generated message id when the header is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => null } });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new SendGridProvider({ apiKey: 'key-1', from: 'from@example.com' });
    const result = await provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' });

    expect(result.messageId).toMatch(/^sendgrid-/);
  });

  it('throws with response status and body text when the API call fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('bad api key'),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new SendGridProvider({ apiKey: 'bad-key', from: 'from@example.com' });

    await expect(provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' })).rejects.toThrow(
      /SendGrid send failed \(401\): bad api key/,
    );
  });
});

// ---------------------------------------------------------------------------
// SMTP adapter -- mock node:net/node:tls with an in-memory fake socket that
// scripts the SMTP conversation.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  public written: string[] = [];
  private script: string[];

  constructor(script: string[]) {
    super();
    this.script = script;
  }

  write(data: string): boolean {
    this.written.push(data);
    // Reply with the next scripted response after each write, asynchronously.
    const next = this.script.shift();
    if (next !== undefined) {
      process.nextTick(() => this.emit('data', Buffer.from(next)));
    }
    return true;
  }

  end(): void {
    this.emit('end');
  }

  destroy(): void {
    this.emit('close');
  }

  removeAllListeners(event?: string | symbol): this {
    return super.removeAllListeners(event);
  }
}

const mockNetConnect = vi.fn();
const mockTlsConnect = vi.fn();

vi.mock('node:net', () => ({
  default: { connect: (...args: unknown[]) => mockNetConnect(...args) },
}));

vi.mock('node:tls', () => ({
  default: { connect: (...args: unknown[]) => mockTlsConnect(...args) },
}));

describe('SmtpProvider', () => {
  beforeEach(() => {
    mockNetConnect.mockReset();
    mockTlsConnect.mockReset();
  });

  it('performs the full SMTP handshake and returns a message id on success', async () => {
    // Greeting is emitted by connectSocket's callback path; the rest of the
    // conversation is scripted in response to each `write()`.
    const script = [
      '250-smtp.example.com\r\n250 AUTH LOGIN\r\n', // EHLO response (no STARTTLS -> stays plain)
      '334 VXNlcm5hbWU6\r\n', // AUTH LOGIN
      '334 UGFzc3dvcmQ6\r\n', // username
      '235 Authentication successful\r\n', // password
      '250 OK\r\n', // MAIL FROM
      '250 OK\r\n', // RCPT TO
      '354 Start mail input\r\n', // DATA
      '250 OK queued as ABC123\r\n', // message body
      '221 Bye\r\n', // QUIT
    ];
    const socket = new FakeSocket(script);

    mockNetConnect.mockImplementation((_opts: unknown, cb: () => void) => {
      // Use setTimeout (not nextTick) so the promise-continuation that
      // attaches the SmtpConnection's 'data' listener runs before the
      // greeting is emitted -- avoids a nextTick/microtask ordering race.
      setTimeout(() => cb(), 0);
      setTimeout(() => socket.emit('data', Buffer.from('220 smtp.example.com ready\r\n')), 5);
      return socket;
    });

    const { SmtpProvider } = await import('../src/providers/email/smtp.js');
    const provider = new SmtpProvider({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'secret' },
      from: 'from@example.com',
    });

    const result = await provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' });

    expect(result.messageId).toBe('ABC123');
    expect(socket.written.some(w => w.startsWith('MAIL FROM:<from@example.com>'))).toBe(true);
    expect(socket.written.some(w => w.startsWith('RCPT TO:<to@example.com>'))).toBe(true);
  });

  it('rejects when the server does not greet with 220', async () => {
    const socket = new FakeSocket([]);

    mockNetConnect.mockImplementation((_opts: unknown, cb: () => void) => {
      setTimeout(() => cb(), 0);
      setTimeout(() => socket.emit('data', Buffer.from('421 service not available\r\n')), 5);
      return socket;
    });

    const { SmtpProvider } = await import('../src/providers/email/smtp.js');
    const provider = new SmtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'user@example.com', pass: 'secret' },
      from: 'from@example.com',
    });

    await expect(provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' })).rejects.toThrow(
      /SMTP server did not greet/,
    );
  });

  it('rejects when MAIL FROM is rejected by the server', async () => {
    // auth.user is empty so the AUTH LOGIN step is skipped -- the next
    // command after EHLO is MAIL FROM.
    const script = [
      '250 smtp.example.com\r\n', // EHLO
      '550 Mailbox unavailable\r\n', // MAIL FROM rejected
    ];
    const socket = new FakeSocket(script);

    mockNetConnect.mockImplementation((_opts: unknown, cb: () => void) => {
      setTimeout(() => cb(), 0);
      setTimeout(() => socket.emit('data', Buffer.from('220 smtp.example.com ready\r\n')), 5);
      return socket;
    });

    const { SmtpProvider } = await import('../src/providers/email/smtp.js');
    const provider = new SmtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: '', pass: '' },
      from: 'from@example.com',
    });

    await expect(provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' })).rejects.toThrow(
      /MAIL FROM rejected/,
    );
  });

  it('rejects a subject containing CR/LF before any network I/O', async () => {
    const { SmtpProvider } = await import('../src/providers/email/smtp.js');
    const provider = new SmtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'user@example.com', pass: 'secret' },
      from: 'from@example.com',
    });

    await expect(
      provider.send({ to: 'to@example.com', subject: 'Hi\r\nBcc: evil@example.com', body: 'Hello' }),
    ).rejects.toThrow(/subject.*must not contain CR\/LF/);
    expect(mockNetConnect).not.toHaveBeenCalled();
  });

  it('rejects a from address containing CR/LF before any network I/O', async () => {
    const { SmtpProvider } = await import('../src/providers/email/smtp.js');
    const provider = new SmtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'user@example.com', pass: 'secret' },
      from: 'from@example.com\r\nRCPT TO:<evil@example.com>',
    });

    await expect(provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' })).rejects.toThrow(
      /from.*must not contain CR\/LF/,
    );
    expect(mockNetConnect).not.toHaveBeenCalled();
  });

  it('times out when the server never sends a response', async () => {
    const socket = new FakeSocket([]);

    mockNetConnect.mockImplementation((_opts: unknown, cb: () => void) => {
      setTimeout(() => cb(), 0);
      // Connect succeeds but the server never greets.
      return socket;
    });

    const { SmtpProvider } = await import('../src/providers/email/smtp.js');
    const provider = new SmtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'user@example.com', pass: 'secret' },
      from: 'from@example.com',
      timeoutMs: 50,
    });

    await expect(provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' })).rejects.toThrow(
      /SMTP response timeout after 50ms/,
    );
  });

  it('times out when the connection never completes', async () => {
    const socket = new FakeSocket([]);

    // Connect callback never fires.
    mockNetConnect.mockImplementation(() => socket);

    const { SmtpProvider } = await import('../src/providers/email/smtp.js');
    const provider = new SmtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'user@example.com', pass: 'secret' },
      from: 'from@example.com',
      timeoutMs: 50,
    });

    await expect(provider.send({ to: 'to@example.com', subject: 'Hi', body: 'Hello' })).rejects.toThrow(
      /SMTP connect timeout to smtp.example.com:587 after 50ms/,
    );
  });
});
