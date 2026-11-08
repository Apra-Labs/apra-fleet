// =============================================================================
// PAUSED AWAITING A DECISION, AND RESUMING ON THE ANSWER.
//
// decisions.mjs records a NEEDS-DECISION request and sets its bead aside.
// When the run then reaches the point where it used to throw
// StalledSprintError -- nothing is ready and every open in-scope bead is set
// aside or stuck behind a set-aside bead -- and at least one decision is
// still pending, runner.js calls awaitAnswer() below instead of throwing.
//
// UNFILED DECISION: a decision whose decision bead could not be filed (the
// best-effort `bd create` in decisions.mjs failed) has no answer path, so it
// never holds the run: a stall on it alone still throws StalledSprintError,
// whose set-aside reason names it with its full question and says the
// decision bead could not be filed. recordDecisionAnswer refuses it.
//
// MIXED CASE (decided): the run pauses while ANY decision is pending, even if
// some other remaining bead is set aside for a non-decision reason (a doer
// BLOCKED, a set-aside deploy): answering the decision may unblock work. Only
// a stall with NO pending decision still throws StalledSprintError, exactly as
// before.
//
// THE WAIT parks the run ONCE through the engine's EXISTING cooperative pause
// (the requestPause/requestResume pair the usage-limit controller drives),
// with the typed source 'needs_decision', and then stays parked -- members
// reserved and idle -- until an answer is available or the operator stops:
//
//   requestPause(reason, { source: 'needs_decision' })  -- ONCE; state
//       'paused-awaiting-decision' (sprintState.decisionWait and the
//       'decisions' published state namespace)
//   issue ONE read of the pending decision beads (`bd show`), which blocks
//       at the engine's pause gate: it runs only once the run is released
//       (so it is never a per-poll command), and an operator stop rejects it
//   every poll interval (a non-blocking timer; woken at once by
//       recordDecisionAnswer) check ONLY the in-process answer queue -- no
//       command, no log line, no resume
//   an answer is queued: requestResume(...) ONCE -- the engine's pre-resume
//       hook runs as for any resume (the CLI skips its re-reserve/resync for
//       this pause, because it never handed the reservations back) -- the
//       blocked read runs, the queued answer is applied, and `bd comments` is
//       read for any other decision bead the read reports closed
//
// ANSWER SOURCES. (a) The in-process answer queue: recordDecisionAnswer /
// answerPendingDecision, which the run's own viewer action and the
// supervisor's POST /api/sprints/:id/decisions/:decisionId reach. It needs no
// member command, so it is the only thing a poll checks. (b) An operator
// running `bd human respond` elsewhere: there is NO member-free source for it
// -- the sprint's beads clone lives on a sprint member, and this process has
// no beads access of its own -- so it is NOT polled. It is picked up when the
// run is next released: by an in-process answer (the post-resume read reports
// every closed decision bead), or by an operator Resume (dashboard Resume /
// POST /sprints/:id/live/resume), which runs the blocked read, pulls the beads
// clone and reads once more when nothing is answered yet. A release with no
// answer logs ONE line and, after one poll interval (an answer or a stop ends
// it early), parks the run again -- never a tight loop. The pause log line
// tells the operator this.
//
// A decision bead CLOSED by `bd human respond` is an answer; its last
// "Response: ..." comment is the answer text (a bead closed some other way,
// e.g. `bd human dismiss`, counts as answered with no text). For each answer
// the work bead's notes gain the chosen answer (appended), the set-aside
// entries recorded for that decision (the bead and its blocks dependents) are
// cleared, the decision moves from sprintState.pendingDecisions to
// sprintState.answeredDecisions, and the run continues: the released bead
// re-enters through the ordinary ready set.
//
// POLL INTERVAL: DECISION_POLL_INTERVAL_MS_DEFAULT (60s), overridable with
// the APRA_FLEET_DECISION_POLL_MS environment variable (a positive integer, in
// milliseconds). Never a tight loop. Logging is one line per state change
// (paused, a failed resume -- once per distinct error --, released without an
// answer, resumed), never one per poll.
//
// IDLE TIMEOUT: the ~30 minute DEFAULT_IDLE_TIMEOUT_MS is the fleet server's
// cloud idle manager, which STOPS an idle cloud member's VM; it never aborts a
// sprint. The engine itself has no pause timeout, and this wait has no total
// budget of its own: a decision may take hours. Nothing touches the members
// while waiting, so a cloud member may be stopped as idle; the next dispatch
// to it restarts it transparently, as after a usage-limit pause.
//
// RESERVATIONS: unlike the usage-limit pause, the members stay reserved by
// this sprint for the whole wait: the CLI's 'paused' handler skips the
// hand-back when the pause source is 'needs_decision' (and its pre-resume
// hook then has nothing to re-acquire or resync), so no other sprint can take
// a member meanwhile. The sprint lock is held too: a paused run is running.
//
// STOP: an operator stop during the wait rejects at once with a CancelledError
// -- through the engine's stop signal (context.stopSignal()) and through the
// read blocked at the pause gate -- and it is propagated (never swallowed),
// so the run tears down immediately, with no further dispatch. The wait never
// re-parks a run whose stop signal has fired.
//
// recordDecisionAnswer(decisionId, answer) is the programmatic answer entry
// point (for a dashboard route). It answers through the SAME
// `bd human respond` command an operator runs, so the bead state is
// identical, then applies the answer exactly as a polled one. While the run is
// waiting it queues the answer for the wait (which is woken at once, resumes
// the run once and applies it); otherwise it runs it directly.
// =============================================================================

