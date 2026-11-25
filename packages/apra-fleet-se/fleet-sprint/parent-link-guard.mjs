// parent-link-guard.mjs -- keeps the sprint's view of parenthood stable
// within a run and restores parent-child and blocks links that a CONFLICTED
// beads pull dropped -- and only those.
//
// WHY: a conflicting `bd dolt pull` on the pinned bd auto-resolves and can
// keep one side's dependency table wholesale, silently DELETING parent-child
// and blocks edges. A lost parent link turns a parent into a childless leaf
// (it is dispatched to a doer and the run stalls); a lost blocks edge releases
// a bead before its prerequisite is done.
//
// WHAT IS RESTORED: agents legitimately remove links on their own clones
// (the planner retargets or reverses a blocks edge to break a cycle, an agent
// reparents a bead), so a link that is simply missing from a later read is
// NOT evidence of a loss. The only evidence is a pull: every engine
// `bd dolt pull` goes through createBeadsScope's command wrapper, which reads
// the pulling clone immediately BEFORE the pull and immediately AFTER it. A
// link present before and missing after, with both endpoints still present,
// is a restore candidate: it becomes OWED by that member (notePull). The
// pinned bd gives the engine no reliable "this pull hit a conflict" signal
// (its notice goes to stderr, which the command seam does not return on
// success), so every pull is compared -- and a clean pull that merely
// carries ANOTHER clone's deliberate removal looks the same. That is what
// the run-wide AGENT-REMOVAL RECORD is for:
//   - every read of a clone (the pull bracket's reads and the read the engine
//     takes before every push) is compared with that clone's previous read;
//     a link that clone lost with no pull in between was removed on that
//     clone on purpose (an agent, an operator in that checkout, or this
//     run), and goes on the record (noteRead). Its loss is never restored.
//   - a link this run removes through its own command path (`bd dep remove`,
//     `bd update --parent`) goes on the record as well.
//   - the record is shared by every clone and kept for the whole run, so a
//     pull comparison on ANY clone skips a link on it: a removal the planner
//     made on one member and pushed is not restored when another member
//     pulls it.
//   - a link comes off the record when it is deliberately re-added: present
//     in a read of a clone whose previous read (no pull in between) lacked
//     it, or re-added by this run (`bd dep add`, `bd update --parent`).
//   - every clone gets a baseline before an agent can edit it: each fresh
//     backlog snapshot is noted as a read of the backlog clone (so a
//     planner whose pre-dispatch pull was skipped still has one), and a
//     beads-pushing dispatch whose clone has no baseline yet (its pull was
//     skipped or could not be bracketed) reads it before the agent runs.
//     A first read with no baseline can only set one, so without this a
//     removal made before it would go unrecorded and be restored.
//   - GAP: a removal made on a clone the engine never reads (an operator
//     checkout outside the run) is not on the record; when a sprint member
//     pulls it, it is restored.
// Nothing else is ever restored:
//   - a link removed between two reads with no pull in between is forgotten
//     by the ledger (and recorded as above);
//   - a link an agent removes after a pull is never compared to that pull;
//   - a link removed by the engine itself through the command path cancels
//     any owed restore of it.
//
// Rules for the recorded (scope) view:
//   - Every in-scope parent-child edge seen in a backlog snapshot is recorded
//     (child -> parent), as is every in-scope id seen, and every in-scope
//     blocks edge (either endpoint in scope; A blocked-by B).
//   - A recorded edge whose child or parent is no longer in the DB was
//     DELETED (`bd delete` removes the issue and every edge touching it): it
//     is dropped from the ledger and reported for a WARN, never restored.
//   - A recorded edge the snapshot lacks otherwise is forgotten (moved or
//     removed) unless the backlog member owes it, in which case it is
//     restored with an ERROR line (a child back under another parent is a
//     revert and the ERROR names both parents).
//   - A bead is a known parent while some recorded edge still points at it;
//     an owed edge stays recorded until it is restored.
//   - An id once in scope stays in scope.
//
// INVARIANT H5 (enforced together with beads-scope.mjs and dolt-sync.mjs):
// a link a conflicted pull dropped is never absent from what a beads push
// publishes. This module decides which links are owed; beads-scope.mjs
// brackets every pull, reads every pushing clone, and restores them (on the backlog's next fresh
// snapshot and, via verifyLinksBeforePush, on the pushing clone before its
// push); dolt-sync.mjs doltPushAfter commits the merged working set and runs
// that verify before the first push of a member whose pull merged remote
// changes, and after every reconcile pull, and refuses to push until it
// succeeded.
//
// ASCII only.

