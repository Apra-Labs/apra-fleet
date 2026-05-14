// Configuration
export { initBlindfold, getConfig, getDataDir, getLogger, resetConfig } from './config.js';
export type { BlindfoldConfig, Logger, SecureInputOptions, CredentialMeta, CredentialUpdatePatch, CredentialUpdateResult, ResolvedCredential, ResolveOptions, CredentialStatus } from './types.js';

// Encryption
export { encryptPassword, decryptPassword } from './crypto.js';

// Credential Store
export {
  credentialSet,
  credentialList,
  credentialDelete,
  credentialResolve,
  credentialUpdate,
  purgeExpiredCredentials,
  registerTaskCredentials,
  getTaskCredentials,
  clearTaskCredentials,
  _clearSessionStore,
} from './credential-store.js';

// Token Resolution
export {
  resolveSecureTokens,
  resolveSecureField,
  redactOutput,
  containsSecureTokens,
  SECURE_TOKEN_RE,
  SEC_HANDLE_RE,
} from './token-resolver.js';

// Shell Security
export {
  escapeShellArg,
  escapeDoubleQuoted,
  escapeWindowsArg,
  escapePowerShellArg,
  escapeBatchMetachars,
  escapeGrepPattern,
  sanitizeSessionId,
} from './shell-escape.js';

// File Security
export { enforceOwnerOnly } from './file-permissions.js';

// Credential Validation
export { validateCredentials, credentialStatusNote } from './credential-validation.js';

// Secure Input
export { secureInput } from './secure-input.js';
export { collectSecret } from './collect-secret.js';

// OOB Timeout
export { getOobTimeoutMs } from './oob-timeout.js';

// Auth Socket (OOB side-channel)
export {
  getSocketPath,
  ensureAuthSocket,
  cleanupAuthSocket,
  createPendingAuth,
  getPendingPassword,
  waitForPassword,
  cancelPendingAuth,
  hasPendingAuth,
  collectOobPassword,
  collectOobApiKey,
  collectOobConfirm,
  hasGraphicalDisplay,
  isSSHSession,
  hasInteractiveDesktop,
  launchAuthTerminal,
} from './auth-socket.js';