import { stageCommandBodyMemberSide } from './member-provisioning.mjs';
import { collectSetAsideEntries } from './set-aside.mjs';
import { removeStagedBody } from './decisions.mjs';
import { CancelledError } from '@apralabs/apra-fleet-workflow';

/** The run state while waiting (sprintState.decisionWait.state, published under 'decisions'). */
export const PAUSED_AWAITING_DECISION = 'paused-awaiting-decision';

/** requestPause's typed source for this pause. */
export const DECISION_PAUSE_SOURCE = 'needs_decision';

/** The published state namespace. */
export const DECISIONS_STATE_NAMESPACE = 'decisions';

export const DECISION_POLL_INTERVAL_MS_DEFAULT = 60_000;

// Every decision wait currently paused in this process. An in-process answer
// route (the sprint's own viewer/dashboard) finds the run to answer here.
const liveWaits = new Set();

// Every decision wait created in this process, so an in-process answer route
// can find the run owning a pending decision whether or not that run is
// currently paused (a decision may be pending while other beads still run).
// Pruned of idle entries on each creation so it cannot grow without bound.
const allWaits = new Set();

/**
 * Answers a pending decision through whichever run in this process owns it.
 * Same bead state as `bd human respond`; the run resumes without relaunch.
 * Throws when no run has that pending decision.
 * @param {string} decisionId
 * @param {string} answer
 * @returns {Promise<object>}
 */
export async function answerPendingDecision(decisionId, answer) {
    for (const w of allWaits) {
        if (w.pending().some((d) => d.decisionId === decisionId)) return w.recordDecisionAnswer(decisionId, answer);
    }
    throw new Error(`no pending decision ${JSON.stringify(decisionId)}`);
}

/** The pending decisions of every run in this process (full, untruncated). */
export function allPendingDecisions() {
    return [...allWaits].flatMap((w) => w.pending());
}

/**
 * The decision waits currently paused in this process: each exposes
 * pending() (the pending decision records) and recordDecisionAnswer().
 * @returns {Array<{ pending: () => object[], recordDecisionAnswer: (decisionId: string, answer: string) => Promise<object> }>}
 */
export function activeDecisionWaits() {
    return [...liveWaits];
}

/** The poll interval: APRA_FLEET_DECISION_POLL_MS when it is a positive integer, else the default. */
export function decisionPollIntervalMs(env = process.env) {
    const raw = env && env.APRA_FLEET_DECISION_POLL_MS;
    const n = Number(raw);
    return raw !== undefined && raw !== '' && Number.isInteger(n) && n > 0 ? n : DECISION_POLL_INTERVAL_MS_DEFAULT;
}

/**
 * The answer text from a decision bead's comments: the last comment written
 * by `bd human respond` ("Response: <text>"), else the last comment, else ''.
 * @param {Array<{ text?: string }>} comments
 * @returns {string}
 */