/**
 * Thrown when a vanished parent-child or blocks link could not be restored
 * (or the links could not be verified before a push). `edges` lists every
 * vanished edge, each tagged `kind: 'parent-child'` or `kind: 'blocks'`.
 */
export class ParentLinkRestoreError extends Error {
    constructor(message, { edges = [], cause } = {}) {
        super(message);
        this.name = 'ParentLinkRestoreError';
        this.edges = edges;
        if (cause !== undefined) this.cause = cause;
    }
}

const hasParent = (b) => b && b.parent !== undefined && b.parent !== null && b.parent !== '';

// `bd update <id> ... --parent <p>` / `--parent=<p>` / `--parent ""` (removal).
const UPDATE_PARENT_RE = /^bd\s+update\s+(\S+)\b.*?\s--parent(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S*))/i;
// `bd dep remove|rm <a> <b>` -- drops whatever edge joins the two.
const DEP_REMOVE_RE = /^bd\s+dep\s+(?:remove|rm)\s+(\S+)\s+(\S+)/i;
// `bd dep add <a> <b>` -- (re)adds the edge `a` blocked-by `b`.
const DEP_ADD_RE = /^bd\s+dep\s+add\s+(\S+)\s+(\S+)/i;

/**
 * Parse a LOGICAL bd command (env prefix already stripped) for a
 * parent-child change it makes.
 *
 * @param {string} cmd
 * @returns {{ kind: 'reparent', child: string, parent: string } | { kind: 'remove', a: string, b: string } | { kind: 'add', a: string, b: string } | null}
 *   reparent with parent '' means "parent removed".
 */
export function parseRunEdgeChange(cmd) {
    if (typeof cmd !== 'string') return null;
    const text = cmd.trim();
    const up = UPDATE_PARENT_RE.exec(text);
    if (up) {
        const parent = up[2] ?? up[3] ?? up[4] ?? '';
        return { kind: 'reparent', child: up[1], parent: parent.startsWith('--') ? '' : parent };
    }
    const rm = DEP_REMOVE_RE.exec(text);
    if (rm) return { kind: 'remove', a: rm[1], b: rm[2] };
    const add = DEP_ADD_RE.exec(text);
    if (add) return { kind: 'add', a: add[1], b: add[2] };
    return null;
}

/** A bead's blocks prerequisites (ids it is blocked by), across bd's dependency shapes. */
export function blocksPrereqsOf(bead) {
    const deps = bead && Array.isArray(bead.dependencies) ? bead.dependencies : [];
    const out = [];
    for (const d of deps) {
        if (typeof d === 'string') { if (d) out.push(d); continue; }
        if (!d || typeof d !== 'object') continue;
        const type = d.type ?? d.dependency_type;
        if (type !== undefined && type !== 'blocks') continue;
        const id = d.depends_on_id ?? d.id;
        if (id !== undefined && id !== null && id !== '') out.push(String(id));
    }
    return out;
}

/** The ERROR line for one vanished blocks edge that is being restored. */
export function formatVanishedBlocksLog({ blocked, blocker }) {
    return `ERROR: blocks link vanished from the beads database: '${blocked}' is no longer blocked by '${blocker}', ` +
        'and this run did not remove it (a beads merge or another writer dropped it). ' +
        `Restoring it with 'bd dep add ${blocked} ${blocker}'.`;
}

