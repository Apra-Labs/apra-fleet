import Ajv from 'ajv';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { calculateCost } from './pricing.mjs';
import { WorkflowError, MemberNotFoundError, AgentOutputError, CommandError, FleetTransportError, BudgetExceededError, CancelledError } from './errors.mjs';
import { hashText, computeActivityKey } from './journal.mjs';

export { WorkflowError, MemberNotFoundError, AgentOutputError, CommandError, FleetTransportError, BudgetExceededError, CancelledError } from './errors.mjs';

const ajv = new Ajv({ strict: false });

// --- Per-run execution context (apra-fleet-unw.9, F11) --------------------
//
// Before this change, `FleetWorkflow` kept its "current run" state --
// `args`, `currentPhase`, `currentGroup`, `budget` -- as plain mutable
// instance fields. `WorkflowEngine.executeFile()` mutated `this.wf.args` on
// every call, and `phase()`/`group()` mutated a single shared
// `currentPhase`/`currentGroup`. That's fine for exactly one execution at a
// time, but breaks as soon as:
//   (a) two concurrent `executeFile()` calls run on the same `FleetWorkflow`
//       instance -- their `args` and phase attribution stomp on each other, or
//   (b) a single run's `parallel()` branches each call `phase()` with a
//       different value -- every branch (and every activity emitted from any
//       branch, including ones dispatched before the racing `phase()` call
//       resolves) ends up labeled with whichever branch's `phase()` call
//       happened to run last, not its own.
//
// `runStorage` (an AsyncLocalStorage) holds a small per-run store --
// `{ runId, args, phase, group, budget }` -- that is threaded automatically
// through the async call graph of a single `executeFile()` invocation:
//   - `WorkflowEngine.executeFile()` creates a fresh store via
//     `FleetWorkflow.runWithContext(args, entryFn)` and runs the whole script
//     inside `runStorage.run(store, ...)`. Every `agent()`/`command()`/
//     `phase()`/etc. call made anywhere inside that script -- including
//     across `await` boundaries -- automatically sees that run's store via
//     `runStorage.getStore()`, with no explicit threading required in the
//     workflow script itself.
//   - `parallel()` forks a *shallow copy* of the current store for each
//     branch before invoking its processor. `phase`/`group` are copied by
//     value, so a `phase()` call inside one branch only mutates that
//     branch's own copy and can never leak into a sibling branch or the
//     parent. `args`/`budget` are copied by reference, so budget spend is
//     still aggregated for the whole run and `args` stays consistent.
//   - Every activity/log/state event still carries the store's `runId`, so
//     even though the shared `EventEmitter` on `FleetWorkflow` fans events
//     out to a single global listener (the dashboard viewer subscribes
//     once), events from concurrent runs remain distinguishable.
//
// Direct, non-`executeFile()` usage (e.g. calling `wf.agent()`/`wf.phase()`
// straight off a `FleetWorkflow` instance, as several unit tests do) is
// preserved unchanged: when there is no active `runStorage` store (i.e.
// `runStorage.getStore()` returns `undefined`), every primitive falls back
// to the legacy instance-level fields (`this.args`, `this.currentPhase`,
// `this.currentGroup`, `this.budget`), exactly as before this change.
const runStorage = new AsyncLocalStorage();

// --- Structured-output extraction (apra-fleet-unw.8) ---------------------
//
// The old extraction path used a single greedy regex,
// /\{[\s\S]*\}|\[[\s\S]*\]/, which grabs from the FIRST `{`/`[` to the LAST
// `}`/`]` in the whole reply. That fails as soon as a reply contains more
// than one JSON block, or trailing prose that happens to contain a brace --
// the regex swallows everything in between as one "candidate" and JSON.parse
// then throws on it. The functions below replace that with real bracket
// matching plus schema-directed candidate selection: prefer fenced ```json
// blocks; otherwise scan the raw text for every balanced top-level
// {...}/[...] span (tracking string state so braces inside string literals
// don't confuse the matcher); validate each candidate against the schema in
// the order found and return the first one that both parses and validates.
//
// NOTE (descoped, see agent() below for the full note): this is a
// client-side mitigation. The more robust fix -- enforcing the schema at the
// member/harness tool-call layer -- requires fleet-server changes.

const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/gi;

/**
 * Extracts the contents of every fenced ```json (or bare ```) code block in
 * `text`, in the order they appear.
 * @param {string} text
 * @returns {string[]}
 */
function extractFencedJsonBlocks(text) {
    const blocks = [];
    let match;
    FENCED_JSON_RE.lastIndex = 0;
    while ((match = FENCED_JSON_RE.exec(text)) !== null) {
        blocks.push(match[1].trim());
    }
    return blocks;
}

/**
 * Given `text[start]` is `{` or `[`, scans forward tracking bracket nesting
 * and JSON string state (so braces/brackets inside string literals are
 * ignored) to find the index of the matching closing bracket. Returns -1 if
 * the span never closes or the brackets are mismatched.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function findBalancedEnd(text, start) {
    const closerFor = { '{': '}', '[': ']' };
    const stack = [closerFor[text[start]]];
    let inString = false;
    let escaped = false;

    for (let i = start + 1; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{' || ch === '[') {
            stack.push(closerFor[ch]);
            continue;
        }
        if (ch === '}' || ch === ']') {
            if (stack.length === 0) return -1;
            const expected = stack.pop();
            if (expected !== ch) return -1;
            if (stack.length === 0) return i;
        }
    }
    return -1;
}

/**
 * Scans `text` for every balanced top-level JSON object/array span, using
 * real bracket matching (not a greedy regex), in the order they appear.
 * @param {string} text
 * @returns {string[]}
 */
