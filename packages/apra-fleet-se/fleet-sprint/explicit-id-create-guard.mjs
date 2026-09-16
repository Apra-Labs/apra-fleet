import fs from 'fs';
import path from 'path';
import { findCallSites, maskComments, skipStringLiteral } from './dispatch-safety-guard.mjs';
import { explicitIdCreateModulePaths, EXPLICIT_ID_CREATE_EXEMPT } from './guarded-modules.mjs';

// =============================================================================
// apra-fleet-btj9.7 -- explicit-id-create guard checker.
//
// Invariant under test: no scanned module may dispatch a bead-CREATION
// command (`bd create`, of ANY shape) unless it lives in beads-children.mjs
// -- the single module that pairs an explicit-id create with the
// probe-and-refuse seam (assertChildIdFree(), called from
// createChildBeadWithAllocatedId) that guards against `bd create`'s silent
// overwrite-on-collision behavior (apra-fleet-btj9). A second, unguarded
// bead-creation site anywhere else in this directory is exactly how that
// overwrite bug returns, so this is a mechanical scan -- same shape as the
// sibling guards -- rather than a call-graph proof that assertChildIdFree()
// actually ran first.
//
// -----------------------------------------------------------------------
// THE RULE, AND THE TWO WIDENINGS THAT PRODUCED IT
// -----------------------------------------------------------------------
//
// WIDENING 1 -- PAST "carries a literal --id flag" (review round on
// apra-fleet-btj9.7): the first cut of this guard matched `bd create` only
// when an explicit `--id` flag literal appeared LATER in the same balanced
// call text. That misses the one real call site's own shape --
// beads-children.mjs's `bd create "${title}" --body-file
// "${descriptionFile}" -p "${priority}" ${parentageFlags} --silent`, where
// the id flag is assembled into `parentageFlags` (`--id ${grant.childId}`)
// and never appears as literal text inside the command() call itself. A
// second, unguarded module that copied exactly that shape would scan clean
// under the literal-`--id` regex. Rather than chase every way an id flag can
// be assembled through a variable (an open-ended, unwinnable text-matching
// problem), the rule flags a bead-creation command regardless of whether an
// id flag is literal, interpolated, or absent entirely.
//
// WIDENING 2 -- PAST "inside a call spelled literally command(" (this bead,
// apra-fleet-btj9.4): the call-site rule below reuses findCallSites(), whose
// regex recognizes only the identifiers `command(` / `agent(` when not
// preceded by a dot or word character. So the effective rule WAS: a bead
// creation is only seen when it is dispatched from a call spelled literally
// `command(`. A module that routed the same command through ANY other
// wrapper -- a local `runBd` helper, a destructured or renamed binding, or a
// method call such as `ctx.command(...)` which the lookbehind deliberately
// excludes -- reintroduced an unguarded bead-creation site that this guard
// reported clean. Measured directly against the real checker before the fix:
// a fixture dispatching `bd create "${title}" --id ${id} --silent` through
// both a `runBd(...)` wrapper and a `ctx.command(...)` method call produced
// ZERO violations.
//
// HOW WIDENING 2 IS DONE, AND WHY NOT THE OBVIOUS WAY. The tempting fix is
// "flag the `bd create` token anywhere in the module, forget the enclosing
// call expression". That was MEASURED and rejected: across the 58 modules in
// the scanned set it produces 14 false positives, every one of them prose --
// LLM-prompt text in prompts.mjs / regression-test.mjs / newtask-text.mjs
// that instructs an agent about `bd create`, and log/reason strings in
// abort.mjs / review.mjs / re-review.mjs / final-review.mjs /
// sprint-report.mjs that merely NAME the command. A guard that needs a
// hand-maintained prose-exemption list of that size rots faster than the
// hole it closes.
//
// The discriminator this guard uses instead needs no exemption list: a
// DISPATCH is a command literal -- a string/template literal whose content
// BEGINS with `bd create` and continues into an ARGUMENT (a quoted value, a
// `${...}` interpolation, a `-` flag, or nothing left in the literal, i.e.
// the string-concatenation shape). Prose that merely mentions the command
// either does not begin with it ("...not sent to bd create") or continues
// into English words ("bd create failed (${stage})"). That rule is
// deliberately blind to the enclosing call expression, so it covers a
// wrapper, a renamed binding, a method call, and a call assembled at runtime
// alike -- which is why this guard does NOT instead try to pin the set of
// recognized dispatch-primitive identifiers: there is nothing left to
// enumerate. Measured: 0 hits across the whole scanned set, and it does
// catch beads-children.mjs's own real create when that file is offered
// directly (see the exemption note below).
//
// THE TWO RULES ARE A UNION, NOT A REPLACEMENT. The call-site rule is kept
// so that widening 2 strictly ADDS coverage: a command() call text whose
// `bd create` is NOT at the start of a literal -- for example
// `command(`cd ${dir} && bd create ...`)` -- was already flagged and still
// is. Violations are deduplicated across the two rules: a reported
// `command(...)` site claims its whole multi-line span, so the command
// literal nested inside it (which that violation already quotes in full) is
// not reported a second time.
//
// RESIDUAL LIMITS (known, accepted, measured -- not silent):
//   - A `bd create` that is neither inside a `command(`/`agent(` call nor at
//     the start of its own literal is not seen. Concretely: a non-command
//     wrapper handed `cd ${dir} && bd create ...`. Closing that would
//     require the prose-exemption list rejected above.
//   - A creation assembled from fragments that never spell `bd` and
//     `create` adjacently in any one literal (`bd ${verb}`) is not seen.
//     This is the same unwinnable text-matching frontier widening 1 already
//     declined to chase.
//   - This is a source-text scan over the registered module list, not a
//     call-graph proof; a create reached through a module that is not
//     registered in guarded-modules.mjs is out of scope by construction
//     (that list is what guarded-modules-coverage.test.mjs pins).
//   - NOT a limit, contrary to an earlier note on this bead: `bd` and
//     `create` split across a newline inside a template literal ARE matched,
//     because both rules join them with `\s+`, which matches a newline. This
//     was re-probed directly against the checker.
//
// CALL-SITE EXTRACTION REUSES dispatch-safety-guard.mjs's findCallSites()
// (that file's own header names it "the reference implementation the sibling
// guards follow"), rather than a naive per-line quote-stopping scan: a real
// `bd create "<title>" --body-file "<path>" --id <id> --silent` command
// literal has an inner quoted title BETWEEN "bd create" and the id flag, so a
// scan that stops at the first quote after "bd create" (the technique
// dolt-literal-guard.mjs/full-db-fetch-guard.mjs use, safe for THEIR simpler
// command shapes) would silently miss it. findCallSites() already extracts
// the FULL balanced call text -- including embedded quotes -- for every
// `command(`/`agent(` site, and already skips full-line comments and
// same-line-string false positives, so this guard reuses it rather than
// re-deriving that logic. The command-literal rule reuses the same module's
// maskComments()/skipStringLiteral() for the same reason -- comments are
// masked out before any literal is extracted, so the many prose mentions of
// `bd create` in this directory's comments (including this header) can never
// be read as dispatches.
//
// EXEMPTION: beads-children.mjs itself (EXPLICIT_ID_CREATE_EXEMPT), the
// single permitted surface -- scanning it would flag the module for being
// the module, same precedent as DOLT_LITERAL_EXEMPT/dolt-sync.mjs and
// UNBRACKETED_PUSH_EXEMPT/git-sync.mjs. (`agent(` call sites are still
// ignored by the call-site rule: agent() never dispatches a bd command. The
// command-literal rule has no such carve-out and does not need one.)
//
// MODULE-LIST GENERALIZATION: this guard is not pointed at a single
// hard-coded file. checkExplicitIdCreateModules() below reads the SHARED
// guarded-module list (./guarded-modules.mjs), filtered through
// EXPLICIT_ID_CREATE_EXEMPT, and defines no list of its own.
// checkExplicitIdCreatePath() remains exported and behaves exactly as
// before for a single file (a fixture, or beads-children.mjs itself when a
// caller deliberately wants its own violations, none expected).
// =============================================================================

