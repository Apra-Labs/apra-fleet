// =============================================================================
// Fleet-server-hosted sprint coordination: global dolt push mutex + global
// child-id allocator (apra-fleet-f34.2)
// =============================================================================
//
// WHY THIS EXISTS (and why it is a TypeScript re-statement, not an import):
//
// The original implementations live in the apra-fleet-se supervisor as
//   packages/apra-fleet-se/src/supervisor/dolt-mutex.mjs
//   packages/apra-fleet-se/src/supervisor/id-allocator.mjs
// and are reachable by detached sprint children over the supervisor's own HTTP
// routes (`--service-url`). That covers supervisor-launched sprints ONLY. The
// standalone/detached-binary CLI launch path (packages/apra-fleet-se/bin/cli.mjs)
// has NO supervisor to reach, so `--service-url` alone leaves that topology
// completely unprotected -- yet cli.mjs hard-requires a connection to the SHARED
// fleet MCP HTTP singleton (it refuses to self-spawn a private stdio server), so
// the fleet server IS a genuine cross-process coordination point for exactly
// that topology. This module hosts the same coordination state there.
//
// It is NOT shared code with the two .mjs originals, and that is a deliberate,
// forced trade-off rather than an oversight:
//   * the fleet server is TypeScript under `rootDir: ./src` with `allowJs`
//     off, so a `.mjs` file outside `src/` can neither be type-checked nor
//     emitted into `dist/`;
//   * the root package does NOT depend on `@apralabs/apra-fleet-se` (the
//     dependency runs the other way through `@apralabs/apra-fleet-client`), so
//     importing the supervisor modules from here would introduce a workspace
//     cycle that `npm run build:binary` would have to carry.
// Extracting a third shared workspace package is the architecturally-right end
// state, but it puts a new workspace dependency into the SEA build path and is
// tracked separately rather than done inside this bead.
//
// SEMANTICS PRESERVED verbatim from the two originals (any change here must be
// mirrored there, and vice versa):
//   * dolt mutex: at most one holder; strict FIFO grant order for waiters;
//     lease + dead-pid reclaim of a crashed holder; token-guarded, idempotent
//     release/renew.
//   * id allocator: per-parent monotonic sequences assigned SYNCHRONOUSLY (no
//     await before the mutation) so concurrent same-parent allocations can
//     never collide; different parents never block each other; every mutation
//     persisted atomically (temp file + rename) and allocate() does not resolve
//     until its id is durably on disk; abandoned reservations (lease expiry or
//     dead pid) return their seq to a per-parent free pool for reuse.
//
// TRANSPORT ADAPTATION (the one genuinely new piece): the supervisor's HTTP
// acquire route LONG-POLLS -- it simply does not answer until the caller owns
// the mutex. An MCP tool call cannot block indefinitely, so acquire here is
// TICKETED: the real `mutex.acquire()` promise is enqueued once and parked
// server-side under a ticket id; the caller gets `{ granted: false, ticket }`
// after a bounded wait and re-polls with that ticket. The waiter therefore
// STAYS ENQUEUED across polls, which is what keeps FIFO intact -- a
// cancel-and-retry loop would silently send every timed-out waiter to the back
// of the queue and destroy the fairness guarantee.
// =============================================================================

import path from 'node:path';
import fsp from 'node:fs/promises';

import { FLEET_DIR } from '../paths.js';
import { isPidAlive } from '../utils/pid-helpers.js';

/** Default lease duration for a mutex grant / an id reservation. */
export const DEFAULT_LEASE_MS = 60_000;

/** Default background sweep interval for reclaiming expired/dead holders. */
export const DEFAULT_SWEEP_MS = 5_000;

/** Default bounded wait a single `acquire`/`poll` tool call blocks for. */
export const DEFAULT_WAIT_MS = 5_000;

/** Hard ceiling on a single call's bounded wait, so no MCP call hangs. */
export const MAX_WAIT_MS = 60_000;

/** On-disk schema version for the persisted allocator document. */
export const ID_ALLOCATOR_VERSION = 1;

/**
 * Where the fleet-server-hosted allocator persists its state. Deliberately
 * DISTINCT from the supervisor's own `~/.apra-fleet/supervisor/
 * child-id-allocator.json`: if a supervisor and a fleet server were both live,
 * two processes writing one file would corrupt it.
 */
export const ID_ALLOCATOR_FILENAME = 'child-id-allocator.json';

