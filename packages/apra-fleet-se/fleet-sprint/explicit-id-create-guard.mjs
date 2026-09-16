import fs from 'fs';
import path from 'path';
import {
    findCallSites,
    maskComments,
    skipStringLiteral,
    canStartRegex,
    skipRegexLiteral,
} from './dispatch-safety-guard.mjs';
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
//   - The command-literal rule lexes JavaScript with a hand-written scanner
//     (scanModuleLiterals() below), so its grammar coverage has a frontier:
//     comments, regex literals (including character classes), strings, and
//     templates with nested `${...}` interpolations are modeled; anything
//     else that can open a literal is not. That frontier is deliberately NOT
//     silent -- see the DESYNC BACKSTOP note on scanModuleLiterals(): a
//     construct that provably desyncs the walk is reported as a loud
//     `parse-desync` violation naming the file and line, so a module this
//     guard cannot read fails it instead of passing it. Measured on the tree
//     as it stands: zero desyncs across the 58 scanned modules.
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
// re-deriving that logic.
//
// THE COMMAND-LITERAL RULE, BY CONTRAST, LEXES THE RAW SOURCE ITSELF
// (scanModuleLiterals() below) instead of walking a maskComments() copy. Its
// first cut did reuse maskComments()/skipStringLiteral(), on the same "do not
// re-derive it" reasoning -- and was measured SILENTLY BLIND over 867 lines
// of the real scanned set, because three ordinary constructs open a phantom
// string in a naive quote-walk: a regex body holding an apostrophe, a regex
// character class holding a quote, and a nested template inside a `${...}`
// interpolation (that last one desyncs maskComments() ITSELF, so it cannot
// be repaired downstream of it). The full account, naming the real modules
// that trigger each, is on scanModuleLiterals(). Comment spans are still
// never entered, so the many prose mentions of `bd create` in this
// directory's comments (including this header) are still never read as
// dispatches.
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
// characters themselves. That is belt-and-braces rather than load-bearing
// now: both this guard's own lexer and maskComments() model regex literals,
// so a bare quote inside this regex would no longer corrupt the scan of this
// very file (which IS in the guarded set). The escapes are kept because they
// cost nothing and keep the line safe for any SIMPLER scanner that does not
// model regex literals.
const CREATE_DISPATCH_LITERAL_RE = /^\s*bd\s+create\s+(\x22|\x27|\x60|\$|-|$)/;

// A raw (unescaped) newline inside a `'`/`"` literal. Such a literal is
// INVALID JavaScript -- only a template literal may span lines -- so seeing
// one means the scan's own notion of "where string literals begin and end"
// has desynced from the real source, and every line it swallowed is invisible
// to the command-literal rule below. Matched as: a newline preceded by an
// EVEN number of backslashes (zero counts), so a legitimate line
// continuation (`\` immediately before the newline) is not mistaken for one.
const RAW_NEWLINE_IN_QUOTED_LITERAL_RE = /(?:^|[^\\])(?:\\\\)*\n/;

