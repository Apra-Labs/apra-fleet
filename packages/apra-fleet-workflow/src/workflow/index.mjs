import Ajv from 'ajv';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { calculateCost } from './pricing.mjs';
import { WorkflowError, MemberNotFoundError, AgentOutputError, CommandError, FleetTransportError } from './errors.mjs';

export { WorkflowError, MemberNotFoundError, AgentOutputError, CommandError, FleetTransportError } from './errors.mjs';

const ajv = new Ajv({ strict: false });

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
        
        let finalPrompt = prompt;
        let compiledSchema = null;
        if (opts.schema) {
            try {
                compiledSchema = ajv.compile(opts.schema);
            } catch (err) {
                throw new Error(`[Workflow Error] Invalid JSON Schema provided to agent(): ${err.message}`);
            }
            finalPrompt += `\n\nOnly provide your response strictly as per this JSON schema:\n${JSON.stringify(opts.schema, null, 2)}`;
        }

        const activityMeta = {
            id: Math.random().toString(36).substring(2, 9),
            type: 'agent',
            phase: effectivePhase,
            label: opts.label || prompt.split('\n')[0].substring(0, 50) + (prompt.length > 50 ? '...' : ''),
            member: opts.member_name || opts.member_id,
            model: opts.model || 'default',
            startTime: Date.now()
        };
        this.emit('activity:start', activityMeta);

        const payload = {
            prompt: finalPrompt,
            model: opts.model,
            member_name: opts.member_name,
            member_id: opts.member_id,
            substitutions: opts.substitutions,
            timeout_s: opts.timeout_s,
            max_turns: opts.max_turns,
            effort: opts.effort,
            agent: opts.agentType,
            // F10: default to a self-contained (non-resumed) session for
            // workflow-authored prompts. See AgentOptions.resume above and
            // apra-fleet-unw.3.
            resume: opts.resume ?? false,
            // apra-fleet-unw.5: opts pass-through only, no control-flow change here.
            timeoutMs: opts.timeoutMs,
            signal: opts.signal
        };

        try {
            const result = await this.fleetApi.executePrompt(payload);

            if (!result.usage || typeof result.usage.total_tokens !== 'number') {
                const dummyP = Math.floor(Math.random() * 500) + 100;
                const dummyC = Math.floor(Math.random() * 200) + 50;
                result.usage = { prompt_tokens: dummyP, completion_tokens: dummyC, total_tokens: dummyP + dummyC };
            }

            const cost = calculateCost(opts.model || 'default', result.usage);
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
                // typed error rather than a silent `null` return.
                if (text.startsWith('Member "') && text.includes('" not found.')) {
                    console.error(`[Agent API Error]`, text);
                    this.emit('activity:end', { ...activityMeta, error: text, duration: Date.now() - activityMeta.startTime, success: false });
                    throw new MemberNotFoundError(`[Workflow Error] ${text}`, { details: { text, member: opts.member_name || opts.member_id } });
                }

                if (opts.schema) {
                    let parsedJson;
                    try {
                        const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
                        if (jsonMatch) {
                            parsedJson = JSON.parse(jsonMatch[0]);
                        } else {
                            parsedJson = JSON.parse(text);
                        }
                    } catch (e) {
                        const err = new AgentOutputError(`[Workflow Error] LLM failed to return parseable JSON for structured output.`, { details: { text }, cause: e });
                        this.emit('activity:end', { ...activityMeta, error: err.message, output: text, duration, usage: result.usage, cost });
                        throw err;
                    }

                    const isValid = compiledSchema(parsedJson);
                    if (!isValid) {
                        const errors = ajv.errorsText(compiledSchema.errors);
                        const err = new AgentOutputError(`[Workflow Error] LLM returned non-compliant JSON. Validation failed: ${errors}`, { details: { text, validationErrors: compiledSchema.errors } });
                        this.emit('activity:end', { ...activityMeta, error: err.message, output: text, duration, usage: result.usage, cost });
                        throw err;
                    }

                    this.emit('activity:end', { ...activityMeta, duration, success: true, usage: result.usage, cost, output: JSON.stringify(parsedJson, null, 2) });
                    return parsedJson;
                }
                this.emit('activity:end', { ...activityMeta, duration, success: true, usage: result.usage, cost, output: text });
                return text;
            }
            this.emit('activity:end', { ...activityMeta, duration, success: false });
            throw new AgentOutputError(`[Workflow Error] agent() received an empty content response from the fleet API.`, { details: { result } });
        } catch (error) {
            console.error(`[Agent API Error]`, error.message || error);
            this.emit('activity:end', { ...activityMeta, error: error.message || error, duration: Date.now() - activityMeta.startTime, success: false });
            if (error instanceof WorkflowError) {
                throw error;
            }
            throw new FleetTransportError(`[Workflow Error] Transport failure while executing agent prompt: ${error.message || error}`, { details: { payload }, cause: error });
        }
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
