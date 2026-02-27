import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { enforceOwnerOnly } from '../utils/file-permissions.js';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
const KNOWN_HOSTS_PATH = path.join(FLEET_DIR, 'known_hosts');

export class HostKeyMismatchError extends Error {
  constructor(
    public readonly host: string,
    public readonly port: number,
    public readonly oldFingerprint: string,
    public readonly newFingerprint: string,
  ) {
    super(
      `SSH HOST KEY MISMATCH for ${host}:${port}! ` +
      `Expected ${oldFingerprint}, got ${newFingerprint}. ` +
      `This could indicate a server reinstall or a man-in-the-middle attack. ` +
      `Delete the entry from ~/.claude-fleet/known_hosts to accept the new key.`
    );
    this.name = 'HostKeyMismatchError';
  }
}

type KnownHostsStore = Record<string, string>;

function hostKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function fingerprint(key: Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(key).digest('base64');
}

function loadKnownHosts(): KnownHostsStore {
  try {
    if (fs.existsSync(KNOWN_HOSTS_PATH)) {
      return JSON.parse(fs.readFileSync(KNOWN_HOSTS_PATH, 'utf-8'));
    }
  } catch {
    // Corrupted file — start fresh
  }
  return {};
}

function saveKnownHosts(store: KnownHostsStore): void {
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(KNOWN_HOSTS_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  enforceOwnerOnly(KNOWN_HOSTS_PATH);
}

/**
 * Verify a host key using Trust-On-First-Use (TOFU).
 * - First connection: stores the fingerprint and returns true
 * - Matching fingerprint: returns true
 * - Mismatched fingerprint: throws HostKeyMismatchError
 */
export function verifyHostKey(host: string, port: number, key: Buffer): boolean {
  const store = loadKnownHosts();
  const hk = hostKey(host, port);
  const fp = fingerprint(key);

  const stored = store[hk];
  if (!stored) {
    // TOFU: first connection — trust and save
    store[hk] = fp;
    saveKnownHosts(store);
    return true;
  }

  if (stored === fp) {
    return true;
  }

  throw new HostKeyMismatchError(host, port, stored, fp);
}

/**
 * Replace a known host fingerprint (used after user accepts a new key).
 */
export function replaceKnownHost(host: string, port: number, newFp: string): void {
  const store = loadKnownHosts();
  store[hostKey(host, port)] = newFp;
  saveKnownHosts(store);
}

/**
 * Remove a known host entry.
 */
export function removeKnownHost(host: string, port: number): void {
  const store = loadKnownHosts();
  delete store[hostKey(host, port)];
  saveKnownHosts(store);
}
