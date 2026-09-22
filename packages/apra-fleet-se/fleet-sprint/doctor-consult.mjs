// sprint-doctor consult layer (design:
// fleet-sprint/docs/escalate-to-llm-design.md sections 2.1, 2.2, 5 and 6).
//
// THE THIRD of the doctor's four modules. doctor-ledger.mjs records what
// happened, doctor-triggers.mjs decides that something is wrong, THIS module
// asks the question -- and doctor-executor.mjs (a later lane) is the only one
// that ever changes anything. The boundary that makes the whole mechanism
// safe lives here: the runner pre-assembles every fact into the prompt, the
// doctor is dispatched with ZERO tools, and it returns a schema-validated
// verdict the runner -- never the doctor -- acts on.
//
// WHAT "ZERO TOOLS" BUYS, AND WHY IT IS STRUCTURAL RATHER THAN CONFIGURED:
// member log tails are attacker-influenceable text, so the consult prompt is
// a prompt-injection surface by construction. A tool-less dispatch cannot
// edit source, cannot touch the target project and cannot shell anything, no
// matter what that text talks it into wanting -- injected content can at most
// skew a choice among the enumerated actions the verdict schema already
// bounds. That is an enforcement the engine cannot accidentally configure
// away, which a restricted toolset would not be.
//
// THE STRICTLY-ADDITIVE RULE (design doc section 6) IS THE OTHER HALF, and it
// is what every failure path in this file implements: a consult that fails
// for ANY reason -- disabled, capped, input-invalid, dispatch error, schema
// exhausted, watchdog fire, budget refusal -- LOGS and returns null, and the
// caller then behaves exactly as it did before the doctor existed. Nothing in
// this module throws into the cycle loop, and nothing here mutates sprint
// state. The doctor can never make an outcome worse than not being consulted.
//
// NO RECURSION (design doc section 6): a doctor consult is an engine-internal
// step, NOT a ledger-recorded dispatch outcome. Nothing in this file calls
// the health ledger's recordDispatch(), so a failed or garbled consult can
// never satisfy a trigger and summon another consult. The doctor is never
// doctored.
//
// EVERYTHING RUNNER-SIDE IS INJECTED, NEVER IMPORTED (the same discipline
// dispatch-role.mjs and git-sync.mjs keep): agent(), command(), callTool()
// and log() all arrive through the caller's options object. This module never
// imports runner.js -- runner.js imports it, so importing back would be a
// cycle -- and it names no target project, repo layout, tracker prefix or
// build command anywhere (see docs/generic-engine-boundary.md).

import {
    validateSprintDoctorInput,
    validateSprintDoctorVerdict,
    sprintDoctorVerdict,
    wrapUntrustedBlock,
    appendSchemaInstruction,
} from './contracts.mjs';

const LOG_PREFIX = '[sprint-doctor]';

/**
 * Every bound this module applies, each independently overridable by a
 * caller's partial `limits` object (shallow-merged over this default).
 * Nothing here reads process.env or any config file -- these defaults are the
 * ONLY built-in values, and the runner passes the sprint's own
 * `doctor_max_consults` / `doctor_max_per_class` args over them.
 */
export const DEFAULT_CONSULT_LIMITS = Object.freeze({
    // Per-log-tail byte cap (design doc section 2.2: "default 16KB each").
    // The cap TRUNCATES -- it never drops a tail -- so the doctor always sees
    // the most recent output plus an explicit note of what was cut.
    logTailBytes: 16 * 1024,
    // Per-sprint consult cap (doctor_max_consults).
    maxConsults: 3,
    // Per-error-class remedy cap (doctor_max_per_class): "healing is a
    // bridge, never a home" -- after this many consults keyed to one
    // errorSignature, the class must fail loudly and demand an engine fix.
    maxPerClass: 2,
    // Probe rounds per consult. ONE, always: the second response must act.
    maxProbeRounds: 1,
    // Row/entry caps on the assembled evidence, so a long sprint's ledger
    // cannot grow the prompt without bound. Most-recent rows are kept.
    maxEvidenceRows: 25,
    maxLedgerRows: 50,
    maxBeadDetails: 10,
    maxConsultHistory: 10,
    maxRegistryEntries: 50,
    // Dispatch budget for the consult itself: a single-turn judgment call
    // over a pre-assembled context, not an exploration.
    maxTurns: 1,
    timeoutS: 600,
});

/**
 * The closed probe enum, mirroring sprint-doctor-output.json's `probes`
 * items. Frozen and exported so the runner (and the tests) read ONE list
 * rather than two that can drift.
 */
export const PROBE_KINDS = Object.freeze([
    'member_cli_version',
    'member_workspace_state',
    'member_disk_free',
    'member_session_state',
    'bd_show',
    'log_tail',
]);

// ---------------------------------------------------------------------------
// 1. Bounded input assembly
// ---------------------------------------------------------------------------