/**
 * Walks `src` once and returns BOTH of the things the command-literal rule
 * needs:
 *   - `literals`: every string/template literal as { line, content }, in
 *     source order, with comment spans never entered (so prose mentions of a
 *     command inside a comment are never extracted);
 *   - `desyncs`: every position where the walk could not trust its own
 *     literal boundaries (see the DESYNC note in the module header).
 *
 * WHY THIS IS A LOCAL LEXER AND NOT maskComments() + skipStringLiteral()
 * (this bead's review round). The first cut of this rule extracted literals
 * by walking a maskComments() copy and calling skipStringLiteral() at every
 * quote. Measured against the real scanned set, that walk was SILENTLY BLIND:
 * 867 lines across 8 of the 58 scanned modules sat inside a phantom `'`/`"`
 * span, and injecting a real wrapper dispatch line by line showed 1085
 * injection points -- ordinary statements in function bodies, in abort.mjs,
 * member-sync.mjs, branch-ensure.mjs, newtask-text.mjs, contracts.mjs and
 * five more -- that this rule reported CLEAN and now reports. (The same
 * desync also had a false-POSITIVE direction, prose inside a phantom span
 * being read as a dispatch; that half was already closed upstream when
 * maskComments() learned about regex literals, and is pinned by
 * dispatch-safety-guard.test.mjs.) Three distinct constructs open a
 * "phantom string" that swallows source up to the next matching quote:
 *   1. a REGEX whose body holds a quote -- branch-ensure.mjs's
 *      `/couldn't find remote ref/i`. maskComments() copies a regex through
 *      VERBATIM (it is real code, not a comment), so the apostrophe inside
 *      it is still there for a naive quote-walk to trip over. Handled here by
 *      skipping regex spans with the SAME canStartRegex()/skipRegexLiteral()
 *      heuristic maskComments() used when it decided to copy that span.
 *   2. a CHARACTER CLASS holding a quote -- newtask-text.mjs's
 *      SAFE_TEXT_RE -- same cause, same fix.
 *   3. a NESTED TEMPLATE inside a `${...}` interpolation --
 *      vcs-providers/shell-helpers.mjs's
 *      shQuote (a `.replace()` whose arguments are themselves backtick
 *      literals). skipStringLiteral() has no notion of interpolation, so it
 *      ends the OUTER template at the INNER template's opening backtick and
 *      every boundary after that is off by one literal. This one desyncs
 *      maskComments() itself, so no amount of care in a walk built on its
 *      output can recover -- which is why the walk below lexes the raw source
 *      directly instead.
 * The call-site rule is unaffected by all three: it reads
 * extractBalancedCall(), which skips regex spans and only needs paren depth.
 *
 * DESYNC BACKSTOP. Lexing JavaScript with a hand-written scanner will always
 * have a frontier. So rather than trusting this one to be complete, it
 * reports the two constructs that PROVE it has lost the thread -- a
 * `'`/`"` literal carrying a raw newline, and an unterminated template --
 * as `desyncs`, which findExplicitIdCreateViolations() turns into a loud
 * violation. A guard that cannot parse a module must say so, not report it
 * clean.
 */
export function scanModuleLiterals(src) {
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '\n') lineStarts.push(i + 1);
    }
    const lineNumberForIndex = (idx) => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= idx) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1; // 1-based
    };

    const ctx = {
        literals: [],
        desyncs: [],
        // Code seen so far with comments blanked, ONLY so canStartRegex()'s
        // preceding-token heuristic sees the same thing it would have seen
        // inside maskComments(). Never scanned for content.
        code: '',
        lineNumberForIndex,
    };

    scanCodeSpan(src, 0, null, ctx);
    return { literals: ctx.literals, desyncs: ctx.desyncs };
}

/**
 * Scans a CODE region of `src` starting at `start`, recording every string /
 * template literal it contains (including inside nested `${...}`
 * interpolations) into `ctx`. When `stopAt` is `'}'` the scan is inside a
 * `${...}` interpolation and returns the index just past the `}` that closes
 * it, counting nested braces on the way; when `stopAt` is null it runs to end
 * of file. Returns the index it stopped at.
 */
function scanCodeSpan(src, start, stopAt, ctx) {
    let depth = 0;
    let i = start;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') { ctx.code += ' '; i++; }
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const close = src.indexOf('*/', i + 2);
            const stop = close < 0 ? src.length : close + 2;
            for (; i < stop; i++) ctx.code += src[i] === '\n' ? '\n' : ' ';
            continue;
        }
        if (ch === '/' && canStartRegex(ctx.code, ctx.code.length)) {
            const close = skipRegexLiteral(src, i);
            if (close !== -1) {
                let flagEnd = close;
                while (flagEnd + 1 < src.length && /[a-zA-Z]/.test(src[flagEnd + 1])) flagEnd++;
                ctx.code += src.slice(i, flagEnd + 1);
                i = flagEnd + 1;
                continue;
            }
            // No closing `/` before end of line: not a regex after all, so
            // fall through and treat it as an ordinary character.
        }
        if (ch === '"' || ch === "'") {
            const close = skipStringLiteral(src, i, ch);
            const content = src.slice(i + 1, close);
            if (RAW_NEWLINE_IN_QUOTED_LITERAL_RE.test(content)) {
                // Desync: do NOT consume the span. Consuming it is what makes
                // the blindness silent -- report it loudly and carry on from
                // the very next character so the rest of the module is still
                // examined rather than swallowed.
                ctx.desyncs.push({ line: ctx.lineNumberForIndex(i), detail: `a ${ch} string literal` });
                ctx.code += ' ';
                i++;
                continue;
            }
            ctx.literals.push({ line: ctx.lineNumberForIndex(i), content });
            ctx.code += src.slice(i, close + 1);
            i = close + 1;
            continue;
        }
        if (ch === '`') {
            i = scanTemplateLiteral(src, i, ctx);
            continue;
        }
        if (stopAt === '}') {
            if (ch === '{') depth++;
            else if (ch === '}') {
                if (depth === 0) { ctx.code += ch; return i + 1; }
                depth--;
            }
        }
        ctx.code += ch;
        i++;
    }
    return i;
}

