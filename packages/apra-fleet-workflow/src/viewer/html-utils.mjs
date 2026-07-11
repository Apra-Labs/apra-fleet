/**
 * Shared browser-side HTML-escaping helper (apra-fleet-unw.10, F9/A7-viewer).
 *
 * Single source of truth for escaping untrusted, LLM/bead-authored text
 * (activity labels/output, bead titles/descriptions, etc.) before it is
 * interpolated into `innerHTML` in the dashboard's client-side JS. Both the
 * core viewer template (`src/viewer/index.mjs`) and dashboard extensions
 * (e.g. `packages/apra-fleet-se/auto-sprint/viewer-extensions.mjs`) embed
 * this function's *source text* (via `escapeHtml.toString()`) directly into
 * the HTML page they generate -- the extensions run in the browser as plain
 * `<script>` tags, not as ES modules, so they cannot `import` this file at
 * runtime; `.toString()` is how a single implementation is shared without
 * duplicating the escaping logic by hand in every extension.
 *
 * This same function is also imported and unit-tested directly under Node
 * (see test/apra-fleet-workflow-viewer-lifecycle.test.mjs), so the escaping
 * behavior itself is verified independently of any browser/DOM environment.
 *
 * IMPORTANT: keep this as a `function` declaration (not an arrow function) --
 * `Function.prototype.toString()` on a named function declaration reproduces
 * a valid, directly-embeddable function declaration; an arrow function's
 * source text would not declare a hoisted `escapeHtml` binding the same way.
 */
export function escapeHtml(unsafe) {
    return (unsafe || '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