/** The WARN line for one recorded blocks edge dropped because an endpoint was deleted. */
export function formatDroppedBlocksLog({ blocked, blocker, reason }) {
    const gone = reason === 'blocker-missing' ? `the blocker '${blocker}' is`
        : reason === 'blocked-missing' ? `the blocked bead '${blocked}' is`
            : `both '${blocked}' and '${blocker}' are`;
    return `WARN: blocks link '${blocked}' blocked by '${blocker}' is no longer tracked: ${gone} no longer in the beads database ` +
        '(deleted). This is not a lost link, so it is not restored.';
}

/** The restore command for one vanished edge of either kind. */
export function restoreCommandFor(edge) {
    return edge.kind === 'blocks'
        ? `bd dep add ${edge.blocked} ${edge.blocker}`
        : `bd update ${edge.child} --parent ${edge.parent}`;
}

/** A short human name for one edge of either kind. */
export function describeEdge(edge) {
    return edge.kind === 'blocks'
        ? `blocks link '${edge.blocked}' blocked by '${edge.blocker}'`
        : `parent-child link '${edge.child}' -> parent '${edge.parent}'`;
}

/** The ERROR line for one vanished (or reverted) edge that is being restored. */
export function formatVanishedEdgeLog({ child, parent, revertedFrom }) {
    if (revertedFrom) {
        return `ERROR: parent-child link reverted in the beads database: '${child}' is back under '${revertedFrom}', ` +
            `a parent it was moved away from in this run, instead of '${parent}' ` +
            '(a beads merge or another writer brought back an older link). ' +
            `Restoring it with 'bd update ${child} --parent ${parent}'.`;
    }
    return `ERROR: parent-child link vanished from the beads database: '${child}' is no longer a child of '${parent}', ` +
        'and this run did not remove it (a beads merge or another writer dropped it). ' +
        `Restoring it with 'bd update ${child} --parent ${parent}'.`;
}

/** The ERROR line (and error message) when restoring an edge failed. */
export function formatRestoreFailure({ child, parent }, reason) {
    return `ERROR: could not restore the vanished parent-child link '${child}' -> parent '${parent}': ${reason}. ` +
        'The sprint scope can no longer be trusted (the parent would look like a leaf and its children would drop out of scope); ' +
        `stopping. Re-link it by hand with 'bd update ${child} --parent ${parent}' and re-run the sprint.`;
}

/**
 * The WARN line for one recorded edge dropped because an endpoint was deleted.
 * @param {{ child: string, parent: string, reason: 'child-missing'|'parent-missing'|'both-missing' }} drop
 */
export function formatDroppedEdgeLog({ child, parent, reason }) {
    const gone = reason === 'parent-missing' ? `the parent '${parent}' is`
        : reason === 'child-missing' ? `the child '${child}' is`
            : `both '${child}' and '${parent}' are`;
    return `WARN: parent-child link '${child}' -> parent '${parent}' is no longer tracked: ${gone} no longer in the beads database ` +
        '(deleted). This is not a lost link, so it is not restored.';
}


const pcKey = (child, parent) => `pc\u0000${child}\u0000${parent}`;
const blocksKey = (blocked, blocker) => `b\u0000${blocked}\u0000${blocker}`;

/**
 * The per-run ledger. All state lives in the closure; nothing is persisted.
 */