export function defaultIdAllocatorPath(): string {
  return path.join(FLEET_DIR, 'sprint-coordination', ID_ALLOCATOR_FILENAME);
}

let tokenSeq = 0;
function nextToken(scope: string): string {
  tokenSeq += 1;
  return `${scope}#${tokenSeq}#${Date.now().toString(36)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as any).unref === 'function') (t as any).unref();
  });
}

export interface MutexGrant {
  token: string;
  sprintId: string;
  expiresAt: number;
}

export interface MutexDeps {
  leaseMs?: number;
  sweepMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  logger?: { log?: (...a: any[]) => void };
}

interface Holder {
  sprintId: string;
  token: string;
  pid: number | null;
  acquiredAt: number;
  expiresAt: number;
}

interface Waiter {
  sprintId: string;
  pid: number | null;
  resolve: (g: MutexGrant) => void;
  reject: (e: Error) => void;
  enqueuedAt: number;
}

export interface DoltMutex {
  acquire(sprintId: string, opts?: { pid?: number | null }): Promise<MutexGrant>;
  release(token: string): boolean;
  renew(token: string): false | { expiresAt: number };
  reclaimExpired(): boolean;
  cancelWaiter(sprintId: string, reason?: Error): number;
  status(): {
    held: boolean;
    holder: { sprintId: string; pid: number | null; acquiredAt: number; expiresAt: number } | null;
    waiting: Array<{ sprintId: string; pid: number | null; enqueuedAt: number }>;
    queueDepth: number;
  };
  start(): void;
  stop(): void;
  /**
   * Subscribe to holder reclaim events (lease expiry or dead-pid probe, see
   * `reclaimExpired()`). Fired with the reclaimed holder's token BEFORE the
   * next waiter is granted. Used by `createTicketedMutex` to drop the ticket
   * map entry for a grant that was reclaimed out from under it instead of
   * released through the normal `release(token)` path -- otherwise that
   * entry (and its `byToken` mapping) would never be cleaned up and would
   * accumulate for the lifetime of the always-on fleet server. Returns an
   * unsubscribe function.
   */
  onReclaim(cb: (token: string) => void): () => void;
  readonly leaseMs: number;
}

/**
 * Create the global dolt push mutex (port of
 * packages/apra-fleet-se/src/supervisor/dolt-mutex.mjs -- see the module header
 * for why it is restated rather than imported).
 */
export function createDoltMutex(deps: MutexDeps = {}): DoltMutex {
  const leaseMs = Number.isFinite(deps.leaseMs) && (deps.leaseMs as number) > 0 ? (deps.leaseMs as number) : DEFAULT_LEASE_MS;
  const sweepMs = Number.isFinite(deps.sweepMs) && (deps.sweepMs as number) > 0 ? (deps.sweepMs as number) : DEFAULT_SWEEP_MS;
  const now = deps.now ?? (() => Date.now());
  const probe = deps.isPidAlive ?? isPidAlive;
  const log = (...a: any[]) => (deps.logger ?? console).log?.(...a);

  let holder: Holder | null = null;
  const waiters: Waiter[] = [];
  let sweepTimer: NodeJS.Timeout | null = null;
  const reclaimListeners = new Set<(token: string) => void>();

  function grant(waiter: Waiter): void {
    const at = now();
    holder = {
      sprintId: waiter.sprintId,
      token: nextToken(waiter.sprintId),
      pid: waiter.pid ?? null,
      acquiredAt: at,
      expiresAt: at + leaseMs,
    };
    waiter.resolve({ token: holder.token, sprintId: holder.sprintId, expiresAt: holder.expiresAt });
  }

  function pump(): void {
    if (holder !== null) return;
    const next = waiters.shift();
    if (next) grant(next);
  }

  function reclaimExpired(): boolean {
    if (holder === null) return false;
    const t = now();
    const leaseExpired = t >= holder.expiresAt;
    // pid == null means the caller opted out of pid-probing -- lease only.
    const pidDead = holder.pid != null && !probe(holder.pid);
    if (!leaseExpired && !pidDead) return false;
    log(`[dolt-mutex] reclaiming ${leaseExpired ? 'expired' : 'dead-pid'} holder '${holder.sprintId}' (pid ${holder.pid ?? 'n/a'}); ${waiters.length} waiter(s) queued`);
    const reclaimedToken = holder.token;
    holder = null;
    for (const cb of reclaimListeners) cb(reclaimedToken);
    pump();
    return true;
  }

  function acquire(sprintId: string, opts: { pid?: number | null } = {}): Promise<MutexGrant> {
    if (typeof sprintId !== 'string' || sprintId.length === 0) {
      return Promise.reject(new TypeError('acquire() requires a non-empty sprintId'));
    }
    const pid = opts.pid == null ? null : opts.pid;
    if (pid !== null && !Number.isInteger(pid)) {
      return Promise.reject(new TypeError('acquire() pid must be an integer or null'));
    }
    reclaimExpired();
    return new Promise<MutexGrant>((resolve, reject) => {
      waiters.push({ sprintId, pid, resolve, reject, enqueuedAt: now() });
      pump();
    });
  }

  function release(token: string): boolean {
    if (holder === null || holder.token !== token) return false;
    log(`[dolt-mutex] '${holder.sprintId}' released; ${waiters.length} waiter(s) queued`);
    holder = null;
    pump();
    return true;
  }

  function renew(token: string): false | { expiresAt: number } {
    if (holder === null || holder.token !== token) return false;
    holder.expiresAt = now() + leaseMs;
    return { expiresAt: holder.expiresAt };
  }

  function cancelWaiter(sprintId: string, reason?: Error): number {
    let dropped = 0;
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].sprintId === sprintId) {
        const [w] = waiters.splice(i, 1);
        dropped += 1;
        w.reject(reason ?? new Error(`acquire cancelled for sprint '${sprintId}'`));
      }
    }
    return dropped;
  }

  return {
    acquire,
    release,
    renew,
    reclaimExpired,
    cancelWaiter,
    status() {
      return {
        held: holder !== null,
        holder: holder
          ? { sprintId: holder.sprintId, pid: holder.pid, acquiredAt: holder.acquiredAt, expiresAt: holder.expiresAt }
          : null,
        waiting: waiters.map((w) => ({ sprintId: w.sprintId, pid: w.pid, enqueuedAt: w.enqueuedAt })),
        queueDepth: waiters.length,
      };
    },
    start() {
      if (sweepTimer) return;
      sweepTimer = setInterval(() => { reclaimExpired(); }, sweepMs);
      if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    },
    stop() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      while (waiters.length > 0) {
        const w = waiters.shift() as Waiter;
        w.reject(new Error('dolt mutex is shutting down'));
      }
    },
    onReclaim(cb: (token: string) => void): () => void {
      reclaimListeners.add(cb);
      return () => { reclaimListeners.delete(cb); };
    },
    get leaseMs() { return leaseMs; },
  };
}

// -----------------------------------------------------------------------------
// Ticketed acquire adapter (the MCP transport adaptation -- see module header)
// -----------------------------------------------------------------------------

interface Ticket {
  ticket: string;
  sprintId: string;
  state: 'pending' | 'granted' | 'failed';
  grant: MutexGrant | null;
  error: string | null;
  /** Resolvers of in-flight bounded waits, woken exactly once on settle. */
  wakeups: Set<() => void>;
}

export interface TicketedMutex {
  mutex: DoltMutex;
  acquire(sprintId: string, opts?: { pid?: number | null; waitMs?: number }): Promise<{ granted: boolean; ticket: string; grant: MutexGrant | null; error: string | null }>;
  poll(ticket: string, opts?: { waitMs?: number }): Promise<{ known: boolean; granted: boolean; ticket: string; grant: MutexGrant | null; error: string | null }>;
  cancel(ticket: string): { known: boolean; cancelled: boolean; released: boolean };
  release(token: string): boolean;
  ticketCount(): number;
}

/**
 * Wrap a DoltMutex so a blocking FIFO acquire can be driven over a
 * request/response transport WITHOUT losing FIFO order: the underlying
 * `acquire()` promise is created ONCE per ticket and parked here; polling only
 * observes it. A timed-out poller never leaves the queue.
 */
export function createTicketedMutex(mutex: DoltMutex): TicketedMutex {
  const tickets = new Map<string, Ticket>();
  const byToken = new Map<string, string>();

  // A granted ticket's underlying mutex holder can be reclaimed (lease
  // expiry or dead-pid probe, see DoltMutex#reclaimExpired) without ever
  // going through this class's own `release(token)`/`cancel(ticket)` paths.
  // Left unhandled, that ticket (and its byToken entry) would sit in the map
  // forever -- on the always-on fleet server these accumulate monotonically.
  // Drop it the moment the underlying grant is reclaimed.
  mutex.onReclaim((token) => {
    const ticketId = byToken.get(token);
    if (ticketId) {
      byToken.delete(token);
      tickets.delete(ticketId);
    }
  });

  function boundedWait(ms: number | undefined): number {
    const raw = Number.isFinite(ms) ? (ms as number) : DEFAULT_WAIT_MS;
    return Math.max(0, Math.min(raw, MAX_WAIT_MS));
  }

  function settleView(t: Ticket) {
    return { known: true, granted: t.state === 'granted', ticket: t.ticket, grant: t.grant, error: t.error };
  }

  function settle(t: Ticket): void {
    for (const wake of t.wakeups) wake();
    t.wakeups.clear();
  }

  /**
   * Block up to `waitMs` for this ticket to settle, WITHOUT dequeuing it: the
   * ticket's underlying mutex waiter is untouched, so a timed-out caller keeps
   * its FIFO position and simply polls again.
   */
  async function waitFor(t: Ticket, waitMs: number): Promise<void> {
    if (t.state !== 'pending' || waitMs <= 0) return;
    let wake!: () => void;
    const settled = new Promise<void>((resolve) => { wake = resolve; });
    t.wakeups.add(wake);
    try {
      await Promise.race([settled, sleep(waitMs)]);
    } finally {
      t.wakeups.delete(wake);
    }
  }

  return {
    mutex,

    async acquire(sprintId, opts = {}) {
      const ticketId = nextToken(`ticket:${sprintId}`);
      const t: Ticket = { ticket: ticketId, sprintId, state: 'pending', grant: null, error: null, wakeups: new Set() };
      tickets.set(ticketId, t);
      // ONE enqueue per ticket; the waiter stays queued across every poll.
      mutex.acquire(sprintId, { pid: opts.pid ?? null }).then(
        (g) => { t.state = 'granted'; t.grant = g; byToken.set(g.token, ticketId); settle(t); },
        (err: Error) => { t.state = 'failed'; t.error = err.message; settle(t); },
      );
      await waitFor(t, boundedWait(opts.waitMs));
      const view = settleView(t);
      return { granted: view.granted, ticket: ticketId, grant: view.grant, error: view.error };
    },

    async poll(ticket, opts = {}) {
      const t = tickets.get(ticket);
      if (!t) return { known: false, granted: false, ticket, grant: null, error: 'unknown ticket' };
      await waitFor(t, boundedWait(opts.waitMs));
      return settleView(t);
    },

    cancel(ticket) {
      const t = tickets.get(ticket);
      if (!t) return { known: false, cancelled: false, released: false };
      if (t.state === 'granted' && t.grant) {
        const released = mutex.release(t.grant.token);
        byToken.delete(t.grant.token);
        tickets.delete(ticket);
        return { known: true, cancelled: false, released };
      }
      const dropped = mutex.cancelWaiter(t.sprintId, new Error(`acquire cancelled for ticket '${ticket}'`));
      tickets.delete(ticket);
      return { known: true, cancelled: dropped > 0, released: false };
    },

    release(token) {
      const released = mutex.release(token);
      const ticketId = byToken.get(token);
      if (ticketId) { tickets.delete(ticketId); byToken.delete(token); }
      return released;
    },

    ticketCount() { return tickets.size; },
  };
}

// -----------------------------------------------------------------------------
// Child-id allocator
// -----------------------------------------------------------------------------

export interface AllocatorDeps {
  filePath?: string;
  leaseMs?: number;
  sweepMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  fs?: Pick<typeof fsp, 'mkdir' | 'readFile' | 'writeFile' | 'rename'>;
  logger?: { log?: (...a: any[]) => void };
}

interface Reservation {
  seq: number;
  pid: number | null;
  sprintId: string | null;
  reservedAt: number;
  expiresAt: number;
}

interface ParentState {
  highWater: number;
  free: number[];
  reserved: Map<string, Reservation>;
}

export interface IdAllocator {
  filePath: string;
  load(): Promise<void>;
  allocate(parentId: string, opts?: { pid?: number | null; sprintId?: string; floor?: number }): Promise<{ childId: string; parentId: string; seq: number; token: string; expiresAt: number }>;
  confirm(token: string): Promise<boolean>;
  release(token: string): Promise<boolean>;
  reclaimExpired(): number;
  status(): { parents: Record<string, { highWater: number; free: number[]; reserved: Array<{ seq: number; pid: number | null; sprintId: string | null; expiresAt: number }> }> };
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly leaseMs: number;
}

/**
 * Create the global child-id allocator (port of
 * packages/apra-fleet-se/src/supervisor/id-allocator.mjs -- see module header).
 */
export function createIdAllocator(deps: AllocatorDeps = {}): IdAllocator {
  const filePath = deps.filePath ?? defaultIdAllocatorPath();
  const tmpPath = `${filePath}.tmp`;
  const leaseMs = Number.isFinite(deps.leaseMs) && (deps.leaseMs as number) > 0 ? (deps.leaseMs as number) : DEFAULT_LEASE_MS;
  const sweepMs = Number.isFinite(deps.sweepMs) && (deps.sweepMs as number) > 0 ? (deps.sweepMs as number) : DEFAULT_SWEEP_MS;
  const now = deps.now ?? (() => Date.now());
  const probe = deps.isPidAlive ?? isPidAlive;
  const fs = deps.fs ?? fsp;
  const log = (...a: any[]) => (deps.logger ?? console).log?.(...a);

  let parents = new Map<string, ParentState>();
  let loaded = false;
  let sweepTimer: NodeJS.Timeout | null = null;
  let persistChain: Promise<void> = Promise.resolve();

  function parentState(parentId: string): ParentState {
    let st = parents.get(parentId);
    if (!st) {
      st = { highWater: 0, free: [], reserved: new Map() };
      parents.set(parentId, st);
    }
    return st;
  }

  function currentDocument(): { version: number; parents: Record<string, any> } {
    const doc: { version: number; parents: Record<string, any> } = { version: ID_ALLOCATOR_VERSION, parents: {} };
    for (const [parentId, st] of parents) {
      const reserved: Record<string, Reservation> = {};
      for (const [token, r] of st.reserved) {
        reserved[token] = { seq: r.seq, pid: r.pid, sprintId: r.sprintId, reservedAt: r.reservedAt, expiresAt: r.expiresAt };
      }
      doc.parents[parentId] = {
        highWater: st.highWater,
        free: [...st.free].sort((a, b) => a - b),
        reserved,
      };
    }
    return doc;
  }

  function persist(): Promise<void> {
    const snapshot = `${JSON.stringify(currentDocument(), null, 2)}\n`;
    const run = persistChain.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tmpPath, snapshot, 'utf-8');
      await fs.rename(tmpPath, filePath);
    });
    persistChain = run.catch(() => {});
    return run;
  }

  async function load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8') as string;
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        parents = new Map();
        loaded = true;
        return;
      }
      throw err;
    }
    let doc: any;
    try {
      doc = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`id-allocator file ${filePath} is not valid JSON: ${err.message}`);
    }
    if (!doc || typeof doc !== 'object' || doc.version !== ID_ALLOCATOR_VERSION || typeof doc.parents !== 'object') {
      throw new Error(`id-allocator file ${filePath} has an unexpected shape or version (expected ${ID_ALLOCATOR_VERSION})`);
    }
    const next = new Map<string, ParentState>();
    for (const [parentId, st] of Object.entries<any>(doc.parents)) {
      const reserved = new Map<string, Reservation>();
      for (const [token, r] of Object.entries<any>(st.reserved ?? {})) {
        reserved.set(token, {
          seq: r.seq,
          pid: r.pid ?? null,
          sprintId: r.sprintId ?? null,
          reservedAt: r.reservedAt ?? 0,
          expiresAt: r.expiresAt ?? 0,
        });
      }
      next.set(parentId, {
        highWater: Number.isInteger(st.highWater) ? st.highWater : 0,
        free: Array.isArray(st.free) ? st.free.filter(Number.isInteger).sort((a: number, b: number) => a - b) : [],
        reserved,
      });
    }
    parents = next;
    loaded = true;
  }

  function reclaimExpired(): number {
    const t = now();
    let reclaimed = 0;
    for (const [parentId, st] of parents) {
      for (const [token, r] of st.reserved) {
        const leaseExpired = t >= r.expiresAt;
        const pidDead = r.pid != null && !probe(r.pid);
        if (!leaseExpired && !pidDead) continue;
        st.reserved.delete(token);
        if (!st.free.includes(r.seq)) st.free.push(r.seq);
        st.free.sort((a, b) => a - b);
        reclaimed += 1;
        log(`[id-allocator] reclaimed ${leaseExpired ? 'expired' : 'dead-pid'} reservation '${parentId}.${r.seq}' (sprint ${r.sprintId ?? 'n/a'}, pid ${r.pid ?? 'n/a'})`);
      }
    }
    return reclaimed;
  }

  async function allocate(parentId: string, opts: { pid?: number | null; sprintId?: string; floor?: number } = {}) {
    if (typeof parentId !== 'string' || parentId.length === 0) {
      throw new TypeError('allocate() requires a non-empty parentId');
    }
    const pid = opts.pid == null ? null : opts.pid;
    if (pid !== null && !Number.isInteger(pid)) {
      throw new TypeError('allocate() pid must be an integer or null');
    }
    reclaimExpired();

    const st = parentState(parentId);
    if (Number.isInteger(opts.floor) && (opts.floor as number) > st.highWater) {
      st.highWater = opts.floor as number;
      st.free = st.free.filter((n) => n > (opts.floor as number));
    }

    // Synchronous seq assignment -- no await before this mutation.
    let seq: number;
    if (st.free.length > 0) {
      seq = st.free.shift() as number;
    } else {
      st.highWater += 1;
      seq = st.highWater;
    }
    const at = now();
    const token = nextToken(parentId);
    st.reserved.set(token, {
      seq,
      pid,
      sprintId: opts.sprintId ?? null,
      reservedAt: at,
      expiresAt: at + leaseMs,
    });

    // Durability barrier: never hand back an id that is not yet on disk.
    await persist();
    return { childId: `${parentId}.${seq}`, parentId, seq, token, expiresAt: at + leaseMs };
  }

  async function confirm(token: string): Promise<boolean> {
    for (const st of parents.values()) {
      const r = st.reserved.get(token);
      if (r) {
        st.reserved.delete(token);
        await persist();
        return true;
      }
    }
    return false;
  }

  async function release(token: string): Promise<boolean> {
    for (const st of parents.values()) {
      const r = st.reserved.get(token);
      if (r) {
        st.reserved.delete(token);
        if (!st.free.includes(r.seq)) st.free.push(r.seq);
        st.free.sort((a, b) => a - b);
        await persist();
        return true;
      }
    }
    return false;
  }

  return {
    filePath,
    load,
    allocate,
    confirm,
    release,
    reclaimExpired,
    status() {
      const out: Record<string, any> = {};
      for (const [parentId, st] of parents) {
        out[parentId] = {
          highWater: st.highWater,
          free: [...st.free].sort((a, b) => a - b),
          reserved: [...st.reserved.values()].map((r) => ({ seq: r.seq, pid: r.pid, sprintId: r.sprintId, expiresAt: r.expiresAt })),
        };
      }
      return { parents: out };
    },
    async start() {
      if (!loaded) await load();
      if (sweepTimer) return;
      sweepTimer = setInterval(() => {
        if (reclaimExpired() > 0) persist().catch(() => {});
      }, sweepMs);
      if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    },
    async stop() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      await persistChain;
    },
    get leaseMs() { return leaseMs; },
  };
}

// -----------------------------------------------------------------------------
// Per-server-process singletons (lazily created; sweep timers unref'd so they
// never keep the process alive)
// -----------------------------------------------------------------------------

let ticketedMutexSingleton: TicketedMutex | null = null;
let allocatorSingleton: IdAllocator | null = null;

export function getDoltPushMutex(): TicketedMutex {
  if (!ticketedMutexSingleton) {
    const mutex = createDoltMutex({ logger: { log: () => {} } });
    mutex.start();
    ticketedMutexSingleton = createTicketedMutex(mutex);
  }
  return ticketedMutexSingleton;
}

export async function getChildIdAllocator(): Promise<IdAllocator> {
  if (!allocatorSingleton) {
    const allocator = createIdAllocator({ logger: { log: () => {} } });
    await allocator.start();
    allocatorSingleton = allocator;
  }
  return allocatorSingleton;
}

/** Test seam: drop the process singletons (also stops their sweep timers). */
export async function resetSprintCoordinationForTest(): Promise<void> {
  if (ticketedMutexSingleton) {
    ticketedMutexSingleton.mutex.stop();
    ticketedMutexSingleton = null;
  }
  if (allocatorSingleton) {
    await allocatorSingleton.stop();
    allocatorSingleton = null;
  }
}