/**
 * Keeps the LAST `maxBytes` bytes of `text`, prefixed with an explicit note
 * of how much was cut. Truncation, never omission: the tail is the part that
 * carries the failure, and a silently dropped log is exactly the evidence gap
 * the doctor exists to close, so an oversized tail is shortened and SAID to
 * be shortened rather than left out.
 * @param {unknown} text
 * @param {number} [maxBytes]
 * @returns {{ text: string, truncated: boolean, originalBytes: number, keptBytes: number }}
 */
export function truncateLogTail(text, maxBytes = DEFAULT_CONSULT_LIMITS.logTailBytes) {
    const str = text === null || text === undefined ? '' : String(text);
    const buf = Buffer.from(str, 'utf8');
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || buf.length <= maxBytes) {
        return { text: str, truncated: false, originalBytes: buf.length, keptBytes: buf.length };
    }
    const omitted = buf.length - maxBytes;
    const kept = buf.subarray(omitted).toString('utf8');
    const marker = `[truncated: ${omitted} of ${buf.length} bytes omitted from the START of this tail; `
        + `the most recent ${maxBytes} bytes follow]\n`;
    return { text: marker + kept, truncated: true, originalBytes: buf.length, keptBytes: maxBytes };
}

/**
 * A bounded, in-memory tail buffer -- the source of the "last N KB of the
 * runner's own sprint log" the consult input needs.
 *
 * WHY THIS EXISTS AT ALL: this engine writes no log FILE. `log()` is the
 * workflow engine's sink, so there is nothing on disk to tail; the only way
 * to have a sprint-log tail available at consult time is to keep one. It is
 * bounded by bytes (not lines, and not unbounded-then-sliced), so a sprint
 * that logs for six hours costs the same fixed memory as one that logs for
 * six seconds, and the buffer can never itself become the memory problem the
 * doctor is diagnosing.
 *
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ append: (msg: unknown) => void, text: () => string, bytes: () => number }}
 */
export function createLogTailBuffer({ maxBytes = DEFAULT_CONSULT_LIMITS.logTailBytes } = {}) {
    let buffered = '';
    return {
        append(msg) {
            if (msg === null || msg === undefined) return;
            buffered += `${String(msg)}\n`;
            // Trim from the FRONT once over budget: the tail is the part that
            // matters, and trimming lazily (only when the cap is exceeded)
            // keeps the common case a single string concatenation.
            if (buffered.length > maxBytes * 2) {
                buffered = buffered.slice(buffered.length - maxBytes);
            }
        },
        text() {
            return buffered.length > maxBytes ? buffered.slice(buffered.length - maxBytes) : buffered;
        },
        bytes() {
            return buffered.length;
        },
    };
}

/** Last `n` entries of an array, tolerating a non-array. */
function lastN(rows, n) {
    if (!Array.isArray(rows)) return [];
    return n > 0 && rows.length > n ? rows.slice(rows.length - n) : rows.slice();
}

/**
 * Per-member aggregate failure counts across the whole ledger -- the other
 * half (with the cross-member signature table the ledger itself builds) of
 * the environment-vs-engine discriminator: failures confined to one member
 * across two or more distinct beads point at that member's environment,
 * because the work varies and the host does not.
 * @param {object[]} ledgerRows
 * @returns {Record<string, number>}
 */
export function memberFailureCounts(ledgerRows) {
    const counts = {};
    for (const row of Array.isArray(ledgerRows) ? ledgerRows : []) {
        if (!row || row.ok || !row.member) continue;
        counts[row.member] = (counts[row.member] || 0) + 1;
    }
    return counts;
}

/**
 * Assembles the full consult context -- everything the zero-tool doctor is
 * ever allowed to see -- as an object shaped by
 * apra-pm/agents/schemas/sprint-doctor-input.json. Pure: no I/O, no
 * dispatching; every value arrives from the caller, which is what lets the
 * caps below be asserted directly.
 *
 * Both log tails are truncated to `limits.logTailBytes` and then run through
 * wrapUntrustedBlock() -- the package's existing untrusted-content sanitizer,
 * which redacts secret-token references and fences the block as data rather
 * than instructions. Redaction happens HERE, at assembly, so no unsanitized
 * member output can reach a prompt even if a future caller builds its own.
 *
 * @param {{
 *   branch: string, base?: string, goal?: string,
 *   cycle?: number, maxCycles?: number, phaseLabel?: string,
 *   members?: string[], roleMap?: object,
 *   budget?: { total?: number|null, spent?: number },
 *   trigger: { id: string, evidenceRows?: object[], summary?: string, scope?: string, member?: string },
 *   triggeringBeadIds?: string[],
 *   beadDetails?: object[], scopeSummary?: object,
 *   ledgerRows?: object[], beadLedgerRows?: object[], memberLedgerRows?: object[],
 *   errorSignatureFrequency?: Record<string, number>,
 *   logTails?: { sprintLog?: string, memberDispatchOutput?: string },
 *   consultHistory?: object[], registry?: object[],
 * }} parts
 * @param {Partial<typeof DEFAULT_CONSULT_LIMITS>} [limits]
 * @returns {object} the assembled input (NOT yet validated -- see validateSprintDoctorInput)
 */
