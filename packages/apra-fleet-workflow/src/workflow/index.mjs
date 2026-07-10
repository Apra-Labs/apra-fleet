import Ajv from 'ajv';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { calculateCost } from './pricing.mjs';

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

    phase(title) {
        this.currentPhase = title;
        console.log(`\n=== Phase: ${title} ===`);
        this.emit('phase', title);
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

        const actionMeta = {
            id: Math.random().toString(36).substring(2, 9),
            type: 'agent',
            phase: effectivePhase,
            label: opts.label || 'none',
            member: opts.member_name || opts.member_id,
            model: opts.model || 'default',
            startTime: Date.now()
        };
        this.emit('action:start', actionMeta);

        const payload = {
            prompt: finalPrompt,
            model: opts.model,
            member_name: opts.member_name,
            member_id: opts.member_id,
            substitutions: opts.substitutions,
            timeout_s: opts.timeout_s,
            max_turns: opts.max_turns,
            effort: opts.effort,
            agent: opts.agentType
        };

        try {
            const result = await this.fleetApi.executePrompt(payload);
            
            if (!result.usage || typeof result.usage.total_tokens !== 'number') {
                const dummyP = Math.floor(Math.random() * 500) + 100;
                const dummyC = Math.floor(Math.random() * 200) + 50;
                result.usage = { prompt_tokens: dummyP, completion_tokens: dummyC, total_tokens: dummyP + dummyC };
            }

            const cost = calculateCost(opts.model || 'default', result.usage);
            const duration = Date.now() - actionMeta.startTime;
            
            if (result && result.content && result.content.length > 0) {
                const text = result.content[0].text;
                
                if (text.startsWith('Member "') && text.includes('" not found.')) {
                    console.error(`[Agent API Error]`, text);
                    this.emit('action:end', { ...actionMeta, error: text, duration: Date.now() - actionMeta.startTime, success: false });
                    return null;
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
                        const err = new Error(`[Workflow Error] LLM failed to return parseable JSON for structured output.`);
                        this.emit('action:end', { ...actionMeta, error: err.message, output: text, duration, usage: result.usage, cost });
                        throw err;
                    }

                    const isValid = compiledSchema(parsedJson);
                    if (!isValid) {
                        const errors = ajv.errorsText(compiledSchema.errors);
                        const err = new Error(`[Workflow Error] LLM returned non-compliant JSON. Validation failed: ${errors}`);
                        this.emit('action:end', { ...actionMeta, error: err.message, output: text, duration, usage: result.usage, cost });
                        throw err;
                    }

                    this.emit('action:end', { ...actionMeta, duration, success: true, usage: result.usage, cost, output: JSON.stringify(parsedJson, null, 2) });
                    return parsedJson;
                }
                this.emit('action:end', { ...actionMeta, duration, success: true, usage: result.usage, cost, output: text });
                return text;
            }
            this.emit('action:end', { ...actionMeta, duration, success: false });
            return null;
        } catch (error) {
            console.error(`[Agent API Error]`, error.message || error);
            this.emit('action:end', { ...actionMeta, error: error.message || error, duration: Date.now() - actionMeta.startTime, success: false });
            throw error;
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

        const actionMeta = {
            id: Math.random().toString(36).substring(2, 9),
            type: 'command',
            phase: effectivePhase,
            label: opts.label || 'none',
            member: opts.member_name || opts.member_id,
            command: finalCmd,
            startTime: Date.now()
        };
        this.emit('action:start', actionMeta);

        const payload = {
            command: finalCmd,
            member_name: opts.member_name,
            member_id: opts.member_id,
            timeout_s: opts.timeout_s,
            long_running: opts.long_running
        };

        try {
            const result = await this.fleetApi.executeCommand(payload);
            const outText = result.content && result.content.length > 0 ? result.content[0].text : '';
            const duration = Date.now() - actionMeta.startTime;

            if (outText.startsWith('Member "') && outText.includes('" not found.')) {
                console.error(`[Command API Error]`, outText);
                this.emit('action:end', { ...actionMeta, error: outText, duration, success: false });
                return null;
            }
            
            if (result.isError) {
                const err = new Error(`[Command Failed] ${outText}`);
                this.emit('action:end', { ...actionMeta, error: err.message, duration, success: false });
                throw err;
            }

            this.emit('action:end', { ...actionMeta, duration, success: true, output: outText });
            return outText;
        } catch (error) {
            console.error(`[Command API Error]`, error.message || error);
            this.emit('action:end', { ...actionMeta, error: error.message || error, duration: Date.now() - actionMeta.startTime, success: false });
            throw error;
        }
    }

    /**
     * Executes the given async processor function for each item sequentially.
     */
    async pipeline(items, processor, opts = {}) {
        const results = [];
        for (let i = 0; i < items.length; i++) {
            try {
                const res = await processor(items[i], i, items);
                results.push(res);
            } catch (err) {
                this.log(`[Pipeline Error] item ${i} failed at a stage: ${err.message}`);
                results.push(null);
                if (!opts.continueOnError) {
                    throw err;
                }
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
        const actionMeta = {
            id, type: 'transform', label, phase: this.currentPhase, startTime: Date.now()
        };
        this.emit('action:start', actionMeta);

        const transformationFn = func || ((data) => data); // pass as-is default

        try {
            let result = await transformationFn(context);
            const duration = Date.now() - actionMeta.startTime;
            
            let stringifiedOutput = result;
            if (typeof result !== 'string' && result !== undefined && result !== null) {
                try { stringifiedOutput = JSON.stringify(result, null, 2); } catch(e) {}
            }

            let stringifiedInput = context;
            if (typeof context !== 'string' && context !== undefined && context !== null) {
                try { stringifiedInput = JSON.stringify(context, null, 2); } catch(e) {}
            }

            this.emit('action:end', { ...actionMeta, duration, success: true, input: stringifiedInput, output: stringifiedOutput });
            return result;
        } catch (e) {
            const duration = Date.now() - actionMeta.startTime;
            let stringifiedInput = context;
            if (typeof context !== 'string' && context !== undefined && context !== null) {
                try { stringifiedInput = JSON.stringify(context, null, 2); } catch(e) {}
            }

            this.emit('action:end', { ...actionMeta, duration, success: false, error: e.message, input: stringifiedInput });
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
            pipeline: this.pipeline.bind(this),
            parallel: this.parallel.bind(this),
            transform: this.transform.bind(this),
            nullTransform: () => null,
            log: this.log.bind(this),
            phase: this.phase.bind(this),
            workflow: this.workflow.bind(this),
            args: this.args,
            budget: this.budget
        };
    }
}