/**
 * Scans the template literal opening at `start`, recording it (and anything
 * nested in its `${...}` interpolations) into `ctx`. Returns the index just
 * past the closing backtick. The recorded `content` is the RAW text between
 * the backticks, interpolations included, which is exactly what
 * CREATE_DISPATCH_LITERAL_RE wants to see: a dispatch's command text with its
 * `${...}` arguments still in place.
 */
function scanTemplateLiteral(src, start, ctx) {
    for (let i = start + 1; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '`') {
            ctx.literals.push({ line: ctx.lineNumberForIndex(start), content: src.slice(start + 1, i) });
            // Only a marker: ctx.code exists solely so canStartRegex() can see
            // what token precedes a `/`, and "a literal just ended" is all it
            // needs to know here.
            ctx.code += '`';
            return i + 1;
        }
        if (ch === '$' && src[i + 1] === '{') {
            // Recurse through the interpolation so a literal nested inside it
            // is seen, and so the OUTER template ends at the right backtick.
            // The parens bracket the interpolation in ctx.code so that a `/`
            // as its first token reads as a regex start, exactly as it would
            // after a real `(`.
            ctx.code += '(';
            i = scanCodeSpan(src, i + 2, '}', ctx) - 1;
            ctx.code += ')';
        }
    }
    // Unterminated template literal: another unambiguous desync tell, since
    // the rest of the file has just been swallowed by it.
    ctx.desyncs.push({ line: ctx.lineNumberForIndex(start), detail: 'a template literal' });
    return src.length;
}

/**
 * Convenience wrapper over scanModuleLiterals() for callers that only want
 * the literals. Kept as a named export because it is this guard's most
 * reusable primitive.
 */
export function findCommandLiterals(src) {
    return scanModuleLiterals(src).literals;
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
    const { literals, desyncs } = scanModuleLiterals(src);
    for (const literal of literals) {
        if (!CREATE_DISPATCH_LITERAL_RE.test(literal.content)) continue;
        if (claimed.has(literal.line) || byLine.has(literal.line)) continue;
        byLine.set(literal.line, {
            line: literal.line,
            rule: 'command-literal',
            command: literal.content.replace(/\s+/g, ' ').trim(),
        });
    }
    // Reported LAST and never deduplicated away: a desync is not a dispatch,
    // it is this scan admitting it could not read the module. Silently
    // returning "clean" for such a module is the exact failure mode this
    // guard exists to prevent.
    for (const desync of desyncs) {
        if (byLine.has(desync.line)) continue;
        byLine.set(desync.line, {
            line: desync.line,
            rule: 'parse-desync',
            command: desync.detail,
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
        rule === 'parse-desync'
            ? `${fileLabel}:${line} could not be scanned reliably: ${command} opens here and is never closed ` +
              'where the JavaScript grammar requires, which means this scan\'s literal boundaries have desynced ' +
              'from the real source and an unguarded bead-creation command could be hiding in the span it would ' +
              'otherwise have swallowed. This guard refuses to report a module it cannot parse as clean -- fix the ' +
              'construct that confuses the scan (see this module\'s DESYNC note), do not suppress this message.'
            : `${fileLabel}:${line} issues a bead-creation command ("${command}", matched by the ${rule} rule) ` +
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
