export interface EmailAttachment {
  filename: string;
  /** Base64-encoded content */
  content: string;
  contentType?: string;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  body: string;        // plain text
  html?: string;        // optional HTML body
  cc?: string[];
  bcc?: string[];
  from?: string;         // override default sender
  attachments?: EmailAttachment[];
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailTransport {
  name: string;
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

export interface SendgridConfig {
  apiKey: string;
  from: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth: { user: string; pass: string };
  from: string;
}

export interface EmailConfig {
  transport: 'sendgrid' | 'smtp';
  sendgrid?: SendgridConfig;
  smtp?: SmtpConfig;
}
