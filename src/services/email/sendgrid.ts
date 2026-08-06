import type { EmailMessage, EmailSendResult, EmailTransport, SendgridConfig } from './types.js';

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';

function toAddressList(to: string | string[]): { email: string }[] {
  const list = Array.isArray(to) ? to : [to];
  return list.map(email => ({ email }));
}

/**
 * SendGrid adapter implemented against the SendGrid HTTP v3 API directly
 * (no `@sendgrid/mail` dependency required -- uses the platform `fetch`).
 */
export class SendgridTransport implements EmailTransport {
  public readonly name = 'sendgrid';

  constructor(private readonly config: SendgridConfig) {}

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const content: { type: string; value: string }[] = [{ type: 'text/plain', value: msg.body }];
    if (msg.html) content.push({ type: 'text/html', value: msg.html });

    const personalization: Record<string, unknown> = { to: toAddressList(msg.to) };
    if (msg.cc && msg.cc.length > 0) personalization.cc = toAddressList(msg.cc);
    if (msg.bcc && msg.bcc.length > 0) personalization.bcc = toAddressList(msg.bcc);

    const body: Record<string, unknown> = {
      personalizations: [personalization],
      from: { email: msg.from ?? this.config.from },
      subject: msg.subject,
      content,
    };

    if (msg.attachments && msg.attachments.length > 0) {
      body.attachments = msg.attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        type: a.contentType,
      }));
    }

    const response = await fetch(SENDGRID_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`SendGrid send failed (${response.status}): ${errText}`);
    }

    const messageId = response.headers.get('x-message-id') ?? `sendgrid-${Date.now()}`;
    return { messageId };
  }
}