export function buildConsultInput(parts = {}, limits = {}) {
    const lim = { ...DEFAULT_CONSULT_LIMITS, ...limits };
    const trigger = parts.trigger || {};
    const tails = parts.logTails || {};

    const sprintLog = truncateLogTail(tails.sprintLog, lim.logTailBytes);
    const memberOutput = truncateLogTail(tails.memberDispatchOutput, lim.logTailBytes);

    const input = {
        branch: String(parts.branch ?? ''),
        trigger: {
            id: String(trigger.id ?? ''),
            evidence: lastN(trigger.evidenceRows, lim.maxEvidenceRows),
        },
        triggeringBeadIds: [...new Set((parts.triggeringBeadIds || []).map(String))],
        logTails: {
            // Sanitized AND fenced as untrusted data at assembly time (see
            // the doc comment above). `truncated` is reported alongside so a
            // consumer can tell a short log from a cut one.
            sprintLog: wrapUntrustedBlock('runner sprint log tail', sprintLog.text),
            sprintLogTruncated: sprintLog.truncated,
            sprintLogOriginalBytes: sprintLog.originalBytes,
        },
    };

    if (parts.base !== undefined) input.base = String(parts.base);
    if (parts.goal !== undefined) input.goal = String(parts.goal);
    if (Number.isInteger(parts.cycle)) input.cycle = parts.cycle;
    if (Number.isInteger(parts.maxCycles)) input.maxCycles = parts.maxCycles;
    if (parts.phaseLabel !== undefined) input.phaseLabel = String(parts.phaseLabel);
    if (Array.isArray(parts.members)) input.members = parts.members.map(String);
    if (parts.roleMap) input.roleMap = parts.roleMap;
    if (parts.budget) {
        input.budget = {
            total: parts.budget.total ?? null,
            spent: typeof parts.budget.spent === 'number' ? parts.budget.spent : 0,
        };
    }
    if (trigger.summary) input.trigger.summary = String(trigger.summary);
    if (trigger.scope) input.trigger.scope = String(trigger.scope);
    if (trigger.member) input.trigger.member = String(trigger.member);

    if (Array.isArray(parts.beadDetails)) {
        input.beadDetails = lastN(parts.beadDetails, lim.maxBeadDetails);
    }
    if (parts.scopeSummary) input.scopeSummary = parts.scopeSummary;

    const allRows = Array.isArray(parts.ledgerRows) ? parts.ledgerRows : [];
    input.dispatchHistory = {
        beadLedgerRows: lastN(parts.beadLedgerRows, lim.maxLedgerRows),
        memberLedgerRows: lastN(parts.memberLedgerRows, lim.maxLedgerRows),
        errorSignatureFrequency: parts.errorSignatureFrequency || {},
        memberFailureCounts: memberFailureCounts(allRows),
    };

    if (memberOutput.text.length > 0) {
        input.logTails.memberDispatchOutput = wrapUntrustedBlock('member dispatch output tail', memberOutput.text);
        input.logTails.memberDispatchOutputTruncated = memberOutput.truncated;
        input.logTails.memberDispatchOutputOriginalBytes = memberOutput.originalBytes;
    }

    input.consultHistory = lastN(parts.consultHistory, lim.maxConsultHistory);
    input.registry = lastN(parts.registry, lim.maxRegistryEntries);
    return input;
}

// ---------------------------------------------------------------------------
// 1b. Re-plan mode: the same consult, asked a different question
// ---------------------------------------------------------------------------
//
// A doer that returns status BLOCKED has FINISHED its turn and is stating it
// cannot do the work from its seat. That is a planning/design defect, not a
// flaky dispatch, so none of the incident actions (retry, re-lane, repair)
// can answer it -- the bead itself has to change. This section adds the
// INPUT and PROMPT framing for that question.
//
// IT DELIBERATELY ADDS NO SECOND DISPATCH PATH. buildReplanConsultInput()
// returns the same shape buildConsultInput() does (it calls it), plus one
// extra `replan` block; buildConsultPrompt() notices that block and swaps its
// framing paragraph. runConsult() -- the zero-tool, premium, one-probe-round,
// schema-validated, never-throws dispatch -- is reused verbatim, so every
// bound and every failure-is-a-logged-null guarantee documented at the top of
// this file applies to a re-plan consult without being restated or
// re-implemented anywhere.

/**
 * The five re-plan action kinds, mirroring sprint-doctor-output.json's
 * `action.kind` enum. Frozen and exported so the executor's dispatch table
 * and this module read ONE list rather than two that can drift.
 */
export const REPLAN_ACTION_KINDS = Object.freeze([
    'replan_rewrite',
    'replan_rescope',
    'replan_route',
    'replan_grant',
    'replan_defer_with_credit',
]);

/**
 * What each role seat can actually DO, and what access it holds.
 *
 * This is the fact the doctor cannot otherwise have: "rewrite the bead so a
 * doer can finish it" and "route it to a test-runner that closes on
 * evidence" are only distinguishable if you know what the two seats differ
 * in. Without it a re-plan consult degenerates into rewording.
 *
 * GENERIC BY CONSTRUCTION: these are ENGINE role seats, described in engine
 * terms only. Nothing here names a target repo, a build command, a tracker
 * prefix or a credential provider -- a target's own specifics reach the
 * doctor through the bead text and the log tails, never through this map.
 */