// Matches a bead-creation subcommand ANYWHERE in the balanced call text --
// deliberately not conditioned on an explicit id flag appearing later (see
// "WIDENING 1" above): the one real call site assembles its id flag into an
// interpolated variable that never appears as literal `--id` text inside the
// command() call, so requiring a literal id flag would miss the exact shape a
// copy-paste of that site produces. Written as `bd` + `\s+` + `create`
// (never a literal space between the two tokens) so this guard's own
// definition line can never match itself.
const EXPLICIT_ID_CREATE_RE = /bd\s+create\b/;

// Matches a string/template literal's CONTENT when that content begins with
// the bead-creation command itself and continues into an argument (see
// "HOW WIDENING 2 IS DONE" above). The argument-start character class is
// written with hex escapes -- \x22 " , \x27 ' , \x60 ` -- rather than the
// characters themselves, because maskComments() does not model regex
// literals and would read a bare quote here as opening a string, corrupting
// this very file's masking.
const CREATE_DISPATCH_LITERAL_RE = /^\s*bd\s+create\s+(\x22|\x27|\x60|\$|-|$)/;

/**
 * Returns every string/template literal in `src` as { line, content }, with
 * comments masked out first (so prose mentions of a command inside a comment
 * are never extracted). Positions are computed against the masked copy,
 * which maskComments() guarantees is the same length and line numbering as
 * `src`.
 */
