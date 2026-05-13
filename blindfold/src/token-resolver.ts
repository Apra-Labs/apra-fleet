import { credentialResolve } from './credential-store.js';
import { escapeShellArg, escapePowerShellArg } from './shell-escape.js';
import type { ResolvedCredential, ResolveOptions } from './types.js';

export const SECURE_TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_-]{1,64})\}\}/g;
const SEC_HANDLE_RE = /sec:\/\/[a-zA-Z0-9_]+/;

export function containsSecureTokens(text: string): boolean {
  SECURE_TOKEN_RE.lastIndex = 0;
  return SECURE_TOKEN_RE.test(text);
}

export function resolveSecureField(
  value: string,
  caller?: string,
): { resolved: string } | { error: string } {
  const tokenNames = new Set<string>();
  let match: RegExpExecArray | null;
  SECURE_TOKEN_RE.lastIndex = 0;
  while ((match = SECURE_TOKEN_RE.exec(value)) !== null) {
    tokenNames.add(match[1]);
  }

  if (tokenNames.size === 0) return { resolved: value };

  let resolved = value;
  for (const name of tokenNames) {
    const entry = credentialResolve(name, caller);
    if (!entry) return { error: `Credential "${name}" not found. Run credential_store_set first.` };
    if ('denied' in entry) return { error: entry.denied };
    if ('expired' in entry) return { error: entry.expired };
    resolved = resolved.replaceAll(`{{secure.${name}}}`, entry.plaintext);
  }
  return { resolved };
}

export function resolveSecureTokens(
  text: string,
  opts?: ResolveOptions,
): { resolved: string; credentials: ResolvedCredential[] } | { error: string } {
  if (SEC_HANDLE_RE.test(text)) {
    return { error: 'Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.' };
  }

  const tokenNames = new Set<string>();
  let match: RegExpExecArray | null;
  SECURE_TOKEN_RE.lastIndex = 0;
  while ((match = SECURE_TOKEN_RE.exec(text)) !== null) {
    tokenNames.add(match[1]);
  }

  if (tokenNames.size === 0) return { resolved: text, credentials: [] };

  const credentials: ResolvedCredential[] = [];
  const caller = opts?.caller;

  for (const name of tokenNames) {
    const entry = credentialResolve(name, caller);
    if (!entry) return { error: `Credential "${name}" not found. Run credential_store_set first.` };
    if ('denied' in entry) return { error: entry.denied };
    if ('expired' in entry) return { error: entry.expired };
    credentials.push({ name, plaintext: entry.plaintext, network_policy: entry.meta.network_policy });
  }

  const shellEscape = opts?.shellEscape !== false;
  const agentOs = opts?.os ?? 'linux';
  let resolved = text;

  for (const cred of credentials) {
    const value = shellEscape
      ? (agentOs === 'windows' ? escapePowerShellArg(cred.plaintext) : escapeShellArg(cred.plaintext))
      : cred.plaintext;
    resolved = resolved.replaceAll(`{{secure.${cred.name}}}`, value);
  }

  return { resolved, credentials };
}

export function redactOutput(
  output: string,
  credentials: Array<{ name: string; plaintext: string }>,
): string {
  let redacted = output;
  for (const cred of credentials) {
    if (cred.plaintext.length > 0) {
      redacted = redacted.replaceAll(cred.plaintext, `[REDACTED:${cred.name}]`);
    }
  }
  return redacted;
}
