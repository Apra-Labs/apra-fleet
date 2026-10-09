// Role-delimited beads memory key scheme (see CLAUDE.md "Role-scoped
// operational memories"):
//   universal rule      +all+:<slug>
//   role-scoped rule    +<role>+:<slug>            e.g. +doer+:<slug>
//   multi-role rule     +<role1>+<role2>+:<slug>   e.g. +doer+reviewer+:<slug>
// Shared by scripts/rekey-beads-memories.mjs (old -> new key mapping) and
// scripts/beads-session-memories.mjs (session hook reader). Pure: no I/O.

export const ROLES = Object.freeze([
    'all', 'planner', 'plan-reviewer', 'doer', 'reviewer', 'deployer',
    'integ-test-runner', 'regression-test-runner', 'harvester', 'ci-watcher',
    'groomer', 'orchestrator',
]);
const ROLE_ALIASES = Object.freeze({ 'backlog-groomer': 'groomer' });

export const NEW_KEY_RE = /^\+(?:[a-z0-9-]+\+)+:.+$/;

/** A single role query token, e.g. `+all+` or `+orchestrator+`. */
export const ROLE_TOKEN_RE = /^\+[a-z0-9-]+\+$/;

/**
 * Maps one key to its new form; returns { kind: 'new'|'map'|'unparsed', to? }.
 * Old forms: role:all:<slug> -> +all+:<slug>; <r1>:<r2>:...:<slug> (every rN a
 * known role) -> +r1+r2+...+:<slug>; groomer-heuristic-<slug> -> +groomer+:<slug>.
 * Anything else is 'unparsed' -- never guessed.
 */
export function mapKey(key) {
    if (NEW_KEY_RE.test(key)) return { kind: 'new' };
    const gh = /^groomer-heuristic-(.+)$/.exec(key);
    if (gh) return { kind: 'map', to: `+groomer+:${gh[1]}` };
    const parts = key.split(':');
    if (parts.length < 2) return { kind: 'unparsed' };
    const slug = parts.pop();
    if (!slug) return { kind: 'unparsed' };
    let tokens = parts;
    if (tokens.length === 2 && tokens[0] === 'role' && tokens[1] === 'all') tokens = ['all'];
    const roles = [];
    for (const raw of tokens) {
        const t = ROLE_ALIASES[raw] || raw;
        if (!ROLES.includes(t)) return { kind: 'unparsed' };
        if (!roles.includes(t)) roles.push(t);
    }
    if (roles.includes('all') && roles.length > 1) return { kind: 'unparsed' };
    return { kind: 'map', to: `+${roles.join('+')}+:${slug}` };
}

/**
 * Selects memories whose KEY carries one of `tokens` (case-insensitive), in
 * token order then key order, each key once. Matching keys only (not values)
 * keeps a stray `+role+` inside a value from leaking that memory.
 * @param {Record<string, unknown>} memories key -> value (non-strings dropped)
 * @param {string[]} tokens e.g. ['+all+', '+orchestrator+']
 * @returns {Array<[string, string]>}
 */
export function selectScopedMemories(memories, tokens) {
    const out = [];
    const seen = new Set();
    for (const token of tokens) {
        const t = token.toLowerCase();
        for (const key of Object.keys(memories).sort()) {
            const value = memories[key];
            if (typeof value !== 'string' || seen.has(key)) continue;
            const scope = key.slice(0, key.indexOf('+:') + 1).toLowerCase();
            if (!scope || !scope.includes(t)) continue;
            seen.add(key);
            out.push([key, value]);
        }
    }
    return out;
}