export function answerFromComments(comments) {
    const list = Array.isArray(comments) ? comments.filter((c) => c && typeof c.text === 'string') : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i].text.match(/^Response:\s*([\s\S]*)$/);
        if (m) return m[1].trim();
    }
    return list.length > 0 ? list[list.length - 1].text.trim() : '';
}

/**
 * The note appended to the work bead once its decision is answered.
 * @param {object} decision a pendingDecisions record
 * @param {string} answer
 * @param {string} via 'bd human respond' or 'recordDecisionAnswer'
 * @returns {string}
 */
export function formatDecisionAnswerNote(decision, answer, via) {
    return [
        `[fleet-sprint] OPERATOR DECISION on ${decision.beadId}` +
            (decision.decisionBeadId ? ` (decision bead ${decision.decisionBeadId}, via ${via})` : ` (via ${via})`),
        '',
        'Answer:',
        answer || '(closed without a response text)',
        '',
        'Question was:',
        decision.question,
        '',
        'Options were:',
        ...decision.options.map((o) => `(${o.id}) ${o.text}`),
        '',
        `Recommendation was: ${decision.recommendation}`,
        '',
        'Follow this answer when working the bead.',
    ].join('\n');
}

function parseJson(raw) {
    if (raw && typeof raw === 'object') return raw;
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const start = text.search(/[[{]/);
    return JSON.parse(start > 0 ? text.slice(start) : text);
}

/**
 * Builds the decision wait for one run.
 *
 * @param {object} deps
 * @param {object} deps.sprintState
 * @param {(reason: string, opts?: object) => (void|Promise<void>)} deps.requestPause
 * @param {(reason: string) => Promise<void>} deps.requestResume
 * @param {Function} deps.command the workflow command() seam
 * @param {string} deps.member the member whose beads clone the engine reads and writes
 * @param {(member: string) => Promise<any>} [deps.pullBeads] pull that clone before a poll read
 * @param {(member: string) => Promise<any>} [deps.pushBeads] push it after applying answers
 * @param {(namespace: string, data: object) => void} [deps.publishState]
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.pollIntervalMs]
 * @param {() => number} [deps.now]
 * @param {() => (AbortSignal|undefined)} [deps.stopSignal] the engine's run
 *   stop signal (context.stopSignal); without it a stop is seen only through
 *   the read blocked at the pause gate
 * @returns {{
 *   pending: () => object[],
 *   hasPending: () => boolean,
 *   awaitAnswer: (opts: { where: string, cycle?: number }) => Promise<object[]>,
 *   recordDecisionAnswer: (decisionId: string, answer: string) => Promise<object>,
 * }}
 */
export function createDecisionWait({
    sprintState,
    requestPause,
    requestResume,
    command,
    member,
    pullBeads = async () => {},
    pushBeads = async () => {},
    publishState = () => {},
    log = () => {},
    pollIntervalMs = decisionPollIntervalMs(),
    now = () => Date.now(),
    stopSignal = () => undefined,
}) {
    let waiting = false;
    let wake = null;
    const queued = new Map(); // decisionId -> { answer, resolve, reject }

    const pendingMap = () => (sprintState.pendingDecisions instanceof Map ? sprintState.pendingDecisions : new Map());
    const setAside = () => (sprintState.doctorBlockedIds instanceof Map ? sprintState.doctorBlockedIds : new Map());
    // Pending decisions whose bead is still set aside for them.
    const settingAside = () => [...pendingMap().values()].filter((d) => {
        const e = setAside().get(d.beadId);
        return e && e.decisionId === d.decisionId;
    });
    // A decision only holds the run while its bead is still set aside for it
    // AND it has a decision bead. One whose decision bead could not be filed
    // has no answer path (polling reads decision beads; bd human respond and
    // recordDecisionAnswer both respond on one), so waiting on it could never
    // end: it does not hold the run, and a stall on it throws
    // StalledSprintError naming it with its full question, as before.
    const holding = () => settingAside().filter((d) => d.decisionBeadId);

    const publish = (state) => {
        const pending = [...pendingMap().values()].map((d) => ({
            decisionId: d.decisionId, beadId: d.beadId, decisionBeadId: d.decisionBeadId,
            question: d.question, options: d.options, recommendation: d.recommendation,
            raisedBy: d.raisedBy, cycle: d.cycle, round: d.round, raisedAt: d.raisedAt || null,
            notification: d.notification || {},
        }));
        try {
            publishState(DECISIONS_STATE_NAMESPACE, {
                state, pending,
                waitingSince: sprintState.decisionWait ? sprintState.decisionWait.since : null,
                setAside: collectSetAsideEntries(sprintState),
            });
        } catch (err) {
            log(`decision wait: publishing state failed (non-fatal): ${err.message}`);
        }
    };

    // Applies one answer: note on the work bead, release of its set-aside,
    // bookkeeping. `respond` first runs `bd human respond` (programmatic path).
    const applyAnswer = async (decision, answer, { via, respond }) => {
        if (respond) {
            if (!decision.decisionBeadId) throw new Error(`decision ${decision.decisionId} has no decision bead to respond on`);
            const file = await stageCommandBodyMemberSide({
                command, member, content: answer, label: `Stage operator answer for ${decision.decisionBeadId}`,
            });
            try {
                await command(
                    `bd human respond ${decision.decisionBeadId} --file "${file}"`,
                    { member_name: member, silent: true, label: `Record operator answer on ${decision.decisionBeadId}` },
                );
            } finally {
                await removeStagedBody({ command, member, file, log });
            }
        }
        let noteFile = null;
        try {
            noteFile = await stageCommandBodyMemberSide({
                command, member, content: formatDecisionAnswerNote(decision, answer, via),
                label: `Stage decision answer note for ${decision.beadId}`,
            });
            await command(
                `bd note ${decision.beadId} --file "${noteFile}"`,
                { member_name: member, silent: true, label: `Append operator decision to ${decision.beadId} notes` },
            );
        } catch (err) {
            if (err && err.name === 'CancelledError') throw err;
            log(`decision ${decision.decisionId}: appending the answer to '${decision.beadId}' notes FAILED (non-fatal): ${err.message}`);
        }
        await removeStagedBody({ command, member, file: noteFile, log });
        const released = [];
        for (const [id, e] of [...setAside()]) {
            if (e && e.decisionId === decision.decisionId) {
                setAside().delete(id);
                released.push(id);
            }
        }
        pendingMap().delete(decision.decisionId);
        sprintState.answeredDecisions = sprintState.answeredDecisions instanceof Map ? sprintState.answeredDecisions : new Map();
        const record = { ...decision, answer, via, answeredAt: new Date(now()).toISOString(), released };
        sprintState.answeredDecisions.set(decision.decisionId, record);
        log(
            `Decision ${decision.decisionId} answered via ${via}: released [${released.join(', ')}] for dispatch; ` +
            `the answer is in ${decision.beadId}'s notes. Answer: ${answer || '(none)'}`,
        );
        return record;
    };

    // The ids one poll reads: each holding decision's decision bead (a
    // decision without one never holds the run, see holding()).
    const pollIds = (decisions) => [...new Set(decisions.map((d) => d.decisionBeadId).filter(Boolean))];

    const readBeads = async (ids, label) => {
        if (ids.length === 0) return [];
        const shown = parseJson(await command(
            `bd show ${ids.join(' ')} --json`,
            { member_name: member, silent: true, label },
        ));
        return Array.isArray(shown) ? shown : (shown ? [shown] : []);
    };

    // Which of `decisions` have a decision bead that `shown` reports closed
    // (answered), with the answer text from its comments.
    const closedAnswers = async (decisions, shown) => {
        const closed = new Set((shown || []).filter((b) => b && b.status === 'closed').map((b) => String(b.id)));
        const out = [];
        for (const d of decisions) {
            if (!d.decisionBeadId || !closed.has(d.decisionBeadId)) continue;
            let answer = '';
            try {
                const comments = parseJson(await command(
                    `bd comments ${d.decisionBeadId} --json`,
                    { member_name: member, silent: true, label: `Read the answer on ${d.decisionBeadId}` },
                ));
                answer = answerFromComments(comments);
            } catch (err) {
                if (err && err.name === 'CancelledError') throw err;
                log(`decision ${d.decisionId}: reading the response on ${d.decisionBeadId} failed (${err.message}); treating it as answered without text.`);
            }
            out.push({ decision: d, answer });
        }
        return out;
    };

    const drainQueued = async () => {
        const results = [];
        for (const [decisionId, q] of [...queued]) {
            queued.delete(decisionId);
            const decision = pendingMap().get(decisionId);
            if (!decision) { q.reject(new Error(`no pending decision ${decisionId}`)); continue; }
            try {
                const rec = await applyAnswer(decision, q.answer, { via: 'recordDecisionAnswer', respond: true });
                q.resolve(rec);
                results.push(rec);
            } catch (err) {
                q.reject(err);
                if (err && err.name === 'CancelledError') throw err;
            }
        }
        return results;
    };

    let api = null;

    const signalOf = () => {
        try { return stopSignal() || null; } catch { return null; }
    };
    const stopError = (signal) => (signal.reason instanceof Error
        ? signal.reason
        : new CancelledError(`[Workflow Error] ${signal.reason ? String(signal.reason) : 'run stopped'}`));
    const throwIfStopped = () => {
        const signal = signalOf();
        if (signal && signal.aborted) throw stopError(signal);
    };
    // Settles when `promise` does, or rejects at once on a stop.
    const untilStopped = (promise, cleanup = () => {}) => {
        const signal = signalOf();
        let onAbort = null;
        return new Promise((resolve, reject) => {
            if (signal) {
                onAbort = () => reject(stopError(signal));
                if (signal.aborted) { onAbort(); return; }
                signal.addEventListener('abort', onAbort, { once: true });
            }
            promise.then(resolve, reject);
        }).finally(() => {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            cleanup();
        });
    };

    // Parks the run ONCE and holds it parked -- no member command, no resume
    // -- until it is released. The one read is issued while the run is
    // paused, so it blocks at the engine's pause gate and only runs on
    // release. Each poll interval (and every recordDecisionAnswer wake)
    // checks only the in-process answer queue; a queued answer resumes the
    // run once. A failed resume (the pre-resume hook threw) keeps the run
    // parked and is retried on the next interval, logged once per distinct
    // error. Any other release (an operator Resume) also ends the hold.
    // Returns the read and whether this wait did the resume; rejects with a
    // CancelledError on a stop.
    const holdUntilReleased = async (reason, ids) => {
        throwIfStopped();
        await requestPause(reason, { source: DECISION_PAUSE_SOURCE });
        let selfResume = false;
        let resuming = false;
        let lastResumeError = null;
        let timer = null;
        const tryResume = () => {
            if (resuming || selfResume || queued.size === 0) return;
            const signal = signalOf();
            if (signal && signal.aborted) return;
            resuming = true;
            selfResume = true;
            Promise.resolve()
                .then(() => requestResume('an operator answer to a pending decision was recorded'))
                .then(() => { resuming = false; }, (err) => {
                    resuming = false;
                    selfResume = false;
                    const msg = err && err.message ? err.message : String(err);
                    if (msg !== lastResumeError) {
                        lastResumeError = msg;
                        log(`decision wait: resume failed, staying paused and retrying every ${Math.round(pollIntervalMs / 1000)}s while the answer is queued: ${msg}`);
                    }
                });
        };
        const tick = () => {
            tryResume();
            timer = setTimeout(tick, pollIntervalMs);
        };
        timer = setTimeout(tick, pollIntervalMs);
        wake = tryResume;
        const read = readBeads(ids, 'Read pending decisions once the run is released (waits at the pause gate)');
        read.catch(() => {}); // a stop rejects it; untilStopped reports that
        tryResume();
        const shown = await untilStopped(read, () => { clearTimeout(timer); wake = null; });
        return { shown, resumedBySelf: selfResume };
    };

    // One poll interval while the run is NOT parked (after a release with no
    // answer): ends early on a recordDecisionAnswer wake, rejects on a stop.
    const idleInterval = () => {
        let timer = null;
        const elapsed = new Promise((resolve) => {
            timer = setTimeout(resolve, pollIntervalMs);
            wake = resolve;
            if (queued.size > 0) resolve();
        });
        return untilStopped(elapsed, () => { clearTimeout(timer); wake = null; });
    };

    api = {
        /** Re-publishes the decisions namespace (e.g. after a new decision or a notification outcome). */
        publish() {
            publish(waiting ? PAUSED_AWAITING_DECISION : 'running');
        },

        pending() {
            return [...pendingMap().values()];
        },

        hasPending() {
            return holding().length > 0;
        },

        /**
         * Pending decisions still setting their bead aside whose decision
         * bead could NOT be filed: nothing can answer them in this run.
         */
        unfiled() {
            return settingAside().filter((d) => !d.decisionBeadId);
        },

        /**
         * Pauses until at least one pending decision is answered; returns the
         * applied answers. Throws whatever a resume or poll throws (an
         * operator stop's CancelledError included).
         */
        async awaitAnswer({ where, cycle = null } = {}) {
            const decisions = holding();
            if (decisions.length === 0) return [];
            waiting = true;
            sprintState.decisionWait = {
                state: PAUSED_AWAITING_DECISION, since: new Date(now()).toISOString(), where, cycle,
                decisionIds: decisions.map((d) => d.decisionId),
            };
            const names = decisions.map((d) => `${d.beadId} (${d.decisionBeadId || 'no decision bead'})`).join(', ');
            log(
                `Sprint ${PAUSED_AWAITING_DECISION} (${where}): nothing else can run until an operator answers ` +
                `${decisions.length} pending decision(s): ${names}. Members stay reserved and idle. Answer from the ` +
                `sprint dashboard's decision banner (resumes at once); an answer recorded elsewhere with ` +
                `bd human respond <decision bead> "<answer>" is picked up when the run is resumed (dashboard Resume).`,
            );
            publish(PAUSED_AWAITING_DECISION);
            liveWaits.add(api);
            let loggedRelease = false;
            try {
                for (;;) {
                    if (holding().length === 0 && queued.size === 0) return [];
                    const { shown, resumedBySelf } = await holdUntilReleased(`awaiting operator decision(s): ${names}`, pollIds(holding()));
                    const answered = await drainQueued();
                    let polled = await closedAnswers(holding(), shown);
                    if (answered.length === 0 && polled.length === 0 && holding().length > 0) {
                        // Released with nothing answered in the local clone:
                        // pull, then read once more (an operator may have
                        // answered elsewhere with bd human respond).
                        await pullBeads(member);
                        polled = await closedAnswers(holding(), await readBeads(pollIds(holding()), 'Read pending decisions after a beads pull'));
                    }
                    for (const { decision, answer } of polled) {
                        answered.push(await applyAnswer(decision, answer, { via: 'bd human respond', respond: false }));
                    }
                    if (answered.length > 0) {
                        await pushBeads(member);
                        log(`Sprint resumed (${where}): ${answered.length} decision(s) answered; the released bead(s) return to the ready pool.`);
                        return answered;
                    }
                    if (!loggedRelease) {
                        loggedRelease = true;
                        log(
                            `Sprint released from ${PAUSED_AWAITING_DECISION} (${where}) ${resumedBySelf ? 'after a failed answer' : 'by a resume'} ` +
                            `with no decision answered yet; parking it again after ${Math.round(pollIntervalMs / 1000)}s.`,
                        );
                    }
                    await idleInterval();
                }
            } finally {
                liveWaits.delete(api);
                waiting = false;
                wake = null;
                sprintState.decisionWait = null;
                publish('running');
            }
        },

        /**
         * Programmatic answer: same bead state as `bd human respond`.
         * @param {string} decisionId
         * @param {string} answer
         */
        async recordDecisionAnswer(decisionId, answer) {
            const decision = pendingMap().get(decisionId);
            if (!decision) throw new Error(`recordDecisionAnswer: no pending decision ${JSON.stringify(decisionId)}`);
            if (!decision.decisionBeadId) {
                throw new Error(
                    `recordDecisionAnswer: decision ${decisionId} on '${decision.beadId}' has no decision bead (filing it failed), ` +
                    'so there is no bd human respond path to record the answer on; the run cannot be resumed with it. ' +
                    `Record the decision in '${decision.beadId}' notes and re-run the sprint.`,
                );
            }
            const text = String(answer ?? '').trim();
            if (!text) throw new Error('recordDecisionAnswer: the answer is empty');
            if (!waiting) {
                const rec = await applyAnswer(decision, text, { via: 'recordDecisionAnswer', respond: true });
                await pushBeads(member);
                publish('running');
                return rec;
            }
            return new Promise((resolve, reject) => {
                queued.set(decisionId, { answer: text, resolve, reject });
                if (wake) wake();
            });
        },
    };
    for (const w of [...allWaits]) if (w.pending().length === 0) allWaits.delete(w);
    allWaits.add(api);
    return api;
}