export const ROLE_CAPABILITY_MAP = Object.freeze({
    doer: Object.freeze({
        can: Object.freeze([
            'read and edit source files in the sprint worktree',
            'run the target project build, linter and test commands',
            'commit to the sprint branch and push it',
            'claim and close the task beads it was assigned',
        ]),
        cannot: Object.freeze([
            'close a bead it was not assigned',
            'close a bead whose acceptance is evidence a test run must produce',
            'reach any environment outside its own member worktree',
        ]),
        access: Object.freeze(['repository write via the member VCS credential', 'the tracker on its own clone']),
    }),
    'integ-test-runner': Object.freeze({
        can: Object.freeze([
            'run the target integration-test playbook end to end',
            'own the test sandbox lifecycle (setup, reset, teardown)',
            'close a verify-set bead on observed evidence',
            'file a bug bead for a failure it observed',
        ]),
        cannot: Object.freeze(['write product source', 'commit to the sprint branch']),
        access: Object.freeze(['the test sandbox', 'the tracker on its own clone']),
    }),
    'regression-test-runner': Object.freeze({
        can: Object.freeze([
            'run the target regression playbook once per sprint',
            'own the test sandbox lifecycle',
            'file carry-over bug beads for failures',
        ]),
        cannot: Object.freeze(['write product source', 'gate the sprint (its phase is informational only)']),
        access: Object.freeze(['the test sandbox', 'the tracker on its own clone']),
    }),
    deployer: Object.freeze({
        can: Object.freeze([
            'follow the target deploy document and deploy the built software',
            'run the documented smoke test and report its result',
        ]),
        cannot: Object.freeze(['write product source', 'change the deploy document itself']),
        access: Object.freeze(['the deploy target environment and whatever credentials the target document provisions']),
    }),
});

/**
 * Assembles the consult input for a BLOCKED-bead re-plan.
 *
 * Everything buildConsultInput() already bounds (log tails, ledger rows,
 * evidence rows, consult history, registry) is bounded here identically --
 * this is that function plus ONE block. The added block carries the three
 * facts a re-plan needs and an incident consult does not:
 *
 *   1. `blockedReason` -- the doer's OWN stated reason, captured verbatim
 *      into the health ledger by the BLOCKED-capture lane. This is the
 *      primary evidence; everything else is context around it.
 *   2. `roleCapabilities` -- ROLE_CAPABILITY_MAP, injected as data.
 *   3. `allowedActionKinds` -- the five re-plan kinds, stated so the doctor
 *      is not left inferring from the schema alone which subset applies.
 *
 * @param {object} parts the same parts buildConsultInput() takes, plus
 *   `blockedReason` (string) and optionally `beadId` (string) and
 *   `roleCapabilities` (an override for tests).
 * @param {Partial<typeof DEFAULT_CONSULT_LIMITS>} [limits]
 * @returns {object}
 */
export function buildReplanConsultInput(parts = {}, limits = {}) {
    const input = buildConsultInput(parts, limits);
    const beadId = parts.beadId
        ? String(parts.beadId)
        : (input.triggeringBeadIds && input.triggeringBeadIds[0]) || '';
    input.replan = {
        beadId,
        // Wrapped and sanitized exactly like a log tail: the doer's notes are
        // model-authored text arriving from a member, so it is the same
        // prompt-injection surface, and fencing it costs nothing.
        blockedReason: wrapUntrustedBlock(
            'doer-stated blocked reason',
            truncateLogTail(parts.blockedReason, { ...DEFAULT_CONSULT_LIMITS, ...limits }.logTailBytes).text,
        ),
        roleCapabilities: parts.roleCapabilities || ROLE_CAPABILITY_MAP,
        allowedActionKinds: [...REPLAN_ACTION_KINDS],
    };
    return input;
}

/**
 * Loads the symptom/remedy registry (design doc section 4) if that lane has
 * landed, and returns [] if it has not. Deliberately lazy and optional: the
 * consult lane must be able to ship before the registry module exists, and a
 * missing registry is an empty data injection, never a consult failure.
 * @param {{ importer?: (spec: string) => Promise<object> }} [deps]
 * @returns {Promise<object[]>}
 */