function extractBalancedJsonCandidates(text) {
    const candidates = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '{' || ch === '[') {
            const end = findBalancedEnd(text, i);
            if (end !== -1) {
                candidates.push(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        i++;
    }
    return candidates;
}

/**
 * Attempts to find a schema-valid JSON candidate in `text`. Prefers fenced
 * ```json blocks; falls back to a balanced top-level bracket scan of the raw
 * text. Every candidate found is parsed and validated in order; the first
 * one that both parses and validates against `compiledSchema` wins. Returns
 * `{ ok: true, parsed, raw }` on success, or `{ ok: false, attempts }` where
 * `attempts` records why every candidate was rejected (parse error or ajv
 * validation errors) for repair-prompt / error-reporting purposes.
 * @param {string} text
 * @param {import('ajv').ValidateFunction} compiledSchema
 */
function extractStructuredOutput(text, compiledSchema) {
    const fenced = extractFencedJsonBlocks(text);

    const attempts = [];
    const tryCandidate = (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (parseError) {
            attempts.push({ raw, parseError });
            return null;
        }
        if (compiledSchema(parsed)) {
            return { ok: true, parsed, raw };
        }
        attempts.push({ raw, parsed, validationErrors: compiledSchema.errors ? [...compiledSchema.errors] : [] });
        return null;
    };

    // Prefer fenced ```json blocks: try every fenced candidate first so the
    // common case (a well-behaved reply whose only JSON lives in a fenced
    // block) keeps picking the fenced block exactly as before.
    for (const raw of fenced) {
        const result = tryCandidate(raw);
        if (result) return result;
    }

    // Fall through to a balanced-bracket scan when no fenced candidate
    // parsed and validated -- either because there were no fenced blocks at
    // all, or because every fenced block was something else entirely (e.g.
    // a shell command the reply quotes for illustration) and the real
    // schema-satisfying JSON lives outside the fences. Scan the text with
    // the fenced spans blanked out so we don't re-try content already
    // rejected above, and so a stray brace inside a non-JSON fenced block
    // can't be mistaken for a balanced candidate.
    const unfencedText = text.replace(FENCED_JSON_RE, (match) => ' '.repeat(match.length));
    const balanced = extractBalancedJsonCandidates(unfencedText);
    for (const raw of balanced) {
        const result = tryCandidate(raw);
        if (result) return result;
    }

    // Last-resort fallback: no bracketed candidate was found at all (e.g. a
    // reply that is itself plain JSON with stray leading/trailing
    // whitespace but somehow no `{`/`[` was detected as an opener -- should
    // be rare given the scan above, but keeps behavior at least as good as
    // the old single-shot JSON.parse(text) path).
    if (fenced.length === 0 && balanced.length === 0) {
        const result = tryCandidate(text.trim());
        if (result) return result;
    }

    return { ok: false, attempts };
}

/**
 * Summarizes why every extraction attempt failed, for both the repair-prompt
 * re-ask and the final AgentOutputError message.
 * @param {Array<{raw: string, parseError?: Error, validationErrors?: object[]}>} attempts
 */
function summarizeExtractionAttempts(attempts) {
    if (attempts.length === 0) {
        return 'No JSON object or array was found in the response.';
    }
    return attempts
        .map((a, idx) => {
            if (a.parseError) {
                return `Candidate ${idx + 1}: JSON parse error: ${a.parseError.message}`;
            }
            return `Candidate ${idx + 1}: schema validation failed: ${ajv.errorsText(a.validationErrors)}`;
        })
        .join('\n');
}

/**
 * Builds the self-contained repair re-ask prompt sent to the SAME member
 * after an invalid structured-output attempt. Deliberately does NOT rely on
 * `resume: true` (see AgentOptions.resume / F10 note in agent() below) --
 * every field the member needs (the original prompt+schema, its own invalid
 * output, and the validation errors) is embedded directly in the prompt
 * text so the re-ask stands alone even in a fresh, non-resumed session.
 * @param {string} originalPrompt
 * @param {string} invalidOutput
 * @param {string} errorsText
 */
function buildRepairPrompt(originalPrompt, invalidOutput, errorsText) {
    return `${originalPrompt}\n\n` +
        `Your previous response could not be used:\n${invalidOutput}\n\n` +
        `Validation errors:\n${errorsText}\n\n` +
        `Please respond again with corrected JSON only, strictly conforming to the schema above. ` +
        `Do not include any commentary, explanation, or text outside the JSON.`;
}

/**
 * @typedef {Object} AgentOptions
 * @property {string} [label] - UI label for this run
 * @property {string} [phase] - Workflow phase grouping
 * @property {object} [schema] - JSON Schema for structured output. The dispatch-time
 *   `schema` passed here is the one actually ajv-validated against the member's
 *   response (see the compile/append/validate logic in agent() below) -- it is
 *   therefore authoritative at the member, per each persona's precedence clause
 *   ("if your dispatch prompt includes a JSON schema instruction, that schema is
 *   authoritative"). When `agentType` names a role that publishes its own output
 *   contract (apra-pm's role-owned schema design), callers MUST source this value
 *   from that role's published schema via their application-layer adapter (e.g.
 *   `contracts.mjs`'s `SCHEMAS.<name>` for auto-sprint) rather than authoring an
 *   independent, parallel definition here. Two independently-authored schemas for
 *   the same role is the double-specification hazard this single-source rule
 *   exists to prevent; the workflow layer itself stays generic and does not (and
 *   cannot) resolve or detect such drift -- see
 *   `docs/agent-schema-layering-proposal.md` (section 4, recommendation item 4;
 *   section 5.3) for the full rationale, and `docs/structured-errors-proposal.md`
 *   for the sibling design-doc pattern this cross-reference follows.
 * @property {string} [model] - Overrides model for this call
 * @property {string} [member_name] - Apra-fleet member to dispatch to
 * @property {string} [member_id] - Specific member UUID
 * @property {Record<string, string>} [substitutions] - Template substitutions for prompt
 * @property {number} [timeout_s] - Execution timeout
 * @property {number} [max_turns] - Max turns for conversational tools
 * @property {'low'|'medium'|'high'|'xhigh'|'max'} [effort] - Effort parameter for fleet routing
 * @property {string} [agentType] - Agent persona to activate on the member
 * @property {boolean} [resume] - Resume the previous session on the member if one exists.
 *   NOTE: the underlying ApraFleet client (packages/apra-fleet-client/src/client/api.mjs)
 *   defaults `resume` to `true` when omitted. The WORKFLOW layer overrides that: agent()
 *   explicitly sends `resume: false` unless the caller sets this option, so that
 *   workflow-authored prompts are self-contained by default and don't silently inherit
 *   state from a prior session. (F10 / apra-fleet-unw.3)
 * @property {number} [timeoutMs] - Client-side McpClient.request() timeout override (ms),
 *   passed through to ApraFleet.executePrompt. Not sent to the server. When omitted, a
 *   default is derived from timeout_s/max_total_s (see deriveTimeoutMs in
 *   packages/apra-fleet-client/src/client/api.mjs). (apra-fleet-unw.5)
 * @property {AbortSignal} [signal] - Optional AbortSignal, passed through to
 *   ApraFleet.executePrompt / McpClient.request. Aborting rejects the pending client-side
 *   wait for a response; it cannot cancel a job already accepted by the remote fleet-server.
 *   Groundwork for the cooperative-stop work in apra-fleet-unw.10 -- no /stop UI wiring here.
 *   (apra-fleet-unw.5)
 * @property {number} [schemaRetries] - Only meaningful when `schema` is set. Bounded number
 *   of repair re-asks to the SAME member after a parse/validation failure, before giving up
 *   and throwing AgentOutputError. Defaults to 2 (so up to 3 total dispatches: 1 original +
 *   2 repairs). Each repair re-ask is a fresh, self-contained prompt (does not rely on
 *   `resume: true`) containing the original prompt, the member's own invalid output, and the
 *   ajv validation/parse errors. Each attempt emits its own activity:start/activity:end pair
 *   and is cost-accounted individually. (apra-fleet-unw.8)
 */

/**
 * @typedef {Object} CommandOptions
 * @property {string} [label] - UI label for this run
 * @property {string} [phase] - Workflow phase grouping
 * @property {string} [member_name] - Apra-fleet member to dispatch to
 * @property {string} [member_id] - Specific member UUID
 * @property {Record<string, string>} [substitutions] - Template substitutions for command
 * @property {number} [timeout_s] - Execution timeout
 * @property {boolean} [long_running] - Run as background task
 * @property {number} [timeoutMs] - Client-side McpClient.request() timeout override (ms),
 *   passed through to ApraFleet.executeCommand. Not sent to the server. See AgentOptions
 *   .timeoutMs above for details. (apra-fleet-unw.5)
 * @property {AbortSignal} [signal] - Optional AbortSignal, passed through to
 *   ApraFleet.executeCommand / McpClient.request. See AgentOptions.signal above for details.
 *   (apra-fleet-unw.5)
 * @property {boolean} [failSoft] - When true, command() never throws for a
 *   command-level failure (CommandError / MemberNotFoundError /
 *   FleetTransportError); it instead resolves to
 *   `{ ok: boolean, output: string, error: string|null }`. A success also
 *   resolves to that shape (`{ ok: true, output: <text>, error: null }`)
 *   instead of the bare string, so callers don't have to branch on the
 *   return type. `CancelledError` (cooperative `requestStop()`) is never
 *   soft-caught -- it always throws, regardless of this option.
 *   (apra-fleet-unw.17)
 */

export class FleetWorkflow extends EventEmitter {
    /**
     * @param {import('../fleet-client/api.mjs').ApraFleet} fleetApi 
     * @param {any} args 
     */
    constructor(fleetApi, args = {}) {
        super();
        this.fleetApi = fleetApi;
        this.args = args;
        this.currentPhase = null;
        this.budget = {
            total: null,
            _spent: 0,
            spent: () => this.budget._spent,
            remaining: () => this.budget.total === null ? Infinity : (this.budget.total - this.budget._spent)
        };
        // (apra-fleet-unw.10) runId -> AbortController for every currently
        // active runWithContext() run. requestStop() aborts every entry in
        // this map; agent()/command() default to the current run's
        // controller.signal (via _currentSignal()) when the caller doesn't
        // pass its own opts.signal. See runWithContext()/requestStop() below.
        this._activeControllers = new Map();
    }

    // Returns the active per-run store (see runStorage above), or
    // `undefined` when called outside of `WorkflowEngine.executeFile()` /
    // `runWithContext()` -- e.g. direct `wf.method()` calls in unit tests.
    _store() {
        return runStorage.getStore();
    }

    // Effective phase: the current run's store.phase if one is active,
    // otherwise the legacy instance-level `this.currentPhase`.
    _currentPhase() {
        const store = this._store();
        return store ? store.phase : this.currentPhase;
    }

    _currentGroup() {
        const store = this._store();
        return store ? store.group : this.currentGroup;
    }

    _currentArgs() {
        const store = this._store();
        return store ? store.args : this.args;
    }

    _currentBudget() {
        const store = this._store();
        return store ? store.budget : this.budget;
    }

    _currentRunId() {
        const store = this._store();
        return store ? store.runId : null;
    }

    // The active run's cooperative-cancellation AbortSignal (apra-fleet-
    // unw.10), or `undefined` outside of a runWithContext() run / when the
    // run's controller has no signal for some reason. agent()/command()
    // fall back to this when the caller doesn't pass its own opts.signal.
    _currentSignal() {
        const store = this._store();
        return store ? store.signal : undefined;
    }

    /**
     * Cooperatively requests cancellation of every currently active run
     * (every `runWithContext()` invocation -- i.e. every in-flight
     * `WorkflowEngine.executeFile()` call -- on this `FleetWorkflow`
     * instance). Aborts each run's `AbortController`, which rejects any
     * in-flight `agent()`/`command()` dispatch that is using that run's
     * signal (either implicitly, via `_currentSignal()`, or because the
     * script never overrode `opts.signal`) with a client-side `AbortError`;
     * `agent()`/`command()` re-wrap that as a typed `CancelledError` (see
     * errors.mjs) so the run unwinds as a cancellation failure rather than a
     * generic transport error.
     *
     * This is the mechanism the dashboard viewer's `/stop` endpoint uses
     * (packages/apra-fleet-workflow/src/viewer/index.mjs) instead of the old
     * `process.exit(1)` -- no state flush, mid-dispatch agents orphaned.
     *
     * NOTE: local/client-side cancellation only. A remote fleet member that
     * already accepted a job may keep running to completion even after this
     * run unwinds -- true server-side cancellation would require changes to
     * the external apra-fleet MCP server and is out of scope here.
     *
     * @param {string} [reason]
     */
    requestStop(reason = 'Workflow run cancelled via requestStop()') {
        for (const controller of this._activeControllers.values()) {
            controller.abort(new CancelledError(`[Workflow Error] ${reason}`));
        }
    }

    log(msg) {
        console.log(`[Workflow Log] ${msg}`);
        this.emit('log', { phase: this._currentPhase(), msg, runId: this._currentRunId() });
    }

    group(title) {
        const store = this._store();
        if (store) {
            store.group = title;
        } else {
            this.currentGroup = title;
        }
        console.log(`\n=== Group: ${title} ===`);
        this.emit('group:start', { title, runId: this._currentRunId() });
    }

    endGroup() {
        this.emit('group:end', { title: this._currentGroup(), runId: this._currentRunId() });
        const store = this._store();
        if (store) {
            store.group = null;
        } else {
            this.currentGroup = null;
        }
    }

    // NOTE: `title` set inside a `parallel()` branch only mutates that
    // branch's own forked store copy (see `parallel()` below and the
    // runStorage comment above this class) -- it never leaks to sibling
    // branches or the parent run.
    phase(title) {
        const store = this._store();
        if (store) {
            store.phase = title;
        } else {
            this.currentPhase = title;
        }
        console.log(`--- Phase: ${title} ---`);
        // Event payload deliberately kept as the bare `title` string (not an
        // object) -- the dashboard viewer subscribes to this event and
        // single-run rendering must stay byte-identical (apra-fleet-unw.9
        // acceptance criteria #3). Concurrent-run disambiguation is carried
        // on activity/log/state events instead, which already have an
        // object payload.
        this.emit('phase', title);
    }


    publishState(namespace, data) {
        this.emit('state', { namespace, data, phase: this._currentPhase(), runId: this._currentRunId() });
    }

    /**
     * @param {string} prompt 
     * @param {AgentOptions} [opts] 
     */
    async agent(prompt, opts = {}) {
        if (!opts.member_name && !opts.member_id) {
            throw new Error(`[Workflow Error] agent() requires either member_name or member_id`);
        }

        const effectivePhase = opts.phase || this._currentPhase();
        const runId = this._currentRunId();
        if (effectivePhase) {
            console.log(`[Dispatch] phase: ${effectivePhase} | member: ${opts.member_name || opts.member_id} | label: ${opts.label || 'none'}`);
        }

        let compiledSchema = null;
        if (opts.schema) {
            try {
                compiledSchema = ajv.compile(opts.schema);
            } catch (err) {
                throw new Error(`[Workflow Error] Invalid JSON Schema provided to agent(): ${err.message}`);
            }
        }

        const initialPrompt = opts.schema
            ? `${prompt}\n\nOnly provide your response strictly as per this JSON schema:\n${JSON.stringify(opts.schema, null, 2)}`
            : prompt;

        // Bounded schema-repair loop (apra-fleet-unw.8, F5). Non-schema
        // calls always run exactly one iteration (maxRepairs = 0). For
        // schema calls, a parse/validation failure re-dispatches to the SAME
        // member with a self-contained repair prompt (see buildRepairPrompt
        // above) instead of hard-throwing on the first bad reply -- one
        // malformed JSON reply used to kill a whole multi-cycle sprint.
        //
        // DESCOPED: the more robust fix is enforcing the schema at the
        // member/harness tool-call layer (e.g. a Claude-CLI-style structured
        // tool call) so the member literally cannot emit non-conforming
        // output. That requires fleet-server changes and is out of scope
        // here; this client-side repair loop is the best available
        // mitigation until that lands.
        const maxRepairs = opts.schema ? (opts.schemaRetries ?? 2) : 0;

        let currentPrompt = initialPrompt;
        let lastActivityMeta = null;
        const budget = this._currentBudget();

        // (apra-fleet-unw.11, F6) Journal replay. `replayKey` is computed
        // ONCE per logical agent() call (not per schema-repair attempt) from
        // this run's monotonic activity sequence counter + call type +
        // member + a hash of the fully-resolved initial prompt (including
        // any appended schema instructions), so it's stable across repair
        // attempts and deterministic across an uninterrupted-vs-resumed run
        // of the SAME script with the SAME args. `store.activitySeq` is only
        // non-null when the caller opted into journaling at all (see
        // runWithContext()); a normal call with no journal/resumeJournal
        // option never enters this block and never attaches
        // sequence/replayKey to its activity events, so behavior/output are
        // unchanged from before this feature existed.
        const store = this._store();
        let sequence = null;
        let replayKey = null;
        if (store && store.activitySeq) {
            // (apra-fleet-unw2.14, N6) `sequence` is numeric at the top level
            // and a hierarchical, scheduler-independent string inside a
            // parallel() branch -- see _nextSequence()/parallel().
            sequence = this._nextSequence(store);
            replayKey = computeActivityKey({
                sequence,
                type: 'agent',
                member: opts.member_name || opts.member_id,
                textHash: hashText(initialPrompt)
            });
        }

        const replay = store && store.replay;
        if (replay && !replay.diverged && replayKey) {
            const cached = replay.completedByKey.get(replayKey);
            if (cached && cached.success) {
                // Cache hit: return the journaled result WITHOUT dispatching
                // to the fleet at all. Still emit activity:start/activity:end
                // (marked `replayed: true`) so a listening dashboard/journal
                // writer sees this step as part of the run.
                const cachedActivityMeta = {
                    id: randomUUID(),
                    type: 'agent',
                    phase: effectivePhase,
                    runId,
                    label: (opts.label || prompt.split('\n')[0].substring(0, 50) + (prompt.length > 50 ? '...' : '')),
                    member: opts.member_name || opts.member_id,
                    model: opts.model || 'default',
                    repairAttempt: 0,
                    startTime: Date.now(),
                    sequence,
                    replayKey,
                    replayed: true
                };
                this.emit('activity:start', cachedActivityMeta);
                // (apra-fleet-unw2.14, N18) INTENTIONAL: a replayed agent
                // activity re-debits the run's budget using the journaled
                // (cached) cost of the ORIGINAL dispatch. This is
                // "total-spend-view" semantics: `budget.spent()` on a resumed
                // run reflects the cumulative real cost of the whole logical
                // run (original + resumed portions), NOT just what the resumed
                // process dispatched live. That is deliberate -- a resume is a
                // continuation of one run, and its budget ceiling must still
                // account for money already spent before the crash, otherwise
                // a run that crashed near its budget limit could resume and
                // massively overspend. It is NOT the "fresh run starts at $0"
                // model some callers might naively assume; that expectation is
                // explicitly wrong here. (See the resumed-budget test in
                // apra-fleet-workflow-journal.test.mjs.)
                if (typeof cached.cost === 'number') {
                    budget._spent += cached.cost;
                }
                const cachedOutput = opts.schema ? JSON.parse(cached.output) : cached.output;
                this.emit('activity:end', {
                    ...cachedActivityMeta,
                    duration: 0,
                    success: true,
                    usage: cached.usage ?? null,
                    cost: cached.cost ?? null,
                    output: cached.output,
                    replayed: true
                });
                return cachedOutput;
            }
            // First mismatch or first missing entry for this run: stop
            // replay and switch to live execution from here onward (partial
            // replay, not all-or-nothing).
            replay.diverged = true;
            const inParallel = !!(store && store.seqPrefix);
            console.warn(this._divergenceWarning({ sequence, type: 'agent', member: opts.member_name || opts.member_id, inParallel }));
            this.emit('journal:diverged', { runId, sequence, type: 'agent', replayKey, inParallel });
        }

        for (let attempt = 0; attempt <= maxRepairs; attempt++) {
            if (budget.total !== null && budget.remaining() <= 0) {
                throw new BudgetExceededError(
                    `[Workflow Error] Budget exceeded: spent $${budget._spent.toFixed(4)} of $${budget.total.toFixed(4)} total. Aborting agent() dispatch.`,
                    { details: { spent: budget._spent, total: budget.total, member: opts.member_name || opts.member_id } }
                );
            }

            const isRepair = attempt > 0;
            const activityMeta = {
                id: randomUUID(),
                type: 'agent',
                phase: effectivePhase,
                runId,
                label: (opts.label || prompt.split('\n')[0].substring(0, 50) + (prompt.length > 50 ? '...' : ''))
                    + (isRepair ? ` [schema repair ${attempt}/${maxRepairs}]` : ''),
                member: opts.member_name || opts.member_id,
                model: opts.model || 'default',
                repairAttempt: attempt,
                startTime: Date.now(),
                ...(replayKey !== null ? { sequence, replayKey } : {})
            };
            lastActivityMeta = activityMeta;
            this.emit('activity:start', activityMeta);

            const payload = {
                prompt: currentPrompt,
                model: opts.model,
                member_name: opts.member_name,
                member_id: opts.member_id,
                substitutions: opts.substitutions,
                timeout_s: opts.timeout_s,
                max_turns: opts.max_turns,
                effort: opts.effort,
                agent: opts.agentType,
                // F10: default to a self-contained (non-resumed) session for
                // workflow-authored prompts, including every repair re-ask --
                // buildRepairPrompt() embeds the original prompt + invalid
                // output + errors directly, so it never depends on
                // resume:true to carry context forward. See AgentOptions
                // .resume above and apra-fleet-unw.3.
                resume: opts.resume ?? false,
                // apra-fleet-unw.5: opts pass-through only, no control-flow change here.
                timeoutMs: opts.timeoutMs,
                // apra-fleet-unw.10: defaults to the active run's cooperative
                // -cancellation signal (set up by runWithContext()/
                // requestStop()) when the caller doesn't supply its own.
                signal: opts.signal ?? this._currentSignal()
            };

            try {
                const result = await this.fleetApi.executePrompt(payload);

                // apra-fleet-unw.4: never fabricate usage. If the fleet result
                // didn't report real token usage, both usage and cost are
                // explicitly null -- the viewer renders "n/a" and excludes the
                // activity from cost totals rather than showing fiction. This
                // applies per-attempt: every repair dispatch is accounted
                // individually, exactly like the original attempt.
                const hasRealUsage = !!(result.usage && typeof result.usage.total_tokens === 'number');
                if (!hasRealUsage) {
                    result.usage = null;
                }

                const cost = hasRealUsage ? calculateCost(opts.model, result.usage) : null;
                if (cost !== null) {
                    budget._spent += cost;
                }
                const duration = Date.now() - activityMeta.startTime;

                if (result && result.content && result.content.length > 0) {
                    const text = result.content[0].text;

                    // STOPGAP: the apra-fleet MCP server currently reports a
                    // missing member as a normal-looking success payload whose
                    // text happens to match this pattern, instead of a
                    // structured error (see docs/structured-errors-proposal.md).
                    // Until the server ships Option 1 (JSON-RPC error) or
                    // Option 2 (isError payload), this string-sniff is the only
                    // classifier available; keep it, but always surface it as a
                    // typed error rather than a silent `null` return. A missing
                    // member is not a schema problem, so it is never retried
                    // through the repair loop.
                    if (text.startsWith('Member "') && text.includes('" not found.')) {
                        console.error(`[Agent API Error]`, text);
                        this.emit('activity:end', { ...activityMeta, error: text, duration, success: false });
                        throw new MemberNotFoundError(`[Workflow Error] ${text}`, { details: { text, member: opts.member_name || opts.member_id } });
                    }

                    if (!opts.schema) {
                        this.emit('activity:end', { ...activityMeta, duration, success: true, usage: result.usage, cost, output: text });
                        return text;
                    }

                    const extraction = extractStructuredOutput(text, compiledSchema);
                    if (extraction.ok) {
                        this.emit('activity:end', { ...activityMeta, duration, success: true, usage: result.usage, cost, output: JSON.stringify(extraction.parsed, null, 2) });
                        return extraction.parsed;
                    }

                    const errorsText = summarizeExtractionAttempts(extraction.attempts);

                    if (attempt < maxRepairs) {
                        // Bounded repair: re-dispatch to the SAME member with
                        // a fresh, self-contained prompt (original prompt +
                        // invalid output + ajv errors). This attempt is still
                        // recorded as its own activity:end (success: false)
                        // so the journal/dashboard show it as a distinct step
                        // before the repair attempt that follows.
                        this.emit('activity:end', { ...activityMeta, error: `Schema-invalid output, retrying (repair ${attempt + 1}/${maxRepairs}): ${errorsText}`, output: text, duration, usage: result.usage, cost, success: false });
                        currentPrompt = buildRepairPrompt(initialPrompt, text, errorsText);
                        continue;
                    }

                    // Repairs exhausted -- surface a typed AgentOutputError.
                    // Classify the message the same way the old single-shot
                    // code did (parseable-JSON vs schema-compliance failure)
                    // based on the final attempt, so existing callers keyed
                    // off either phrase keep working.
                    const allUnparseable = extraction.attempts.length === 0 || extraction.attempts.every((a) => a.parseError);
                    const attemptCount = attempt + 1;
                    const message = allUnparseable
                        ? `[Workflow Error] LLM failed to return parseable JSON for structured output after ${attemptCount} attempt(s) (${maxRepairs} repair(s) exhausted).`
                        : `[Workflow Error] LLM returned non-compliant JSON. Validation failed after ${attemptCount} attempt(s) (${maxRepairs} repair(s) exhausted): ${errorsText}`;
                    const validationErrors = extraction.attempts
                        .filter((a) => a.validationErrors)
                        .flatMap((a) => a.validationErrors);
                    // Preserve the underlying JSON.parse error on `.cause`
                    // when the final attempt was unparseable, matching the
                    // original single-shot contract that callers can inspect
                    // `.cause` for the raw parse failure.
                    const lastParseError = [...extraction.attempts].reverse().find((a) => a.parseError)?.parseError;

                    const err = new AgentOutputError(message, {
                        details: {
                            text,
                            attempts: attemptCount,
                            repairs: maxRepairs,
                            errorsText,
                            validationErrors: validationErrors.length > 0 ? validationErrors : undefined
                        },
                        cause: lastParseError
                    });
                    this.emit('activity:end', { ...activityMeta, error: err.message, output: text, duration, usage: result.usage, cost, success: false });
                    throw err;
                }

                this.emit('activity:end', { ...activityMeta, duration, success: false });
                throw new AgentOutputError(`[Workflow Error] agent() received an empty content response from the fleet API.`, { details: { result } });
            } catch (error) {
                console.error(`[Agent API Error]`, error.message || error);
                if (error instanceof WorkflowError) {
                    // activity:end for typed errors was already emitted at
                    // the throw site above (with the richer, attempt-scoped
                    // metadata); don't double-emit here.
                    throw error;
                }
                const duration = Date.now() - activityMeta.startTime;
                // apra-fleet-unw.10: a client-side AbortError (.code ===
                // 'ABORTED', from McpClient.request() reacting to the
                // signal above) means this dispatch was cooperatively
                // cancelled via requestStop() -- surface it as a typed
                // CancelledError, not a generic transport failure.
                if (error && error.code === 'ABORTED') {
                    const cancelErr = new CancelledError(`[Workflow Error] agent() dispatch cancelled: ${error.message || error}`, { details: { payload }, cause: error });
                    this.emit('activity:end', { ...activityMeta, error: cancelErr.message, duration, success: false, cancelled: true });
                    throw cancelErr;
                }
                this.emit('activity:end', { ...activityMeta, error: error.message || error, duration, success: false });
                throw new FleetTransportError(`[Workflow Error] Transport failure while executing agent prompt: ${error.message || error}`, { details: { payload }, cause: error });
            }
        }

        // Unreachable: the loop above always returns or throws. Kept as a
        // defensive guard in case maxRepairs computation is ever negative.
        throw new AgentOutputError(`[Workflow Error] agent() exhausted its dispatch loop without a result.`, { details: { activity: lastActivityMeta } });
    }

    /**
     * @param {string} cmd
     * @param {CommandOptions} [opts]
     */
    async command(cmd, opts = {}) {
        // (apra-fleet-unw.17, A4) `opts.failSoft`: when set, a command
        // failure that would otherwise throw (a well-formed `isError`
        // result -> CommandError, a "Member not found" text sniff ->
        // MemberNotFoundError, or a transport-level rejection ->
        // FleetTransportError) is instead returned to the caller as
        // `{ ok: false, output: '', error: <message> }` -- and a success is
        // returned as `{ ok: true, output: <text>, error: null }` instead of
        // the bare string. This exists for callers like runner.js's
        // deploy.md/integ-test-playbook.md file-existence probes, which must
        // never let a transient/portability probe failure (e.g. a
        // node-not-on-PATH quirk on some member) kill the whole sprint --
        // the probe is best-effort; a failure just means "treat as not
        // found" (skip the dependent phase), not "abort everything".
        // Deliberately does NOT catch CancelledError (cooperative
        // requestStop() cancellation must still unwind the run even for a
        // failSoft caller -- swallowing that would defeat requestStop()).
        const failSoft = !!opts.failSoft;
        const softFail = (err) => {
            if (err instanceof CancelledError) throw err;
            if (!failSoft) throw err;
            return { ok: false, output: '', error: err.message };
        };
        if (!opts.member_name && !opts.member_id) {
            throw new Error(`[Workflow Error] command() requires either member_name or member_id`);
        }

        const effectivePhase = opts.phase || this._currentPhase();
        const runId = this._currentRunId();
        if (!opts.silent) {
            console.log(`[Command] phase: ${effectivePhase} | member: ${opts.member_name || opts.member_id} | label: ${opts.label || 'none'}`);
        }

        let finalCmd = cmd;
        if (opts.substitutions) {
            for (const [key, value] of Object.entries(opts.substitutions)) {
                finalCmd = finalCmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
            }
        }

        // (apra-fleet-unw.11, F6) Journal replay -- see the matching, more
        // detailed comment in agent() above. `command()`'s activity events
        // already carry the raw, substituted command text (the `command`
        // field above), so the replay key hashes that same text rather than
        // requiring a second copy.
        const store = this._store();
        let sequence = null;
        let replayKey = null;
        if (store && store.activitySeq) {
            // (apra-fleet-unw2.14, N6) See agent()/_nextSequence(): numeric at
            // the top level, hierarchical/order-independent inside parallel().
            sequence = this._nextSequence(store);
            replayKey = computeActivityKey({
                sequence,
                type: 'command',
                member: opts.member_name || opts.member_id,
                textHash: hashText(finalCmd)
            });
        }

        const replay = store && store.replay;
        if (replay && !replay.diverged && replayKey) {
            const cached = replay.completedByKey.get(replayKey);
            if (cached && cached.success) {
                // apra-fleet-unw2.13 (N5): reconstruct the shape the CURRENT
                // call would have gotten live -- a failSoft caller expects
                // `{ ok, output, error }`, a plain caller expects the raw
                // string. `cached.failSoft` is read from the journaled
                // `activity:end` record (see the `failSoft` field added to
                // `activityMeta` below), which reflects how the ORIGINAL run
                // shaped this same call. Since a resumed run replays the
                // same script in the same order with the same opts, this
                // should always agree with the current call's `failSoft`.
                //
                // OLD-FORMAT journals (written before this fix) have no
                // `failSoft` field at all -- `cached.failSoft` is then
                // `undefined`, and we cannot know how the original call was
                // shaped. We fall back to the pre-fix behavior of returning
                // the raw string (best-effort; a failSoft caller resuming
                // from an old journal will see `res.ok === undefined` exactly
                // as it did before this fix, until the journal is
                // regenerated by a fresh, non-resumed run).
                const cachedFailSoft = !!cached.failSoft;
                const cachedActivityMeta = {
                    id: randomUUID(),
                    type: 'command',
                    phase: effectivePhase,
                    runId,
                    label: opts.label || finalCmd.substring(0, 60),
                    member: opts.member_name || opts.member_id,
                    command: finalCmd,
                    startTime: Date.now(),
                    sequence,
                    replayKey,
                    replayed: true,
                    failSoft: cachedFailSoft
                };
                this.emit('activity:start', cachedActivityMeta);
                this.emit('activity:end', {
                    ...cachedActivityMeta,
                    duration: 0,
                    success: true,
                    output: cached.output,
                    replayed: true
                });
                return cachedFailSoft ? { ok: true, output: cached.output, error: null } : cached.output;
            }
            replay.diverged = true;
            const inParallel = !!(store && store.seqPrefix);
            console.warn(this._divergenceWarning({ sequence, type: 'command', member: opts.member_name || opts.member_id, inParallel }));
            this.emit('journal:diverged', { runId, sequence, type: 'command', replayKey, inParallel });
        }

        const activityMeta = {
            id: randomUUID(),
            type: 'command',
            phase: effectivePhase,
            runId,
            label: opts.label || finalCmd.substring(0, 60),
            member: opts.member_name || opts.member_id,
            command: finalCmd,
            startTime: Date.now(),
            // apra-fleet-unw2.13 (N5): journal the failSoft flag as part of
            // every activity:start/activity:end record for this call, so a
            // FUTURE resume of this journal can reconstruct the right return
            // shape from `cached.failSoft` above, instead of unconditionally
            // returning the raw string regardless of how the original call
            // was made.
            failSoft,
            ...(replayKey !== null ? { sequence, replayKey } : {})
        };
        this.emit('activity:start', activityMeta);

        const payload = {
            command: finalCmd,
            member_name: opts.member_name,
            member_id: opts.member_id,
            timeout_s: opts.timeout_s,
            long_running: opts.long_running,
            // apra-fleet-unw.5: opts pass-through only, no control-flow change here.
            timeoutMs: opts.timeoutMs,
            // apra-fleet-unw.10: see the matching comment in agent() above.
            signal: opts.signal ?? this._currentSignal()
        };

        try {
            const result = await this.fleetApi.executeCommand(payload);
            const outText = result.content && result.content.length > 0 ? result.content[0].text : '';
            const duration = Date.now() - activityMeta.startTime;

            // STOPGAP: see the matching comment in agent() above and
            // docs/structured-errors-proposal.md -- the server currently
            // signals a missing member via plain response text rather than a
            // structured error. Surface it as a typed error, never `null`.
            if (outText.startsWith('Member "') && outText.includes('" not found.')) {
                console.error(`[Command API Error]`, outText);
                this.emit('activity:end', { ...activityMeta, error: outText, duration, success: false });
                throw new MemberNotFoundError(`[Workflow Error] ${outText}`, { details: { text: outText, member: opts.member_name || opts.member_id } });
            }

            if (result.isError) {
                const err = new CommandError(`[Command Failed] ${outText}`, { details: { text: outText, command: finalCmd } });
                this.emit('activity:end', { ...activityMeta, error: err.message, duration, success: false });
                throw err;
            }

            this.emit('activity:end', { ...activityMeta, duration, success: true, output: outText });
            return failSoft ? { ok: true, output: outText, error: null } : outText;
        } catch (error) {
            console.error(`[Command API Error]`, error.message || error);
            if (error instanceof WorkflowError) {
                // activity:end for typed errors was already emitted at the
                // throw site above (see the matching comment in agent()'s
                // catch); don't double-emit here.
                return softFail(error);
            }
            const duration = Date.now() - activityMeta.startTime;
            // apra-fleet-unw.10: see the matching comment in agent() above.
            if (error && error.code === 'ABORTED') {
                const cancelErr = new CancelledError(`[Workflow Error] command() dispatch cancelled: ${error.message || error}`, { details: { payload }, cause: error });
                this.emit('activity:end', { ...activityMeta, error: cancelErr.message, duration, success: false, cancelled: true });
                throw cancelErr;
            }
            this.emit('activity:end', { ...activityMeta, error: error.message || error, duration, success: false });
            return softFail(new FleetTransportError(`[Workflow Error] Transport failure while executing command: ${error.message || error}`, { details: { payload }, cause: error }));
        }
    }

    /**
     * Executes the given async processor function for each item sequentially.
     *
     * `sequential(items, processor, opts)` is the single-processor primitive:
     * exactly one `processor(item, index, items)` function is applied to every
     * item, in order. It does NOT accept a variadic list of per-stage
     * processors -- that old `sequential(items, ...stages)` form silently
     * dropped every stage after the first (F7). Extra positional arguments
     * now throw a TypeError instead of being swallowed. For a genuine
     * multi-stage pipeline where each stage's output feeds the next, use
     * `pipeline(items, ...stages)`.
     */
    async sequential(items, processor, opts = {}, ...rest) {
        if (rest.length > 0) {
            throw new TypeError(
                `sequential(items, processor, opts) accepts at most 3 arguments, got ${3 + rest.length}. ` +
                `sequential() no longer accepts a variadic list of per-stage processors -- use pipeline(items, ...stages) for multi-stage flows.`
            );
        }
        if (typeof processor !== 'function') {
            throw new TypeError(
                `sequential(items, processor, opts): the 2nd argument must be a single processor function, got ${processor === null ? 'null' : typeof processor}. ` +
                `The old sequential(items, ...stages) multi-stage form is no longer supported -- use pipeline(items, ...stages) instead.`
            );
        }
        if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
            throw new TypeError(`sequential(items, processor, opts): the 3rd argument must be a plain options object, got ${opts === null ? 'null' : typeof opts}.`);
        }

        const results = [];
        for (let i = 0; i < items.length; i++) {
            try {
                const res = await processor(items[i], i, items);
                results.push(res);
            } catch (err) {
                this.log(`[Sequential Error] item ${i} failed at a stage: ${err.message}`);
                if (!opts.continueOnError) {
                    // Fail-fast: rethrow without discarding results already
                    // collected for prior items. Attach them to the error so
                    // callers can recover partial progress.
                    err.partialResults = results.slice();
                    throw err;
                }
                results.push(null);
            }
        }
        return results;
    }

    /**
     * Executes a chain of stage functions for each item, sequentially, where
     * each stage receives the previous stage's result for that item (the
     * first stage receives the raw item). This is the documented multi-stage
     * form that `sequential(items, ...stages)` used to provide before it was
     * narrowed to a single-processor primitive (see `sequential()` above).
     *
     * Failure semantics mirror `sequential()`: by default a stage error
     * aborts the whole pipeline run and rethrows with `err.partialResults`
     * populated; pass `{ continueOnError: true }` as a trailing plain-object
     * argument to instead record `null` for the failed item and continue
     * with the rest.
     */
    async pipeline(items, ...stagesAndOpts) {
        let opts = {};
        let stages = stagesAndOpts;
        if (stagesAndOpts.length > 0 && typeof stagesAndOpts[stagesAndOpts.length - 1] !== 'function') {
            opts = stagesAndOpts[stagesAndOpts.length - 1];
            stages = stagesAndOpts.slice(0, -1);
            if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
                throw new TypeError(`pipeline(items, ...stages, [opts]): the trailing non-function argument must be a plain options object, got ${opts === null ? 'null' : typeof opts}.`);
            }
        }
        if (stages.length === 0) {
            throw new TypeError('pipeline(items, ...stages): at least one stage function is required.');
        }
        stages.forEach((stage, idx) => {
            if (typeof stage !== 'function') {
                throw new TypeError(`pipeline(items, ...stages): stage ${idx + 1} must be a function, got ${stage === null ? 'null' : typeof stage}.`);
            }
        });

        const results = [];
        for (let i = 0; i < items.length; i++) {
            try {
                let value = items[i];
                for (const stage of stages) {
                    value = await stage(value, i, items);
                }
                results.push(value);
            } catch (err) {
                this.log(`[Pipeline Error] item ${i} failed at a stage: ${err.message}`);
                if (!opts.continueOnError) {
                    err.partialResults = results.slice();
                    throw err;
                }
                results.push(null);
            }
        }
        return results;
    }

    /**
     * Executes the given async processor function for each item in parallel.
     *
     * (apra-fleet-unw.9, F11) Each branch runs against its own shallow-copied
     * fork of the current run's store (see runStorage comment above): `phase`
     * and `group` are copied by value, so a `phase()` call made inside one
     * branch's processor mutates only that branch's copy and can never leak
     * into a sibling branch (or into activities dispatched from a sibling
     * branch that happens to still be in flight) -- this is the exact F11
     * "concurrent branches inherit whichever phase() was called last" bug.
     * `args`/`budget`/`runId` are copied by reference so they stay shared and
     * consistent across every branch of the same run. When `parallel()` is
     * called outside of any active run store (legacy direct-call usage),
     * branches simply run without forking anything, matching prior behavior.
     *
     * (apra-fleet-unw2.14, N6) When journaling is active, each branch fork
     * ALSO gets its OWN activity sub-sequence rooted at a deterministic,
     * scheduler-independent prefix. Before this, every branch shared the
     * run's single `activitySeq` counter, so the sequence number a given
     * agent()/command() call received depended on which branch's call
     * happened to increment the shared counter next -- non-deterministic
     * across runs. A resumed multi-streak run then computed different
     * sequence numbers than the journaled run, missed the replay cache, and
     * re-executed everything live (re-dispatching doers whose work already
     * happened). Now the prefix is `<parentPrefix><barrierIndex>:<i>:` where
     * `barrierIndex` numbers this parallel() barrier at the parent level (in
     * program order, assigned SYNCHRONOUSLY before any branch runs) and `i`
     * is the branch's STATIC index in `items` -- neither depends on runtime
     * completion/scheduling order. Each branch's own fresh `activitySeq`
     * then counts only that branch's calls, in the branch's own program
     * order. The result: identical replay keys for a given logical call site
     * regardless of how branches interleave. See journal.mjs
     * computeActivityKey for the full semantics.
     */
    async parallel(items, processor, opts = {}) {
        const parentStore = this._store();
        // Assign this barrier's index SYNCHRONOUSLY, in program order, before
        // any branch is scheduled -- so it can never race with a sibling
        // parallel() call at the same store level. Only meaningful when
        // journaling is active (parallelSeq is null otherwise).
        const barrierIndex = (parentStore && parentStore.parallelSeq)
            ? parentStore.parallelSeq.value++
            : null;
        return Promise.all(items.map((item, i) => {
            const runBranch = async () => {
                try {
                    return await processor(item, i, items);
                } catch (err) {
                    this.log(`[Parallel Error] item ${i} failed: ${err.message}`);
                    if (!opts.continueOnError) {
                        throw err;
                    }
                    return null;
                }
            };
            if (parentStore) {
                const branchStore = { ...parentStore };
                // Journaling active: give this branch its OWN hierarchical
                // sub-sequence so its replay keys are order-independent. The
                // prefix is fixed by the branch's static array index `i` and
                // the barrier index computed above -- not by scheduling.
                if (parentStore.activitySeq) {
                    branchStore.seqPrefix = `${parentStore.seqPrefix || ''}${barrierIndex}:${i}:`;
                    branchStore.activitySeq = { value: 0 };
                    branchStore.parallelSeq = { value: 0 };
                }
                return runStorage.run(branchStore, runBranch);
            }
            return runBranch();
        }));
    }

    /**
     * (apra-fleet-unw2.14, N6) Computes the replay `sequence` component for
     * the next agent()/command() call in the current store, advancing the
     * store's local activity counter. At the top level this returns a plain
     * number (`0`,`1`,...); inside a `parallel()` branch it returns the
     * hierarchical, scheduler-independent string
     * `<seqPrefix><localSeq>` (e.g. `0:1:0`). Returns `null` when journaling
     * is not active for this run (so no replay-key machinery runs at all).
     * @param {object|undefined} store
     * @returns {number|string|null}
     */
    _nextSequence(store) {
        if (!store || !store.activitySeq) return null;
        const local = store.activitySeq.value++;
        return store.seqPrefix ? `${store.seqPrefix}${local}` : local;
    }

    /**
     * (apra-fleet-unw2.14, N6) Builds the human-facing replay-divergence
     * warning, distinguishing a divergence detected INSIDE a `parallel()`
     * region from a sequential one. The two carry very different severity for
     * a human debugging a resume:
     *
     *   - A SEQUENTIAL divergence is the suspicious case: the run's top-level
     *     flow no longer matches the journal, which almost always means the
     *     workflow script itself changed (a call added/removed/reordered, a
     *     prompt/command edited, non-deterministic args) between the recording
     *     and the resume. Everything from here on re-runs live.
     *
     *   - A PARALLEL-region divergence is (post-N6) far less alarming: keys
     *     inside `parallel()` are now scheduler-independent, so a divergence
     *     here is NOT caused by branch interleaving. It usually means either
     *     (a) the journal was written by a pre-N6 build (old shared global
     *     counter -- see computeActivityKey's OLD-FORMAT note; regenerate the
     *     journal to fix), or (b) a branch is internally non-deterministic
     *     (dispatches a different number/order of calls across runs) or the
     *     set/order of parallel branches changed.
     * @param {{ sequence: number|string, type: string, member?: string, inParallel: boolean }} parts
     * @returns {string}
     */
    _divergenceWarning({ sequence, type, member, inParallel }) {
        const base = `[Journal] Replay divergence at sequence ${sequence} (${type}, member: ${member}) -- switching to live execution from this point onward.`;
        if (inParallel) {
            return base + ' This divergence is INSIDE a parallel() region; branch interleaving is NOT the cause (replay keys are order-independent since apra-fleet-unw2.14/N6). Likely a pre-N6 (old-format) journal, an internally non-deterministic branch, or a changed set/order of parallel branches -- regenerate the journal from a fresh run if it predates N6.';
        }
        return base + ' This is a SEQUENTIAL (top-level) divergence: the run no longer matches the journal, most likely because the workflow script or its args changed between recording and resume.';
    }

    async transform(label, func, context) {
        const id = randomUUID();
        const activityMeta = {
            id, type: 'transform', label, phase: this._currentPhase(), runId: this._currentRunId(), startTime: Date.now()
        };
        this.emit('activity:start', activityMeta);

        const transformationFn = func || ((data) => data); // pass as-is default

        try {
            let result = await transformationFn(context);
            const duration = Date.now() - activityMeta.startTime;
            
            let stringifiedOutput = result;
            if (typeof result !== 'string' && result !== undefined && result !== null) {
                try { stringifiedOutput = JSON.stringify(result, null, 2); } catch(e) {}
            }

            let stringifiedInput = context;
            if (typeof context !== 'string' && context !== undefined && context !== null) {
                try { stringifiedInput = JSON.stringify(context, null, 2); } catch(e) {}
            }

            this.emit('activity:end', { ...activityMeta, duration, success: true, input: stringifiedInput, output: stringifiedOutput });
            return result;
        } catch (e) {
            const duration = Date.now() - activityMeta.startTime;
            let stringifiedInput = context;
            if (typeof context !== 'string' && context !== undefined && context !== null) {
                try { stringifiedInput = JSON.stringify(context, null, 2); } catch(e) {}
            }

            this.emit('activity:end', { ...activityMeta, duration, success: false, error: e.message, input: stringifiedInput });
            const err = new Error(`[Workflow Error] Transform failed: ${e.message}`);
            throw err;
        }
    }

    async workflow(nameOrRef, args = {}) {
        // Run another script inline. Needs script runner logic.
        throw new Error("Nested workflows not yet implemented");
    }

    // Shared primitive bindings (agent/command/parallel/etc.) used by both
    // the legacy `createContext()` and the per-run `runWithContext()` below.
    // The primitives themselves are always bound to `this` -- they don't
    // capture `args`/`phase`/`budget` directly; instead they look those up
    // dynamically via `this._store()`/`this._current*()` at call time (see
    // the runStorage comment above this class), so the SAME bound functions
    // correctly resolve to whichever run (or the legacy instance-level
    // fields) is active when they're actually invoked.
    _bindPrimitives() {
        return {
            agent: this.agent.bind(this),
            command: this.command.bind(this),
            sequential: this.sequential.bind(this),
            pipeline: this.pipeline.bind(this),
            parallel: this.parallel.bind(this),
            transform: this.transform.bind(this),
            nullTransform: () => null,
            log: this.log.bind(this),
            phase: this.phase.bind(this),
            publishState: this.publishState.bind(this),
            workflow: this.workflow.bind(this),
            group: this.group.bind(this),
            endGroup: this.endGroup.bind(this)
        };
    }

    // A helper to inject the workflow globals into a user script context.
    //
    // Legacy / direct-call form: NOT run-scoped. `args`/`budget` here are the
    // legacy instance-level fields (`this.args`/`this.budget`), exactly as
    // before apra-fleet-unw.9 -- preserved for existing direct `wf.method()`
    // callers and tests that never go through `WorkflowEngine.executeFile()`.
    // For per-run isolation (the fix for the concurrent-execution bug this
    // context object exists to prevent), use `runWithContext()` instead,
    // which `WorkflowEngine.executeFile()` calls internally.
    createContext(args = this.args) {
        return {
            ...this._bindPrimitives(),
            args,
            budget: this.budget
        };
    }

    /**
     * Runs `entryFn(context)` inside a fresh, isolated per-run store (see the
     * runStorage comment above this class): its own `args`, `phase`, `group`,
     * and `budget` accounting, plus a unique `runId` carried on every
     * activity/log/state event emitted during the run. Concurrent calls to
     * `runWithContext()` (e.g. two overlapping `WorkflowEngine.executeFile()`
     * calls) on the SAME `FleetWorkflow` instance no longer corrupt each
     * other's `args` or phase attribution -- each gets its own store, and
     * `runStorage` (an `AsyncLocalStorage`) threads it automatically through
     * every `await` inside `entryFn`.
     *
     * The `FleetWorkflow`'s `EventEmitter` remains shared (a dashboard viewer
     * subscribes to it once, globally); every event carries the originating
     * run's `runId` so concurrent runs' events stay distinguishable there.
     *
     * @param {any} args - Arguments for this run, exposed as `context.args`.
     * @param {(context: object) => Promise<any>} entryFn - The workflow
     *   script's entry point (`main`/`run`/`default`), called with this run's
     *   context object.
     * @param {{ runId?: string, journalEnabled?: boolean, replay?: {completedByKey: Map<string,object>, diverged: boolean} }} [opts] -
     *   (apra-fleet-unw.10) `runId`: optional caller-supplied run id, so
     *   `WorkflowEngine.executeFile()` can know the run's id up front (to
     *   attach it to the `end` event it emits from its own try/finally)
     *   without this method having to report it back out-of-band. Defaults
     *   to a fresh UUID when omitted, matching the pre-unw.10 behavior for
     *   any other/legacy caller.
     *   (apra-fleet-unw.11, F6) `journalEnabled`/`replay`: journal/resume
     *   wiring from `WorkflowEngine.executeFile()`. `journalEnabled` gates
     *   the per-run activity sequence counter (`store.activitySeq`) that
     *   `agent()`/`command()` use to compute deterministic replay keys --
     *   when omitted/false, that counter is never created and
     *   `agent()`/`command()` never compute or attach replay-related fields
     *   to their activity events, so behavior/output is unchanged from
     *   before this feature existed. `replay` (only meaningful when
     *   `journalEnabled` is true) is the loaded journal's
     *   `completedByKey`/`diverged` state (see journal.mjs `loadJournal()`);
     *   `diverged` is mutated in place by `agent()`/`command()` the first
     *   time a call's replay key isn't found as a completed/successful
     *   record in the journal, permanently switching the rest of the run to
     *   live execution (partial replay, Claude-CLI style).
     */
    async runWithContext(args, entryFn, opts = {}) {
        const runId = opts.runId || randomUUID();
        const budget = {
            total: null,
            _spent: 0,
            spent: () => budget._spent,
            remaining: () => budget.total === null ? Infinity : (budget.total - budget._spent)
        };
        // (apra-fleet-unw.10) Per-run AbortController backing cooperative
        // cancellation: agent()/command() default to `store.signal` (via
        // _currentSignal()) so requestStop() can abort every in-flight and
        // future dispatch of THIS run without the workflow script having to
        // thread a signal through itself. Tracked in `_activeControllers` for
        // the lifetime of the run only -- removed in `finally` below so a
        // late requestStop() call after the run has already finished is a
        // no-op instead of leaking controllers across runs.
        const controller = new AbortController();
        this._activeControllers.set(runId, controller);
        const store = {
            runId,
            args,
            phase: null,
            group: null,
            budget,
            signal: controller.signal,
            // (apra-fleet-unw.11, F6 / apra-fleet-unw2.14, N6) Per-run
            // activity sequencing for deterministic replay keys.
            //
            // `activitySeq` is a monotonic counter scoped to THIS store level
            // (the run's top-level flow, or -- after a `parallel()` fork -- a
            // single branch). At the top level it produces plain numeric
            // sequences 0,1,2,... in program order, exactly as before N6.
            //
            // `seqPrefix` is the hierarchical path prefix prepended to a
            // call's local sequence to form its replay key's `sequence`
            // component. It is empty ('') at the top level -- so top-level
            // keys stay numeric and backward-compatible -- and is extended by
            // `parallel()` per branch (see parallel() below) to
            // `<barrierIndex>:<branchIndex>:`, making every in-branch key
            // scheduler-INDEPENDENT (order of branch interleaving no longer
            // affects the key). See journal.mjs computeActivityKey for the
            // full semantics/limitations.
            //
            // `parallelSeq` numbers the `parallel()` barriers entered AT this
            // store level, in program order, so two sequential parallel()
            // calls at the same level get distinct barrier prefixes even if
            // no agent()/command() ran between them.
            //
            // All three are `null` unless journaling was requested for this
            // run at all (a normal, non-journaled run never enters any of the
            // replay-key code paths).
            activitySeq: opts.journalEnabled ? { value: 0 } : null,
            seqPrefix: '',
            parallelSeq: opts.journalEnabled ? { value: 0 } : null,
            replay: opts.journalEnabled ? (opts.replay || null) : null
        };
        const context = {
            ...this._bindPrimitives(),
            args,
            budget
        };
        try {
            return await runStorage.run(store, () => entryFn(context));
        } finally {
            this._activeControllers.delete(runId);
        }
    }
}
