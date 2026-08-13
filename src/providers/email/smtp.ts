import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { EmailMessage, EmailSendResult, EmailProvider, SmtpConfig } from './provider.js';

interface SmtpResponse {
  code: number;
  lines: string[];
}

/** Default ceiling for connect and per-response waits (overridable via SmtpConfig.timeoutMs). */
const SMTP_TIMEOUT_MS = 30_000;

interface Waiter {
  resolve: (res: SmtpResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Header/command injection guard: any value spliced into an SMTP command or
 * MIME header line must not contain CR/LF, or a crafted "from"/"subject" can
 * inject extra recipients or headers into the protocol stream.
 */
function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}: must not contain CR/LF characters.`);
  }
}

/**
 * Minimal SMTP client (no `nodemailer` dependency required).
 * Supports plain sockets, implicit TLS (port 465) and STARTTLS (e.g. port 587),
 * with AUTH LOGIN and a basic MIME multipart message (text + optional html +
 * attachments).
 */
/** Exported for unit tests (response parsing/coalescing); not part of the public API. */
export class SmtpConnection {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer = '';
  private waiters: Waiter[] = [];
  /** Complete responses that arrived before anyone was waiting for them. */
  private pending: SmtpResponse[] = [];
  /** Set on socket error/unexpected close; fails all current and future waits. */
  private failed: Error | null = null;

  constructor(socket: net.Socket | tls.TLSSocket, private readonly timeoutMs: number = SMTP_TIMEOUT_MS) {
    this.attach(socket);
  }

  /** Attach data + error/close handlers. A persistent 'error' listener is
   *  required: connectSocket's once('error') promise is already settled by
   *  the time the session is live, so without this a mid-session ECONNRESET
   *  would be an unhandled 'error' event and crash the process. */
  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err: Error) => this.failAll(err));
    socket.on('close', () => this.failAll(new Error('SMTP connection closed unexpectedly.')));
  }

  /** Reject every outstanding (and future) waiter with the given error. */
  private failAll(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    // SMTP multi-line responses: lines end with \r\n, the final line has a
    // space (or nothing) after the code (e.g. "250 OK"), continuation lines
    // use a dash ("250-..."). A single 'data' event can carry MORE than one
    // complete response if the TCP stack coalesces them, so extract and
    // deliver every complete response in order rather than assuming at most
    // one per event.
    for (;;) {
      const lines = this.buffer.split(/\r\n/);
      const partial = lines.pop() ?? '';
      let end = -1;
      let code = 0;
      for (let i = 0; i < lines.length; i++) {
        const match = /^(\d{3})([ -])?/.exec(lines[i]);
        if (match && match[2] !== '-') {
          end = i;
          code = parseInt(match[1], 10);
          break;
        }
      }
      if (end === -1) return; // no complete response buffered yet
      const response: SmtpResponse = { code, lines: lines.slice(0, end + 1) };
      this.buffer = [...lines.slice(end + 1), partial].join('\r\n');
      this.deliver(response);
    }
  }

  private deliver(response: SmtpResponse): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    } else {
      this.pending.push(response);
    }
  }

  waitForResponse(): Promise<SmtpResponse> {
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          this.socket.destroy();
          reject(new Error(`SMTP response timeout after ${this.timeoutMs}ms.`));
        }, this.timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async command(cmd: string): Promise<SmtpResponse> {
    const pending = this.waitForResponse();
    this.socket.write(cmd + '\r\n');
    return pending;
  }

  swapSocket(socket: tls.TLSSocket): void {
    const old = this.socket;
    old.removeAllListeners('data');
    old.removeAllListeners('error');
    old.removeAllListeners('close');
    // Keep a no-op error listener on the wrapped socket so a raw error on it
    // can never become an unhandled 'error' event.
    old.on('error', () => undefined);
    this.attach(socket);
  }

  write(data: string): void {
    this.socket.write(data);
  }

  /** Tear down the socket unconditionally (idempotent). Marks the
   *  connection as deliberately closed BEFORE destroying, so the resulting
   *  'close' event doesn't manufacture an "unexpected close" error. */
  destroy(): void {
    if (!this.failed) this.failed = new Error('SMTP connection already closed.');
    this.socket.destroy();
  }
}

function connectSocket(host: string, port: number, secure: boolean, timeoutMs: number): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SMTP connect timeout to ${host}:${port} after ${timeoutMs}ms.`));
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    const socket = secure
      ? tls.connect({ host, port }, onConnect)
      : net.connect({ host, port }, onConnect);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function starttls(socket: net.Socket, host: string, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      secureSocket.destroy();
      reject(new Error(`STARTTLS handshake timeout after ${timeoutMs}ms.`));
    }, timeoutMs);
    const secureSocket = tls.connect({ socket, host }, () => {
      clearTimeout(timer);
      resolve(secureSocket);
    });
    secureSocket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * RFC 5322 date: "Tue, 12 Aug 2026 03:37:17 +0000". toUTCString() is the
 * same shape but ends in "GMT" (an obsolete zone form) -- swap it.
 */
