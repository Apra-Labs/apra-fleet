import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { EmailMessage, EmailSendResult, EmailProvider, SmtpConfig } from './provider.js';

interface SmtpResponse {
  code: number;
  lines: string[];
}

/**
 * Minimal SMTP client (no `nodemailer` dependency required).
 * Supports plain sockets, implicit TLS (port 465) and STARTTLS (e.g. port 587),
 * with AUTH LOGIN and a basic MIME multipart message (text + optional html +
 * attachments).
 */
class SmtpConnection {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = '';
  private waiters: ((res: SmtpResponse) => void)[] = [];

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.socket.on('data', (chunk) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    // SMTP multi-line responses: lines end with \r\n, last line has a space
    // after the code (e.g. "250 OK"), continuation lines use a dash ("250-...").
    const lines = this.buffer.split(/\r\n/);
    // Keep last partial line in buffer.
    this.buffer = lines.pop() ?? '';

    if (lines.length === 0) return;
    const last = lines[lines.length - 1];
    const match = /^(\d{3})([ -])/.exec(last);
    if (!match) return;
    if (match[2] === '-') {
      // Not done yet; put lines back and wait for more data.
      this.buffer = lines.join('\r\n') + '\r\n' + this.buffer;
      return;
    }

    const code = parseInt(match[1], 10);
    const resolve = this.waiters.shift();
    if (resolve) resolve({ code, lines });
  }

  waitForResponse(): Promise<SmtpResponse> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async command(cmd: string): Promise<SmtpResponse> {
    const pending = this.waitForResponse();
    this.socket.write(cmd + '\r\n');
    return pending;
  }

  swapSocket(socket: tls.TLSSocket): void {
    this.socket.removeAllListeners('data');
    this.socket = socket;
    this.socket.on('data', (chunk) => this.onData(chunk));
  }

  write(data: string): void {
    this.socket.write(data);
  }

  end(): void {
    this.socket.end();
  }
}

function connectSocket(host: string, port: number, secure: boolean): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function starttls(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, host }, () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

function buildMimeMessage(msg: EmailMessage, from: string): string {
  const boundary = `----apra-fleet-${crypto.randomBytes(12).toString('hex')}`;
  const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
  const headers: string[] = [
    `From: ${from}`,
    `To: ${to}`,
  ];
  if (msg.cc && msg.cc.length > 0) headers.push(`Cc: ${msg.cc.join(', ')}`);
  headers.push(`Subject: ${msg.subject}`);
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
    parts.push(
      `--${boundary}\r\nContent-Type: ${att.contentType ?? 'application/octet-stream'}; name="${att.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${att.filename}"\r\n\r\n${att.content}`
    );
  }
  parts.push(`--${boundary}--`);

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

function dotStuff(message: string): string {
  return message.split('\r\n').map(line => (line.startsWith('.') ? '.' + line : line)).join('\r\n');
}

export class SmtpProvider implements EmailProvider {
  public readonly name = 'smtp';

  constructor(private readonly config: SmtpConfig) {}

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const { host, port, secure, auth, from } = this.config;
    const socket = await connectSocket(host, port, !!secure);
    let conn = new SmtpConnection(socket);

    const greeting = await conn.waitForResponse();
    if (greeting.code !== 220) throw new Error(`SMTP server did not greet: ${greeting.lines.join(' ')}`);

    let ehlo = await conn.command(`EHLO localhost`);
    if (ehlo.code !== 250) throw new Error(`SMTP EHLO failed: ${ehlo.lines.join(' ')}`);

    if (!secure && ehlo.lines.some(l => /STARTTLS/i.test(l))) {
      const startTlsResp = await conn.command('STARTTLS');
      if (startTlsResp.code !== 220) throw new Error(`STARTTLS failed: ${startTlsResp.lines.join(' ')}`);
      const tlsSocket = await starttls(socket as net.Socket, host);
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

    const fromResp = await conn.command(`MAIL FROM:<${msg.from ?? from}>`);
    if (fromResp.code !== 250) throw new Error(`MAIL FROM rejected: ${fromResp.lines.join(' ')}`);

    const recipients = [
      ...(Array.isArray(msg.to) ? msg.to : [msg.to]),
      ...(msg.cc ?? []),
      ...(msg.bcc ?? []),
    ];
    for (const rcpt of recipients) {
      const rcptResp = await conn.command(`RCPT TO:<${rcpt}>`);
      if (rcptResp.code !== 250 && rcptResp.code !== 251) {
        throw new Error(`RCPT TO <${rcpt}> rejected: ${rcptResp.lines.join(' ')}`);
      }
    }

    const dataResp = await conn.command('DATA');
    if (dataResp.code !== 354) throw new Error(`DATA command rejected: ${dataResp.lines.join(' ')}`);

    const mimeMessage = buildMimeMessage(msg, msg.from ?? from);
    const finishPending = conn.waitForResponse();
    conn.write(dotStuff(mimeMessage) + '\r\n.\r\n');
    const finishResp = await finishPending;
    if (finishResp.code !== 250) throw new Error(`Message not accepted: ${finishResp.lines.join(' ')}`);

    const messageId = /queued as ([^\s]+)/i.exec(finishResp.lines.join(' '))?.[1] ?? `smtp-${Date.now()}`;

    await conn.command('QUIT').catch(() => undefined);
    conn.end();

    return { messageId };
  }
}
