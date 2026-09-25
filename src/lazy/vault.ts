/**
 * The vault is the existing encrypted credential store (persistent tier), so
 * anything caught here is also usable as {{secure.NAME}} by remote helpers.
 * This module adds a value cache for the proxy and a small metadata sidecar
 * (kind, where it was caught, hit counts) that the store has no room for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import { credentialDelete, credentialList, credentialResolve, credentialSet } from '../services/credential-store.js';
import { lazyDir } from './config.js';
import { MIN_SECRET_LENGTH } from './detect.js';

export type Origin = 'chat' | 'tool-output' | 'manual';

export interface SecretMeta {
  kind: string;
  origin: Origin;
  firstSeen: string;
  lastSeen: string;
  hits: number;
}

export interface KnownSecret {
  name: string;
  value: string;
}

export interface VaultLike {
  /** All known secrets, longest value first (so substrings never win). */
  entries(): KnownSecret[];
  valueOf(name: string): string | undefined;
  /** Store `value` if new; returns its name either way. */
  remember(kind: string, value: string, origin: Origin): string;
  /** Record that a known secret was hidden again. */
  touch(name: string): void;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function credentialsFile(): string {
  return path.join(process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR, 'credentials.json');
}

function metaFile(): string {
  return path.join(lazyDir(), 'vault-meta.json');
}

function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export class Vault implements VaultLike {
  private cache: KnownSecret[] | null = null;
  private cacheStamp = -1;
  private meta: Record<string, SecretMeta> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  entries(): KnownSecret[] {
    const stamp = mtime(credentialsFile());
    if (this.cache && stamp === this.cacheStamp) return this.cache;
    const out: KnownSecret[] = [];
    for (const meta of credentialList()) {
      if (meta.scope !== 'persistent') continue;
      const r = credentialResolve(meta.name, '*');
      if (r && 'plaintext' in r && r.plaintext.length >= MIN_SECRET_LENGTH) {
        out.push({ name: meta.name, value: r.plaintext });
      }
    }
    out.sort((a, b) => b.value.length - a.value.length);
    this.cache = out;
    this.cacheStamp = mtime(credentialsFile());
    return out;
  }

  valueOf(name: string): string | undefined {
    return this.entries().find(e => e.name === name)?.value;
  }

  remember(kind: string, value: string, origin: Origin): string {
    const existing = this.entries().find(e => e.value === value);
    if (existing) {
      this.touch(existing.name);
      return existing.name;
    }
    const name = this.freshName(kind);
    credentialSet(name, value, true, 'allow');
    const now = new Date().toISOString();
    this.metaMap()[name] = { kind, origin, firstSeen: now, lastSeen: now, hits: 1 };
    this.scheduleFlush();
    this.cache = null;
    return name;
  }

  /** Add a secret by hand (from the UI). */
  add(name: string, value: string): string {
    if (!NAME_RE.test(name)) throw new Error('Name must be 1-64 letters, digits, - or _');
    if (value.length < MIN_SECRET_LENGTH) throw new Error(`Value must be at least ${MIN_SECRET_LENGTH} characters`);
    credentialSet(name, value, true, 'allow');
    const now = new Date().toISOString();
    this.metaMap()[name] = { kind: 'manual', origin: 'manual', firstSeen: now, lastSeen: now, hits: 0 };
    this.flushNow();
    this.cache = null;
    return name;
  }

  delete(name: string): boolean {
    const ok = credentialDelete(name);
    delete this.metaMap()[name];
    this.flushNow();
    this.cache = null;
    return ok;
  }

  touch(name: string): void {
    const m = this.metaMap()[name];
    if (!m) return;
    m.hits++;
    m.lastSeen = new Date().toISOString();
    this.scheduleFlush();
  }

  list(): Array<{ name: string; length: number; preview: string } & Partial<SecretMeta>> {
    const meta = this.metaMap();
    return this.entries()
      .map(e => ({ name: e.name, length: e.value.length, preview: mask(e.value), ...meta[e.name] }))
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || a.name.localeCompare(b.name));
  }

  private freshName(kind: string): string {
    const base = kind.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56) || 'secret';
    const taken = new Set(credentialList().map(c => c.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}_${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private metaMap(): Record<string, SecretMeta> {
    if (!this.meta) {
      try {
        this.meta = JSON.parse(fs.readFileSync(metaFile(), 'utf-8'));
      } catch {
        this.meta = {};
      }
    }
    return this.meta!;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushNow(), 2000);
    this.flushTimer.unref();
  }

  flushNow(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.meta) return;
    fs.mkdirSync(lazyDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(metaFile(), JSON.stringify(this.meta, null, 2), { mode: 0o600 });
  }
}

/** Short values are fully masked; longer ones show two characters at each end. */
export function mask(value: string): string {
  if (value.length < 12) return '*'.repeat(8);
  return `${value.slice(0, 2)}${'*'.repeat(8)}${value.slice(-2)}`;
}
