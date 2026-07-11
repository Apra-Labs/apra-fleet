import Ajv from 'ajv';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { calculateCost } from './pricing.mjs';
import { WorkflowError, MemberNotFoundError, AgentOutputError, CommandError, FleetTransportError, BudgetExceededError } from './errors.mjs';

export { WorkflowError, MemberNotFoundError, AgentOutputError, CommandError, FleetTransportError, BudgetExceededError } from './errors.mjs';

const ajv = new Ajv({ strict: false });

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
    const candidates = fenced.length > 0 ? fenced : extractBalancedJsonCandidates(text);

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

    for (const raw of candidates) {
        const result = tryCandidate(raw);
        if (result) return result;
    }

    // Last-resort fallback: no bracketed candidate was found at all (e.g. a
    // reply that is itself plain JSON with stray leading/trailing
    // whitespace but somehow no `{`/`[` was detected as an opener -- should
    // be rare given the scan above, but keeps behavior at least as good as
    // the old single-shot JSON.parse(text) path).
    if (candidates.length === 0) {
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
 * @property {object} [schema] - JSON Schema for structured output
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
    }

    log(msg) {
        console.log(`[Workflow Log] ${msg}`);
        this.emit('log', { phase: this.currentPhase, msg });
    }

    group(title) {
        this.currentGroup = title;
        console.log(`\n=== Group: ${title} ===`);
        this.emit('group:start', { title });
    }

    endGroup() {
        this.emit('group:end', { title: this.currentGroup });
        this.currentGroup = null;
    }

    phase(title) {
        this.currentPhase = title;
        console.log(`--- Phase: ${title} ---`);
        this.emit('phase', title);
    }


    publishState(namespace, data) {
        this.emit('state', { namespace, data, phase: this.currentPhase });
    }

    /**
     * @param {string} prompt 
     * @param {AgentOptions} [opts] 
     */
    async agent(prompt, opts = {}) {
        if (!opts.member_name && !opts.member_id) {
            throw new Error(`[Workflow Error] agent() requires either member_name or member_id`);
        }

        const effectivePhase = opts.phase || this.currentPhase;
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

        for (let attempt = 0; attempt <= maxRepairs; attempt++) {
            if (this.budget.total !== null && this.budget.remaining() <= 0) {
                throw new BudgetExceededError(
                    `[Workflow Error] Budget exceeded: spent $${this.budget._spent.toFixed(4)} of $${this.budget.total.toFixed(4)} total. Aborting agent() dispatch.`,
                    { details: { spent: this.budget._spent, total: this.budget.total, member: opts.member_name || opts.member_id } }
                );
            }

            const isRepair = attempt > 0;
            const activityMeta = {
                id: Math.random().toString(36).substring(2, 9),
                type: 'agent',
                phase: effectivePhase,
                label: (opts.label || prompt.split('\n')[0].substring(0, 50) + (prompt.length > 50 ? '...' : ''))
                    + (isRepair ? ` [schema repair ${attempt}/${maxRepairs}]` : ''),
                member: opts.member_name || opts.member_id,
                model: opts.model || 'default',
                repairAttempt: attempt,
                startTime: Date.now()
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
                signal: opts.signal
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
                    this.budget._spent += cost;
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
        if (!opts.member_name && !opts.member_id) {
            throw new Error(`[Workflow Error] command() requires either member_name or member_id`);
        }

        const effectivePhase = opts.phase || this.currentPhase;
        if (!opts.silent) {
            console.log(`[Command] phase: ${effectivePhase} | member: ${opts.member_name || opts.member_id} | label: ${opts.label || 'none'}`);
        }

        let finalCmd = cmd;
        if (opts.substitutions) {
            for (const [key, value] of Object.entries(opts.substitutions)) {
                finalCmd = finalCmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
            }
        }

        const activityMeta = {
            id: Math.random().toString(36).substring(2, 9),
            type: 'command',
            phase: effectivePhase,
            label: opts.label || finalCmd.substring(0, 60),
            member: opts.member_name || opts.member_id,
            command: finalCmd,
            startTime: Date.now()
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
            signal: opts.signal
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
            return outText;
        } catch (error) {
            console.error(`[Command API Error]`, error.message || error);
            this.emit('activity:end', { ...activityMeta, error: error.message || error, duration: Date.now() - activityMeta.startTime, success: false });
            if (error instanceof WorkflowError) {
                throw error;
            }
            throw new FleetTransportError(`[Workflow Error] Transport failure while executing command: ${error.message || error}`, { details: { payload }, cause: error });
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
     */
    async parallel(items, processor, opts = {}) {
        return Promise.all(items.map(async (item, i) => {
            try {
                return await processor(item, i, items);
            } catch(err) {
                this.log(`[Parallel Error] item ${i} failed: ${err.message}`);
                if (!opts.continueOnError) {
                    throw err;
                }
                return null;
            }
        }));
    }

    async transform(label, func, context) {
        const id = randomUUID();
        const activityMeta = {
            id, type: 'transform', label, phase: this.currentPhase, startTime: Date.now()
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

    // A helper to inject the workflow globals into a user script context.
    createContext() {
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
            endGroup: this.endGroup.bind(this),
            args: this.args,
            budget: this.budget
        };
    }
}