function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

/**
 * RFC 2047 encoded-word for header values with non-ASCII characters.
 * Split into <=45-byte chunks (60 base64 chars, under the 75-char
 * encoded-word limit) folded with CRLF+SP.
 */
function encodeHeaderValue(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;
  const bytes = Buffer.from(value, 'utf8');
  const words: string[] = [];
  for (let i = 0; i < bytes.length; i += 45) {
    words.push(`=?utf-8?B?${bytes.subarray(i, i + 45).toString('base64')}?=`);
  }
  return words.join('\r\n ');
}

/** Wrap base64 content at 76 chars per line (RFC 2045). */
function wrapBase64(content: string): string {
  const compact = content.replace(/\s+/g, '');
  return compact.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

function buildMimeMessage(msg: EmailMessage, from: string): string {
  const boundary = `----apra-fleet-${crypto.randomBytes(12).toString('hex')}`;
  const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
  assertHeaderSafe('from', from);
  assertHeaderSafe('to', to);
  assertHeaderSafe('subject', msg.subject);
  const fromDomain = from.split('@')[1] ?? 'localhost';
  const headers: string[] = [
    `Date: ${rfc5322Date(new Date())}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${fromDomain}>`,
    `From: ${from}`,
    `To: ${to}`,
  ];
  if (msg.cc && msg.cc.length > 0) {
    const cc = msg.cc.join(', ');
    assertHeaderSafe('cc', cc);
    headers.push(`Cc: ${cc}`);
  }
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  headers.push('MIME-Version: 1.0');

  const hasAttachments = !!msg.attachments && msg.attachments.length > 0;
  const hasHtml = !!msg.html;

  if (!hasAttachments && !hasHtml) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    return `${headers.join('\r\n')}\r\n\r\n${msg.body}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [];
  if (hasHtml) {
    const altBoundary = `${boundary}-alt`;
    parts.push(
      `--${boundary}\r\nContent-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n` +
      `--${altBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${msg.body}\r\n` +
      `--${altBoundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${msg.html}\r\n` +
      `--${altBoundary}--`
    );
  } else {
    parts.push(`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${msg.body}`);
  }

  for (const att of msg.attachments ?? []) {
    assertHeaderSafe('attachment filename', att.filename);
    if (att.contentType) assertHeaderSafe('attachment contentType', att.contentType);
    parts.push(
      `--${boundary}\r\nContent-Type: ${att.contentType ?? 'application/octet-stream'}; name="${att.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${att.filename}"\r\n\r\n${wrapBase64(att.content)}`
    );
  }
  parts.push(`--${boundary}--`);

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/**
 * Normalize every line ending (bare LF, bare CR, or CRLF) to CRLF. SMTP
 * requires CRLF line endings in DATA; strict servers (e.g. Gmail) reject
 * bare linefeeds, and un-normalized input would let a body line like
 * "\n.\n" slip past dot-stuffing (which splits on CRLF only) and
 * prematurely terminate DATA -- the SMTP-smuggling class of bug.
 */
function normalizeCrlf(message: string): string {
  return message.split(/\r\n|\r|\n/).join('\r\n');
}

function dotStuff(message: string): string {
  return message.split('\r\n').map(line => (line.startsWith('.') ? '.' + line : line)).join('\r\n');
}

export class SmtpProvider implements EmailProvider {
  public readonly name = 'smtp';

  constructor(private readonly config: SmtpConfig) {}

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const { host, port, secure, auth, from } = this.config;
    const timeoutMs = this.config.timeoutMs ?? SMTP_TIMEOUT_MS;

    // Reject CR/LF in command-bound values up front, before any network I/O.
    const sender = msg.from ?? from;
    assertHeaderSafe('from', sender);
    const recipients = [
      ...(Array.isArray(msg.to) ? msg.to : [msg.to]),
      ...(msg.cc ?? []),
      ...(msg.bcc ?? []),
    ];
    for (const rcpt of recipients) assertHeaderSafe('recipient', rcpt);
    assertHeaderSafe('subject', msg.subject);

    const socket = await connectSocket(host, port, !!secure, timeoutMs);
    const conn = new SmtpConnection(socket, timeoutMs);

    // try/finally: every protocol step below can throw (bad greeting, AUTH
    // failure, rejected recipient, timeout) -- without the finally the open
    // TCP socket would leak on each failed send.
    try {
      const greeting = await conn.waitForResponse();
      if (greeting.code !== 220) throw new Error(`SMTP server did not greet: ${greeting.lines.join(' ')}`);

      let ehlo = await conn.command(`EHLO localhost`);
      if (ehlo.code !== 250) throw new Error(`SMTP EHLO failed: ${ehlo.lines.join(' ')}`);

      if (!secure && ehlo.lines.some(l => /STARTTLS/i.test(l))) {
        const startTlsResp = await conn.command('STARTTLS');
        if (startTlsResp.code !== 220) throw new Error(`STARTTLS failed: ${startTlsResp.lines.join(' ')}`);
        const tlsSocket = await starttls(socket as net.Socket, host, timeoutMs);
        conn.swapSocket(tlsSocket);
        ehlo = await conn.command(`EHLO localhost`);
        if (ehlo.code !== 250) throw new Error(`SMTP EHLO (after STARTTLS) failed: ${ehlo.lines.join(' ')}`);
      }

      if (auth?.user) {
        const authStart = await conn.command('AUTH LOGIN');
        if (authStart.code !== 334) throw new Error(`SMTP AUTH LOGIN failed: ${authStart.lines.join(' ')}`);
        const userResp = await conn.command(Buffer.from(auth.user, 'utf8').toString('base64'));
        if (userResp.code !== 334) throw new Error(`SMTP AUTH username rejected: ${userResp.lines.join(' ')}`);
        const passResp = await conn.command(Buffer.from(auth.pass, 'utf8').toString('base64'));
        if (passResp.code !== 235) throw new Error(`SMTP AUTH failed: ${passResp.lines.join(' ')}`);
      }

      const fromResp = await conn.command(`MAIL FROM:<${sender}>`);
      if (fromResp.code !== 250) throw new Error(`MAIL FROM rejected: ${fromResp.lines.join(' ')}`);

      for (const rcpt of recipients) {
        const rcptResp = await conn.command(`RCPT TO:<${rcpt}>`);
        if (rcptResp.code !== 250 && rcptResp.code !== 251) {
          throw new Error(`RCPT TO <${rcpt}> rejected: ${rcptResp.lines.join(' ')}`);
        }
      }

      const dataResp = await conn.command('DATA');
      if (dataResp.code !== 354) throw new Error(`DATA command rejected: ${dataResp.lines.join(' ')}`);

      const mimeMessage = normalizeCrlf(buildMimeMessage(msg, sender));
      const finishPending = conn.waitForResponse();
      conn.write(dotStuff(mimeMessage) + '\r\n.\r\n');
      const finishResp = await finishPending;
      if (finishResp.code !== 250) throw new Error(`Message not accepted: ${finishResp.lines.join(' ')}`);

      const messageId = /queued as ([^\s]+)/i.exec(finishResp.lines.join(' '))?.[1] ?? `smtp-${Date.now()}`;

      await conn.command('QUIT').catch(() => undefined);
      return { messageId };
    } finally {
      conn.destroy();
    }
  }
}
