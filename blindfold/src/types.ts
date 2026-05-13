export interface Logger {
  info(tag: string, msg: string): void;
  warn(tag: string, msg: string): void;
  error(tag: string, msg: string): void;
}

export interface BlindfolConfig {
  dataDir: string;
  productName: string;
  logger: Logger;
  oobTimeoutMs?: number;
  pipeName?: string;
}

export interface CredentialMeta {
  name: string;
  scope: 'session' | 'persistent';
  network_policy: 'allow' | 'confirm' | 'deny';
  created_at: string;
  allowedMembers: string[] | '*';
  expiresAt?: string;
}

export interface CredentialUpdatePatch {
  members?: string;
  expiresAt?: number | null;
  network_policy?: 'allow' | 'confirm' | 'deny';
}

export interface CredentialUpdateResult {
  members: string;
  network_policy: 'allow' | 'confirm' | 'deny';
  expiresAt?: number;
}

export interface ResolvedCredential {
  name: string;
  plaintext: string;
  network_policy: 'allow' | 'confirm' | 'deny';
}

export interface ResolveOptions {
  caller?: string;
  os?: 'linux' | 'macos' | 'windows';
  shellEscape?: boolean;
}

export interface SecureInputOptions {
  prompt: string;
  allowEmpty?: boolean;
}

export type CredentialStatus =
  | { status: 'valid' }
  | { status: 'near-expiry'; minutesLeft: number }
  | { status: 'expired-refreshable' }
  | { status: 'expired-no-refresh' };