export function createParentLinkLedger() {
    /** child -> parent, for every in-scope parent-child edge seen. */
    const edges = new Map();
    const knownScope = new Set();
    /** blocksKey(blocked, blocker) -> { blocked, blocker } for every in-scope blocks edge seen. */
    const blocks = new Map();
    /**
     * member -> Map(key -> edge): links a CONFLICTED pull on that member's
     * clone dropped (present right before the pull, missing right after,
     * both endpoints still present). Only these are ever restored.
     */
    const pullLosses = new Map();
    /**
     * member -> Map(key -> edge): that clone's in-scope links at its last
     * read (noteRead / notePull). Dropped when a pull on it could not be
     * bracketed, so a loss across that pull is never mistaken for a
     * deliberate removal.
     */
    const lastRead = new Map();
    /**
     * key -> edge: the run-wide AGENT-REMOVAL RECORD (see the header). Links
     * removed on purpose on some clone; no pull comparison restores them.
     */
    const agentRemovals = new Map();

    /**
     * Record a snapshot's in-scope edges and ids.
     * @param {object[]} allBeads
     * @param {Set<string>} scopeIds
     */
    function observe(allBeads, scopeIds) {
        for (const id of scopeIds) knownScope.add(id);
        for (const b of (allBeads || [])) {
            if (!b) continue;
            for (const blocker of blocksPrereqsOf(b)) {
                if (!scopeIds.has(b.id) && !scopeIds.has(blocker)) continue;
                blocks.set(blocksKey(b.id, blocker), { blocked: b.id, blocker });
            }
            if (!hasParent(b) || !scopeIds.has(b.id)) continue;
            edges.set(b.id, b.parent);
        }
    }

    /** Every in-scope link of one clone read, keyed: parent-child (child in scope), blocks (either endpoint in scope). */
    function linksOf(allBeads) {
        const out = new Map();
        for (const b of (allBeads || [])) {
            if (!b || b.id === undefined || b.id === null) continue;
            if (hasParent(b) && knownScope.has(b.id)) {
                out.set(pcKey(b.id, b.parent), { kind: 'parent-child', child: b.id, parent: b.parent });
            }
            for (const blocker of blocksPrereqsOf(b)) {
                if (!knownScope.has(b.id) && !knownScope.has(blocker)) continue;
                out.set(blocksKey(b.id, blocker), { kind: 'blocks', blocked: b.id, blocker });
            }
        }
        return out;
    }

    const idsOf = (allBeads) => {
        const ids = new Set();
        for (const b of (allBeads || [])) if (b && b.id !== undefined && b.id !== null) ids.add(b.id);
        return ids;
    };

    /** Whether `edge` is present in a by-id view of one clone. */
    function isPresent(edge, byId) {
        const bead = byId.get(edge.kind === 'blocks' ? edge.blocked : edge.child);
        if (!bead) return false;
        return edge.kind === 'blocks' ? blocksPrereqsOf(bead).includes(edge.blocker) : bead.parent === edge.parent;
    }

    const keyOf = (edge) => (edge.kind === 'blocks' ? blocksKey(edge.blocked, edge.blocker) : pcKey(edge.child, edge.parent));
    const endsOf = (edge) => (edge.kind === 'blocks' ? [edge.blocked, edge.blocker] : [edge.child, edge.parent]);

    /**
     * One read of `member`'s clone with NO pull since its previous read
     * (the pull bracket's before-read, or the read taken before a push).
     * Every in-scope link the previous read had and this one lacks, with
     * both endpoints still present and not owed by a pull on this clone,
     * was removed on purpose on that clone: it goes on the run-wide
     * agent-removal record. Every link this read has and the previous one
     * lacked was (re-)added on purpose: it comes off the record. The first
     * read of a clone only sets its baseline.
     * @returns {object[]} the links newly put on the record
     */
    function noteRead(member, allBeads) {
        if (knownScope.size === 0) return [];
        const now = linksOf(allBeads);
        const prev = lastRead.get(member);
        const recorded = [];
        if (prev) {
            const ids = idsOf(allBeads);
            const owed = pullLosses.get(member);
            for (const [key, edge] of prev) {
                if (now.has(key) || (owed && owed.has(key))) continue;
                const [a, b] = endsOf(edge);
                if (!ids.has(a) || !ids.has(b)) continue;
                if (!agentRemovals.has(key)) {
                    agentRemovals.set(key, edge);
                    recorded.push({ ...edge });
                }
            }
            for (const key of now.keys()) if (!prev.has(key)) agentRemovals.delete(key);
        }
        lastRead.set(member, now);
        return recorded;
    }

    /** Forget `member`'s last read: a pull on it could not be bracketed, so the next read only sets a new baseline. */
    function forgetRead(member) { lastRead.delete(member); }

    /**
     * One pull on `member`'s clone: `before` is that clone read immediately
     * before the pull, `after` immediately after it. `before` is first noted
     * as a read (removals since the clone's previous read are deliberate).
     * Every in-scope link present before and missing after, with both
     * endpoints still in the clone and not on the agent-removal record, is
     * a restore candidate and becomes owed by that member. Links an agent
     * removed before the pull are absent from `before`; links removed after
     * it are never compared -- neither is owed. `after` null (the clone could
     * not be read after the pull) owes every in-scope link of `before` not
     * on the record: a verify restores only those still missing.
     * @returns {object[]} the newly owed links
     */
    function notePull(member, before, after) {
        if (knownScope.size === 0) return [];
        noteRead(member, before);
        const pre = linksOf(before);
        const post = after ? linksOf(after) : new Map();
        const present = idsOf(after || before);
        const lost = [];
        for (const [key, edge] of pre) {
            if (post.has(key) || agentRemovals.has(key)) continue;
            const [a, b] = endsOf(edge);
            if (!present.has(a) || !present.has(b)) continue;
            lost.push(edge);
        }
        if (after) lastRead.set(member, post);
        else lastRead.delete(member);
        if (lost.length === 0) return [];
        if (!pullLosses.has(member)) pullLosses.set(member, new Map());
        const owed = pullLosses.get(member);
        for (const edge of lost) owed.set(keyOf(edge), edge);
        return lost.map((e) => ({ ...e }));
    }

    /** Drop owed links matching `pred` on every member. */
    function forgetOwed(pred) {
        for (const owed of pullLosses.values()) {
            for (const [key, edge] of owed) if (pred(edge)) owed.delete(key);
        }
    }

    /**
     * Note a link change this run made through the command path: the run's
     * own change supersedes any owed restore of the links it touches, a link
     * it removes goes on the agent-removal record, and a link it (re-)adds
     * comes off it.
     * @param {ReturnType<typeof parseRunEdgeChange>} change
     */
    function noteRunEdgeChange(change) {
        if (!change) return;
        if (change.kind === 'add') {
            agentRemovals.delete(blocksKey(change.a, change.b));
            return;
        }
        if (change.kind === 'reparent') {
            // A deliberate move cancels owed links to any OTHER parent; an
            // owed link to this same parent stays owed elsewhere (this is
            // the same link, restored here).
            forgetOwed((e) => e.kind === 'parent-child' && e.child === change.child && e.parent !== change.parent);
            const old = edges.get(change.child);
            if (old !== undefined && old !== change.parent) {
                agentRemovals.set(pcKey(change.child, old), { kind: 'parent-child', child: change.child, parent: old });
            }
            if (change.parent) {
                agentRemovals.delete(pcKey(change.child, change.parent));
                edges.set(change.child, change.parent);
            } else edges.delete(change.child);
            return;
        }
        // `bd dep remove a b`: either direction, either kind.
        const pair = (x, y) => (x === change.a && y === change.b) || (x === change.b && y === change.a);
        forgetOwed((e) => (e.kind === 'blocks' ? pair(e.blocked, e.blocker) : pair(e.child, e.parent)));
        for (const [x, y] of [[change.a, change.b], [change.b, change.a]]) {
            agentRemovals.set(blocksKey(x, y), { kind: 'blocks', blocked: x, blocker: y });
            if (edges.get(x) === y) agentRemovals.set(pcKey(x, y), { kind: 'parent-child', child: x, parent: y });
        }
    }

    /**
     * The links `member` owes that `allBeads` (a read of that member's
     * clone) still lacks, read-only. An owed link whose endpoint is gone is
     * not owed any more; one already present needs nothing.
     */
    function owedMissing(member, allBeads) {
        const owed = pullLosses.get(member);
        if (!owed || owed.size === 0) return [];
        const byId = new Map();
        for (const b of (allBeads || [])) if (b && b.id !== undefined && b.id !== null) byId.set(b.id, b);
        const out = [];
        for (const [key, edge] of owed) {
            if (agentRemovals.has(key)) continue;
            const a = edge.kind === 'blocks' ? edge.blocked : edge.child;
            const b = edge.kind === 'blocks' ? edge.blocker : edge.parent;
            if (!byId.has(a) || !byId.has(b) || isPresent(edge, byId)) continue;
            const bead = byId.get(a);
            if (edge.kind === 'parent-child' && hasParent(bead)) out.push({ ...edge, revertedFrom: bead.parent });
            else out.push({ ...edge });
        }
        return out;
    }

    /** `member` is paid up: its owed links were restored or are present again. */
    function settleOwed(member) { pullLosses.delete(member); }

    /**
     * Reconcile the ledger with a fresh snapshot of `member` (the backlog
     * clone). A recorded link the snapshot lacks is FORGOTTEN -- an agent or
     * this run removed or moved it -- unless a conflicted pull on `member`
     * dropped it, in which case it is returned as vanished for the caller to
     * restore. Links with a deleted endpoint are dropped and reported for a
     * WARN.
     * @param {object[]} allBeads
     * @param {string} [member]
     */
    function reconcile(allBeads, member) {
        const byId = new Map();
        for (const b of (allBeads || [])) if (b && b.id !== undefined && b.id !== null) byId.set(b.id, b);
        const owedNow = member === undefined ? [] : owedMissing(member, allBeads);
        const owedKeys = new Set(owedNow.map((e) => (e.kind === 'blocks' ? blocksKey(e.blocked, e.blocker) : pcKey(e.child, e.parent))));
        const dropped = [];
        const moved = [];
        for (const [child, parent] of [...edges]) {
            const bead = byId.get(child);
            const parentPresent = byId.has(parent);
            if (!bead || !parentPresent) {
                const reason = !bead && !parentPresent ? 'both-missing' : (!bead ? 'child-missing' : 'parent-missing');
                dropped.push({ child, parent, reason });
                edges.delete(child);
                continue;
            }
            if (bead.parent === parent || owedKeys.has(pcKey(child, parent))) continue;
            if (hasParent(bead)) moved.push({ child, from: parent, to: bead.parent });
            // Moved (re-recorded by observe() when in scope) or removed by an agent/the run: forgotten.
            edges.delete(child);
        }
        const droppedBlocks = [];
        for (const [key, { blocked, blocker }] of [...blocks]) {
            const bead = byId.get(blocked);
            const blockerPresent = byId.has(blocker);
            if (!bead || !blockerPresent) {
                const reason = !bead && !blockerPresent ? 'both-missing' : (!bead ? 'blocked-missing' : 'blocker-missing');
                droppedBlocks.push({ kind: 'blocks', blocked, blocker, reason });
                blocks.delete(key);
                continue;
            }
            if (blocksPrereqsOf(bead).includes(blocker) || owedKeys.has(key)) continue;
            blocks.delete(key);
        }
        const vanished = owedNow.filter((e) => e.kind === 'parent-child').map(({ kind, ...rest }) => rest);
        const vanishedBlocks = owedNow.filter((e) => e.kind === 'blocks');
        return { vanished, dropped, moved, vanishedBlocks, droppedBlocks };
    }

    return {
        observe,
        notePull,
        noteRead,
        forgetRead,
        /** The run-wide agent-removal record (links removed on purpose on some clone) -- diagnostics/tests. */
        agentRemovalLinks: () => [...agentRemovals.values()].map((e) => ({ ...e })),
        noteRunEdgeChange,
        reconcile,
        settleOwed,
        /** The links `member` owes that a read of its clone still lacks (read-only), each tagged kind 'parent-child' or 'blocks'. */
        findVanishedLinks: (member, allBeads) => owedMissing(member, allBeads),
        /** Whether `member` owes any link (a conflicted pull on its clone dropped one not yet restored). */
        hasOwedLinks: (member) => (pullLosses.get(member)?.size ?? 0) > 0,
        /** Whether `member`'s clone has a read the next one is compared with (its baseline). */
        hasBaseline: (member) => lastRead.has(member),
        /** Whether any id is in the run's scope -- pulls are only compared once it is. */
        hasScope: () => knownScope.size > 0,
        /** Every recorded blocks edge -- diagnostics/tests. */
        knownBlocksEdges: () => [...blocks.values()].map((e) => ({ ...e })),
        /** Every bead some recorded edge still points at. */
        knownParentIds: () => new Set(edges.values()),
        /** Every id seen in scope this run (monotone). */
        knownScopeIds: () => new Set(knownScope),
    };
}
