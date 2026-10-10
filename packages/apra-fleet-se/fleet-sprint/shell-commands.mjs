import { parse } from 'unbash';

// =============================================================================
// Shell-command splitting for the permission heal (member-provisioning.mjs
// createPermissionDenialHeal).
//
// A refused Bash call is often a COMPOUND command -- a loop, an && / || / ;
// chain, a pipeline -- that no single permission rule matches even though each
// command inside it would be allowed on its own. This module parses such a
// call with a REAL shell parser (unbash: a maintained, dependency-free bash
// parser; never regex splitting) into the simple commands it would run, so
// the heal can decide whether each of them is within the member's composed
// policy.
//
// SECURITY: the result of this module is only ever used to DECIDE (nudge the
// member to run the commands one by one, or stop). It is never turned into a
// grant for a loop or compound prefix such as Bash(for:*), Bash(while:*),
// Bash(until:*), Bash(do:*) or a whole compound command string -- a
// loop-prefix grant would allow arbitrary loop bodies. Only grants for simple
// commands may ever be added, and only within the composed policy.
//
// Conservative by construction: any syntax this walker does not explicitly
// understand (functions, case, coproc, here-documents, arithmetic commands,
// parse errors, ...) makes the whole split fail, so an unknown construct can
// never hide a command from the policy check.
// =============================================================================

/**
 * Shell reserved words that open or continue a compound command. A grant
 * whose Bash payload begins with one of these would allow whatever body the
 * construct wraps, so it is never a grant the heal may send.
 */
export const SHELL_COMPOUND_KEYWORDS = Object.freeze([
    'for', 'while', 'until', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi',
    'case', 'esac', 'select', 'function', 'coproc', 'time', '{', '}', '(', ')', '!', '[[', ']]',
]);

/**
 * True when `grant` is a Bash grant whose payload starts with a shell
 * compound keyword (Bash(for:*), Bash(while true; do ...), ...) -- a grant
 * the permission heal must never produce.
 * @param {string} grant
 */