export async function loadRegistryEntries(deps = {}) {
    const importer = deps.importer || ((spec) => import(spec));
    try {
        const mod = await importer('./doctor-registry.mjs');
        const entries = mod && (mod.REGISTRY_ENTRIES || mod.default);
        return Array.isArray(entries) ? entries : [];
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// 2. Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Renders the assembled input as the consult prompt. The two log tails are
 * already wrapped/sanitized by buildConsultInput(); everything else is
 * runner-owned structured data and is rendered as JSON so the doctor reads
 * facts rather than prose it has to parse.
 *
 * The schema instruction is appended through the same helper every other
 * role's prompt uses, so the doctor is told its output contract exactly the
 * way the reviewer/planner are told theirs.
 *
 * @param {object} input the object returned by buildConsultInput()
 * @param {{ probeResults?: object[]|null, schema?: object }} [opts]
 * @returns {string}
 */
export function buildConsultPrompt(input, opts = {}) {
    const schema = opts.schema || sprintDoctorVerdict;
    const { logTails, ...structured } = input;
    // ONE prompt builder, two framings. A re-plan input is recognized by the
    // `replan` block buildReplanConsultInput() adds -- nothing else about the
    // rendering, the schema instruction or the probe-round handling differs,
    // which is what keeps re-plan a MODE of this consult rather than a second
    // consult implementation that could drift from this one.
    const replan = structured.replan || null;
    const sections = replan
        ? [
            'A doer has reported BLOCKED on a bead: it finished its turn and is stating it CANNOT '
            + 'do the work from its seat. That is a planning defect in the bead, not a flaky '
            + 'dispatch, so retrying or re-laning it cannot help -- the bead itself has to change. '
            + 'You have NO tools: every fact you may use is below, including the doer\'s own stated '
            + 'reason and a map of what each role seat can do. Return ONE schema-valid verdict whose '
            + 'action.kind is one of the re-plan kinds listed in the context, carrying action.replan.',
            '',
            'Two bounds: the runner applies exactly ONE re-plan to this bead this cycle, and it '
            + 're-dispatches the bead ONLY if your payload actually changed it. Restating the bead '
            + 'as it already reads buys nothing and costs a dispatch -- if nothing available to this '
            + 'sprint can unblock it, say so with replan_defer_with_credit and a reason.',
            '',
            '## Re-plan context (runner-assembled, trusted)',
            '```json',
            JSON.stringify(structured, null, 2),
            '```',
            '',
            '## Runner sprint log tail',
            logTails.sprintLog,
        ]
        : [
            'You are being consulted about a sprint that its own deterministic handlers and retry '
            + 'ladders have already failed to resolve. You have NO tools: every fact you may use is '
            + 'below. Diagnose it and return one schema-valid verdict.',
            '',
            '## Incident context (runner-assembled, trusted)',
            '```json',
            JSON.stringify(structured, null, 2),
            '```',
            '',
            '## Runner sprint log tail',
            logTails.sprintLog,
        ];
    if (logTails.memberDispatchOutput) {
        sections.push('', '## Member-side dispatch output tail', logTails.memberDispatchOutput);
    }
    if (Array.isArray(opts.probeResults) && opts.probeResults.length > 0) {
        sections.push(
            '',
            '## Probe results (your ONE probe round, already executed by the runner)',
            'This is the second and FINAL dispatch of this consult. You have had your probe round, '
            + 'so this response MUST contain an `action` -- a further `probes` request will be refused '
            + 'and the consult discarded.',
            wrapUntrustedBlock('probe results', JSON.stringify(opts.probeResults, null, 2)),
        );
    }
    return appendSchemaInstruction(sections.join('\n'), schema);
}

// ---------------------------------------------------------------------------
// 3. The probe round
// ---------------------------------------------------------------------------

/**
 * Executes ONE probe through EXISTING runner verbs only. Every probe is
 * read-only and none of them is a dispatch: `member_detail` already reports a
 * member's CLI version, its session/connectivity state and its disk usage, so
 * three of the six probes are one existing MCP read rather than any new
 * member-bound shell string; the workspace probe is two plain git reads with
 * no shell-level expansion in them (the member's shell may be PowerShell);
 * `bd_show` is the orchestrator-side read every phase already does; and
 * `log_tail` returns more of a log the runner is already holding in memory,
 * so it costs nothing at all.
 *
 * Never throws: a probe that fails reports `{ ok: false, error }` and the
 * round continues, because a partial observation is still better evidence
 * than none and a failing probe is itself a finding.
 *
 * @param {string} probe one of PROBE_KINDS
 * @param {{
 *   command?: Function, callTool?: Function,
 *   member?: string|null, orchestratorMember?: string|null,
 *   beadIds?: string[], logTails?: { sprintLog?: string, memberDispatchOutput?: string },
 *   limits?: object,
 * }} ctx
 * @returns {Promise<{ probe: string, ok: boolean, output?: unknown, error?: string }>}
 */
export async function runProbe(probe, ctx = {}) {
    const lim = { ...DEFAULT_CONSULT_LIMITS, ...(ctx.limits || {}) };
    const member = ctx.member || null;
    const needsMember = probe !== 'bd_show' && probe !== 'log_tail';
    if (needsMember && !member) {
        return { probe, ok: false, error: 'no member is in scope for this consult, so a member-scoped probe cannot run' };
    }
    try {
        if (probe === 'member_cli_version' || probe === 'member_disk_free' || probe === 'member_session_state') {
            if (typeof ctx.callTool !== 'function') {
                return { probe, ok: false, error: 'member_detail is unavailable in this run (no callTool)' };
            }
            const detail = await ctx.callTool('member_detail', { member_name: member, format: 'json' });
            const parsed = parseMemberDetail(detail);
            if (probe === 'member_cli_version') {
                return { probe, ok: true, output: { member, llmProvider: parsed.llmProvider, llm_cli: parsed.llm_cli } };
            }
            if (probe === 'member_disk_free') {
                return { probe, ok: true, output: { member, resources: parsed.resources } };
            }
            return {
                probe,
                ok: true,
                output: { member, connectivity: parsed.connectivity, session: parsed.session, branch: parsed.branch },
            };
        }
        if (probe === 'member_workspace_state') {
            if (typeof ctx.command !== 'function') {
                return { probe, ok: false, error: 'no command() verb is available in this run' };
            }
            // Two separate commands, never one `&&`-chained string: command
            // chaining is not portable across the shells a member may be
            // registered with, and neither string relies on any shell-level
            // expansion.
            const status = await ctx.command('git status --porcelain', { member_name: member, silent: true });
            const head = await ctx.command('git log -1 --oneline', { member_name: member, silent: true });
            return {
                probe,
                ok: true,
                output: {
                    member,
                    status: truncateLogTail(textOf(status), lim.logTailBytes).text,
                    head: truncateLogTail(textOf(head), lim.logTailBytes).text,
                },
            };
        }
        if (probe === 'bd_show') {
            const ids = [...new Set((ctx.beadIds || []).map(String))];
            if (ids.length === 0) return { probe, ok: false, error: 'no bead ids are in scope for this consult' };
            if (typeof ctx.command !== 'function') {
                return { probe, ok: false, error: 'no command() verb is available in this run' };
            }
            if (!ctx.orchestratorMember) {
                return { probe, ok: false, error: 'no orchestrator member is available to read bead detail' };
            }
            const label = `bd show ${ids.join(' ')} --json`;
            const shown = await ctx.command(label, { member_name: ctx.orchestratorMember, silent: true });
            return { probe, ok: true, output: { beadIds: ids, detail: truncateLogTail(textOf(shown), lim.logTailBytes).text } };
        }
        if (probe === 'log_tail') {
            const tails = ctx.logTails || {};
            // "More of a log the runner already holds": the caps are doubled
            // for the probe round precisely because the doctor asked for more
            // than the first pass gave it, and it is still bounded.
            const extra = lim.logTailBytes * 2;
            return {
                probe,
                ok: true,
                output: {
                    sprintLog: wrapUntrustedBlock('runner sprint log tail (extended)', truncateLogTail(tails.sprintLog, extra).text),
                    memberDispatchOutput: wrapUntrustedBlock(
                        'member dispatch output tail (extended)',
                        truncateLogTail(tails.memberDispatchOutput, extra).text,
                    ),
                },
            };
        }
        return { probe, ok: false, error: `unknown probe kind ${JSON.stringify(probe)}` };
    } catch (err) {
        return { probe, ok: false, error: (err && err.message) || String(err) };
    }
}

/** Best-effort text extraction from a command()/callTool() result. */
function textOf(result) {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result;
    if (typeof result.stdout === 'string') return result.stdout;
    if (typeof result.output === 'string') return result.output;
    if (Array.isArray(result.content)) {
        return result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
    }
    try {
        return JSON.stringify(result);
    } catch {
        return String(result);
    }
}

/** Parses member_detail's JSON payload out of whatever envelope it arrives in. */
function parseMemberDetail(result) {
    const raw = textOf(result);
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : { raw };
    } catch {
        return { raw };
    }
}

/**
 * Executes a verdict's probe request -- de-duplicated, filtered to the closed
 * enum, and capped at one entry per probe kind so a repeated request cannot
 * multiply the round's cost.
 * @param {string[]} probes
 * @param {object} ctx see runProbe()
 * @returns {Promise<object[]>}
 */
export async function runProbeRound(probes, ctx = {}) {
    const requested = [...new Set((Array.isArray(probes) ? probes : []).map(String))]
        .filter((p) => PROBE_KINDS.includes(p));
    const results = [];
    for (const probe of requested) {
        results.push(await runProbe(probe, ctx));
    }
    return results;
}

// ---------------------------------------------------------------------------
// 4. Caps and the no-repeat rule (engine-enforced, never prompt-enforced)
// ---------------------------------------------------------------------------

/**
 * The per-sprint circuit breakers, held as one small stateful object per run
 * so the caps are counted in ONE place rather than re-derived at each call
 * site. Deliberately a factory function, matching the construction style the
 * rest of this package uses (createSprintHealthLedger, acquireSprintLock).
 *
 * Three independent bounds, all from design doc section 6:
 *   - maxConsults: how many consults this sprint may dispatch at all.
 *   - maxPerClass: how many consults one errorSignature class may earn --
 *     "healing is a bridge, never a home"; past this the class must fail
 *     loudly and demand an engine fix instead of being papered over again.
 *   - the no-repeat rule: a (beadId, action.kind) pair may be prescribed at
 *     most once. A verdict re-prescribing a remedy already tried and failed
 *     for that bead is OVERRIDDEN here, in code -- the doctor is shown its
 *     own consult history so a compliant model self-corrects first, but the
 *     engine never relies on that.
 *
 * @param {{ maxConsults?: number, maxPerClass?: number }} [caps]
 */
export function createConsultLimiter(caps = {}) {
    const maxConsults = caps.maxConsults ?? DEFAULT_CONSULT_LIMITS.maxConsults;
    const maxPerClass = caps.maxPerClass ?? DEFAULT_CONSULT_LIMITS.maxPerClass;
    const perClass = new Map();
    /** @type {Set<string>} `${beadId}::${action.kind}` pairs already prescribed. */
    const prescribed = new Set();
    let consults = 0;

    const pairKey = (beadId, kind) => `${beadId}::${kind}`;

    return {
        caps: Object.freeze({ maxConsults, maxPerClass }),
        /** How many consults have been counted so far. */
        count: () => consults,
        /**
         * May a consult for `errorSignature` run right now? Returns a reason
         * string when it may not, so the caller logs WHY it fell back rather
         * than silently doing nothing.
         * @returns {{ allowed: boolean, reason: string|null }}
         */
        check(errorSignature = null) {
            if (consults >= maxConsults) {
                return { allowed: false, reason: `per-sprint consult cap (${maxConsults}) reached` };
            }
            if (errorSignature && (perClass.get(errorSignature) || 0) >= maxPerClass) {
                return {
                    allowed: false,
                    reason: `error class "${errorSignature}" has already been consulted ${maxPerClass} time(s) `
                        + '(per-class cap) -- it must fail loudly and be fixed in the engine, not healed again',
                };
            }
            return { allowed: true, reason: null };
        },
        /** Counts one dispatched consult against both caps. */
        noteConsult(errorSignature = null) {
            consults += 1;
            if (errorSignature) perClass.set(errorSignature, (perClass.get(errorSignature) || 0) + 1);
        },
        /** True once (beadId, kind) has been prescribed for this sprint. */
        hasPrescribed(beadId, kind) {
            return prescribed.has(pairKey(beadId, kind));
        },
        /** Records that (beadId, kind) was prescribed. */
        notePrescribed(beadId, kind) {
            prescribed.add(pairKey(beadId, kind));
        },
    };
}

/**
 * Applies the no-repeat rule to a verdict, in code. If every bead in scope
 * has already been prescribed this action.kind, the action is replaced with
 * the conservative defer path (the design's "overridden to the defer/abort
 * path"), the original is preserved under `action.overriddenFrom`, and the
 * override is reported so the caller can log it. Otherwise the pair(s) are
 * recorded and the verdict is returned unchanged.
 *
 * Non-mutating: returns a new verdict object rather than editing the one the
 * dispatch produced.
 *
 * @param {object} verdict a schema-valid verdict carrying `action`
 * @param {string[]} beadIds the bead ids this consult is about
 * @param {ReturnType<typeof createConsultLimiter>} limiter
 * @returns {{ verdict: object, overridden: boolean, reason: string|null }}
 */
export function applyNoRepeatRule(verdict, beadIds, limiter) {
    const action = verdict && verdict.action;
    if (!action || !action.kind) return { verdict, overridden: false, reason: null };
    const scope = [...new Set((action.beadIds && action.beadIds.length > 0 ? action.beadIds : beadIds) || [])].map(String);
    if (scope.length === 0) return { verdict, overridden: false, reason: null };

    const repeats = scope.filter((id) => limiter.hasPrescribed(id, action.kind));
    if (repeats.length === scope.length) {
        // Already tried and failed for EVERY bead in scope. `defer_bead` is
        // the conservative landing: it is reversible, it costs no dispatch,
        // and it lets the sprint keep making progress on everything else --
        // whereas re-running a remedy known to have failed spends real money
        // to arrive back here.
        const reason = `action "${action.kind}" was already prescribed this sprint for [${repeats.join(', ')}] `
            + 'and did not resolve it; overridden to defer_bead by the engine no-repeat rule';
        return {
            verdict: {
                ...verdict,
                action: {
                    kind: 'defer_bead',
                    beadIds: scope,
                    reason,
                    overriddenFrom: action.kind,
                },
            },
            overridden: true,
            reason,
        };
    }
    for (const id of scope) limiter.notePrescribed(id, action.kind);
    return { verdict, overridden: false, reason: null };
}

// ---------------------------------------------------------------------------
// 5. The consult itself
// ---------------------------------------------------------------------------

/**
 * One zero-tool premium dispatch of the sprint-doctor persona, with at most
 * one probe round.
 *
 * Contract, in order:
 *   1. the assembled input is validated against the role's input schema
 *      BEFORE any dispatch -- a free, local, fail-fast check (the
 *      validateRoleInput pattern), so a malformed context costs nothing;
 *   2. the dispatch names its member explicitly, passes NO tools, and is
 *      pinned to the premium tier (which means "this member's best reasoning
 *      model", resolved per member -- never a hardcoded model id);
 *   3. a `probes` response executes exactly ONE probe round and re-dispatches
 *      once with the results appended; a SECOND `probes` response is refused
 *      and the consult fails;
 *   4. every failure returns null after logging, and nothing throws.
 *
 * @param {{
 *   agent: Function, command?: Function, callTool?: Function, log?: Function,
 *   member: string, orchestratorMember?: string|null,
 *   probeMember?: string|null,
 *   limits?: Partial<typeof DEFAULT_CONSULT_LIMITS>,
 *   label?: string,
 * }} deps
 * @param {object} input the object returned by buildConsultInput()
 * @returns {Promise<object|null>} the schema-valid verdict, or null on ANY failure
 */
export async function runConsult(deps, input) {
    const log = deps.log || (() => {});
    const lim = { ...DEFAULT_CONSULT_LIMITS, ...(deps.limits || {}) };
    const label = deps.label || 'Sprint Doctor';

    if (typeof deps.agent !== 'function') {
        log(`${LOG_PREFIX} consult skipped: no dispatch verb was provided for this run.`);
        return null;
    }
    if (!deps.member) {
        log(`${LOG_PREFIX} consult skipped: no member could be resolved to dispatch the consult on.`);
        return null;
    }

    // (1) Pre-flight: free, local, fail-fast. A context that cannot satisfy
    // the role's own input contract must never cost a premium dispatch.
    const preflight = validateSprintDoctorInput(input);
    if (!preflight.valid) {
        log(`${LOG_PREFIX} consult skipped: assembled input failed its own input-schema check -- ${summarizeErrors(preflight.errors)}.`);
        return null;
    }

    // Destructured so this module's ONE dispatch reads `agent(` -- the literal
    // token dispatch-safety-guard.mjs and inline-ladder-guard.mjs scan for. A
    // `deps.agent(` call would fall outside both guards' call-site regexes and
    // leave this file's only dispatch silently unguarded.
    const { agent } = deps;

    let probeResults = null;
    for (let round = 0; round <= lim.maxProbeRounds; round += 1) {
        const prompt = buildConsultPrompt(input, { probeResults, schema: sprintDoctorVerdict });
        let raw;
        try {
            // (2) ZERO TOOLS, premium tier, single turn. `allowed_tools: []`
            // is stated at the call site rather than left to the persona's
            // own frontmatter: the persona declares no tools either, and two
            // independent statements of the same boundary is the point -- a
            // vendored persona file can be edited on a member, this call
            // cannot.
            raw = await agent(prompt, {
                member_name: deps.member,
                agentType: 'sprint-doctor',
                model: 'premium',
                allowed_tools: [],
                max_turns: lim.maxTurns,
                timeout_s: lim.timeoutS,
                resume: false,
                schema: sprintDoctorVerdict,
                label: round === 0 ? label : `${label} (after probe round)`,
            });
        } catch (err) {
            // (4) Strictly additive: dispatch error, watchdog fire, budget
            // refusal -- all land here, all log, all return null, and the
            // caller then behaves exactly as it did before the doctor existed.
            log(`${LOG_PREFIX} consult failed (dispatch error): ${(err && err.message) || err}. `
                + 'Falling back to the pre-doctor behaviour for this incident.');
            return null;
        }

        const verdict = coerceVerdict(raw);
        const check = validateSprintDoctorVerdict(verdict);
        if (!check.valid) {
            // agent()'s own bounded schema-repair loop already ran and did not
            // produce a contract-valid verdict; there is no further re-ask.
            log(`${LOG_PREFIX} consult failed (schema repair exhausted): ${summarizeErrors(check.errors)}. `
                + 'Falling back to the pre-doctor behaviour for this incident.');
            return null;
        }

        if (verdict.action) {
            if (round > 0) {
                log(`${LOG_PREFIX} consult returned an action after its probe round.`);
            }
            return verdict;
        }

        // (3) A probes response. Allowed exactly once.
        if (round >= lim.maxProbeRounds) {
            log(`${LOG_PREFIX} consult failed: a second probes response was returned after the single permitted `
                + 'probe round, but round two must contain an action. Refusing it and falling back to the '
                + 'pre-doctor behaviour for this incident.');
            return null;
        }
        log(`${LOG_PREFIX} consult requested a probe round: ${(verdict.probes || []).join(', ')}.`);
        probeResults = await runProbeRound(verdict.probes, {
            command: deps.command,
            callTool: deps.callTool,
            member: deps.probeMember || input.trigger?.member || deps.member,
            orchestratorMember: deps.orchestratorMember,
            beadIds: input.triggeringBeadIds,
            logTails: deps.rawLogTails || {},
            limits: lim,
        });
    }

    // Unreachable in practice (the loop returns or refuses), but a consult
    // that somehow falls out of it still fails additively rather than
    // returning something unvalidated.
    log(`${LOG_PREFIX} consult failed: no action was produced within the permitted rounds.`);
    return null;
}

/**
 * agent() returns the parsed schema object for a schema-bearing dispatch, but
 * a transport may hand back a JSON string or an envelope; accept all three
 * rather than failing a consult over packaging.
 */
function coerceVerdict(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.classification !== undefined) return raw;
        if (raw.result && typeof raw.result === 'object') return raw.result;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }
    return raw ?? null;
}

/** Compact, log-safe rendering of an ajv error list. */
function summarizeErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return 'no further detail';
    return errors
        .slice(0, 5)
        .map((e) => `${e.instancePath || '/'} ${e.message}`)
        .join('; ');
}