export function findCommandLiterals(src) {
    const masked = maskComments(src);
    const lineStarts = [];
    let offset = 0;
    for (const line of masked.split('\n')) {
        lineStarts.push(offset);
        offset += line.length + 1; // +1 for the '\n' stripped by split()
    }
    function lineNumberForIndex(idx) {
        let ln = 0;
        for (let i = 0; i < lineStarts.length; i++) {
            if (lineStarts[i] > idx) break;
            ln = i;
        }
        return ln + 1; // 1-based
    }
    const literals = [];
    for (let i = 0; i < masked.length; i++) {
        const ch = masked[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipStringLiteral(masked, i, ch);
            literals.push({ line: lineNumberForIndex(i), content: masked.slice(i + 1, end) });
            i = end;
        }
    }
    return literals;
}

/**
 * Scans `src` for bead-creation dispatches, as the UNION of two rules (see
 * the module header):
 *   1. call-site rule -- a `command(...)` call whose full balanced call text
 *      carries `bd create` in any shape;
 *   2. command-literal rule -- any string/template literal, ANYWHERE in the
 *      module and regardless of the enclosing call expression, whose content
 *      begins with `bd create` followed by an argument.
 * Returns an array of { line, rule, command }, one entry per violating line,
 * sorted by line.
 */
export function findExplicitIdCreateViolations(src) {
    const byLine = new Map();
    // Lines already accounted for by a reported call site, so the same
    // dispatch is not reported twice when both rules see it. A multi-line
    // `command(...)` call is claimed across its WHOLE span, not just its
    // opening line: the command literal inside it sits on a later line, and
    // the call-site violation already quotes that literal in full.
    const claimed = new Set();
    for (const site of findCallSites(src)) {
        if (site.fnName !== 'command') continue;
        if (!EXPLICIT_ID_CREATE_RE.test(site.callText)) continue;
        const span = (site.callText.match(/\n/g) || []).length;
        for (let ln = site.line; ln <= site.line + span; ln++) claimed.add(ln);
        if (byLine.has(site.line)) continue;
        byLine.set(site.line, {
            line: site.line,
            rule: 'command-call-site',
            command: site.callText.replace(/\s+/g, ' ').trim(),
        });
    }
    for (const literal of findCommandLiterals(src)) {
        if (!CREATE_DISPATCH_LITERAL_RE.test(literal.content)) continue;
        if (claimed.has(literal.line) || byLine.has(literal.line)) continue;
        byLine.set(literal.line, {
            line: literal.line,
            rule: 'command-literal',
            command: literal.content.replace(/\s+/g, ' ').trim(),
        });
    }
    return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * Reads and scans the source file at `filePath`, returning { violations },
 * each entry a human-readable message naming the offending file:line and
 * pointing at the single permitted surface.
 */
export function checkExplicitIdCreatePath(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const fileLabel = path.basename(filePath);
    const violations = findExplicitIdCreateViolations(src).map(({ line, rule, command }) =>
        `${fileLabel}:${line} issues a bead-creation command ("${command}", matched by the ${rule} rule) ` +
        'outside the single guarded probe-and-refuse seam -- route it through beads-children.mjs\'s ' +
        'assertChildIdFree() / createChildBeadWithAllocatedId, the only permitted bead-creation surface. ' +
        'Flagged regardless of whether an id flag is literal, interpolated, or absent, and regardless of ' +
        'the wrapper it is dispatched through (see this module\'s header).'
    );
    return { violations };
}

/**
 * Aggregate entry point: scans every module in the SHARED guarded-module list
 * (./guarded-modules.mjs), MINUS EXPLICIT_ID_CREATE_EXEMPT, and returns the
 * union of their violations. Follows checkDoltLiteralModules()/
 * checkUnbracketedPushModules() -- the reference implementations for a
 * single-permitted-surface exemption -- so a create call that moves out of
 * beads-children.mjs into a newly extracted module stays covered instead of
 * silently falling out of scan scope.
 *
 * @param {string[]} [paths]
 * @returns {{ violations: string[], files: string[], skipped: string[] }}
 */
export function checkExplicitIdCreateModules(paths = explicitIdCreateModulePaths()) {
    if (!Array.isArray(paths)) {
        throw new TypeError('checkExplicitIdCreateModules(paths): paths must be an array of file paths');
    }
    const violations = [];
    const files = [];
    const skipped = [];
    for (const p of paths) {
        const file = path.basename(p);
        if (EXPLICIT_ID_CREATE_EXEMPT.includes(file)) {
            skipped.push(file);
            continue;
        }
        files.push(file);
        violations.push(...checkExplicitIdCreatePath(p).violations);
    }
    return { violations, files, skipped };
}