export function isCompoundShellGrant(grant) {
    const m = /^Bash\((.*)\)$/s.exec(String(grant || '').trim());
    if (!m) return false;
    const first = m[1].trim().split(/[\s:;(){}]/)[0];
    if (SHELL_COMPOUND_KEYWORDS.includes(first)) return true;
    // `(` / `{` glued to the next word: Bash((cd x && y)), Bash({ a; })
    return /^[({]/.test(m[1].trim());
}

class UnsupportedShellSyntax extends Error {}

/**
 * Splits a shell command line into the simple commands it would run.
 *
 * @param {string} commandLine
 * @returns {{ ok: true, compound: boolean, commands: string[] } | { ok: false, reason: string }}
 *   `commands` are the simple commands as `name arg...` (assignment prefixes
 *   and redirections dropped -- they are not part of what a permission rule
 *   matches), in source order, including commands nested in $(...) / `...`
 *   substitutions. `compound` is true when the line is anything other than
 *   ONE plain simple command (a loop, chain, pipeline, group or a nested
 *   substitution).
 */
export function splitShellCommands(commandLine) {
    if (typeof commandLine !== 'string' || commandLine.trim() === '') {
        return { ok: false, reason: 'empty command line' };
    }
    let ast;
    try {
        ast = parse(commandLine);
    } catch (err) {
        return { ok: false, reason: `the shell parser failed: ${err && err.message ? err.message : err}` };
    }
    if (ast && Array.isArray(ast.errors) && ast.errors.length > 0) {
        return { ok: false, reason: `the command does not parse: ${ast.errors.map((e) => e.message).join('; ')}` };
    }
    const commands = [];
    const state = { compound: false };
    try {
        walkScript(ast, commands, state);
    } catch (err) {
        if (err instanceof UnsupportedShellSyntax) return { ok: false, reason: err.message };
        throw err;
    }
    if (commands.length === 0) return { ok: false, reason: 'the command runs no simple command' };
    return { ok: true, compound: state.compound || commands.length > 1, commands };
}

function walkScript(script, out, state) {
    if (!script || !Array.isArray(script.commands)) throw new UnsupportedShellSyntax('unrecognised shell syntax tree');
    if (script.commands.length > 1) state.compound = true;
    for (const statement of script.commands) walkStatement(statement, out, state);
}

function walkStatement(statement, out, state) {
    if (!statement || statement.type !== 'Statement') {
        throw new UnsupportedShellSyntax(`unsupported shell construct '${statement && statement.type}'`);
    }
    if (statement.background) state.compound = true;
    walkNode(statement.command, out, state);
}

function walkList(list, out, state) {
    if (!list) return;
    if (list.type !== 'CompoundList' || !Array.isArray(list.commands)) {
        throw new UnsupportedShellSyntax(`unsupported shell construct '${list.type}'`);
    }
    for (const statement of list.commands) walkStatement(statement, out, state);
}

function walkNode(node, out, state) {
    if (!node) throw new UnsupportedShellSyntax('empty shell construct');
    switch (node.type) {
        case 'Command':
            walkSimpleCommand(node, out, state);
            return;
        case 'AndOr':
        case 'Pipeline':
            state.compound = true;
            for (const c of node.commands || []) walkNode(c, out, state);
            return;
        case 'For':
            state.compound = true;
            for (const w of node.wordlist || []) walkWord(w, out, state);
            walkList(node.body, out, state);
            return;
        case 'While':
            state.compound = true;
            walkList(node.clause, out, state);
            walkList(node.body, out, state);
            return;
        case 'If':
            state.compound = true;
            walkList(node.clause, out, state);
            walkList(node.then, out, state);
            if (node.else) {
                if (node.else.type === 'If') walkNode(node.else, out, state);
                else walkList(node.else, out, state);
            }
            return;
        case 'Redirected':
            for (const r of node.redirects || []) walkItem(r, out, state);
            walkNode(node.command, out, state);
            return;
        case 'Subshell':
        case 'BraceGroup':
            state.compound = true;
            walkList(node.body, out, state);
            return;
        default:
            throw new UnsupportedShellSyntax(`unsupported shell construct '${node.type}'`);
    }
}

function walkSimpleCommand(cmd, out, state) {
    for (const item of cmd.prefix || []) walkItem(item, out, state);
    for (const item of cmd.suffix || []) walkItem(item, out, state);
    if (!cmd.name) return; // a bare assignment / redirection runs no command
    walkWord(cmd.name, out, state);
    const words = [cmd.name, ...(cmd.suffix || []).filter((w) => w && w.type === 'Word')];
    out.push(words.map((w) => w.text).join(' '));
}

function walkItem(item, out, state) {
    if (!item) return;
    if (item.type === 'Word') return walkWord(item, out, state);
    if (item.type === 'Assignment') {
        if (item.value && item.value.type === 'Word') walkWord(item.value, out, state);
        else if (item.value) throw new UnsupportedShellSyntax('unsupported array assignment');
        return;
    }
    if (item.type === 'Redirect') {
        if (item.target) walkWord(item.target, out, state);
        return;
    }
    throw new UnsupportedShellSyntax(`unsupported shell construct '${item.type}'`);
}

// Words can hide whole scripts: $(...) / `...` command substitutions and
// <(...) process substitutions run commands of their own, so they are walked
// and their commands checked like any other.
function walkWord(word, out, state) {
    if (!word) return;
    for (const part of word.parts || []) walkPart(part, out, state);
}

function walkPart(part, out, state) {
    if (!part) return;
    switch (part.type) {
        case 'Literal':
        case 'SingleQuoted':
        case 'SimpleExpansion':
        case 'AnsiCQuoted':
        case 'LocaleString':
            return;
        case 'ParameterExpansion':
            // Plain ${name} only: an index or an operation (${x:-$(cmd)},
            // ${a[$(cmd)]}) can carry nested commands.
            if (part.index || part.operation || part.prefix) {
                throw new UnsupportedShellSyntax(`unsupported parameter expansion '${part.text}'`);
            }
            return;
        case 'DoubleQuoted':
            for (const p of part.parts || []) walkPart(p, out, state);
            return;
        case 'CommandExpansion':
        case 'ProcessSubstitution':
            state.compound = true;
            if (!part.script) throw new UnsupportedShellSyntax('unparsed command substitution');
            walkScript(part.script, out, state);
            return;
        default:
            throw new UnsupportedShellSyntax(`unsupported shell expansion '${part.type}'`);
    }
}
