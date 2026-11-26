// Decides whether a click on a <summary> header should be swallowed so a
// drag-select that ends inside the header does not also toggle its <details>.
// Pure (no DOM globals) so it is unit-testable in node; the viewer page embeds
// this function's source verbatim (HTML_TEMPLATE in ./index.mjs), so the page
// and the tests run the same code. Keep it self-contained: no imports, no
// references to module scope, no backticks or template placeholders.
//
// selectionInfo: { isCollapsed, rangeCount, anchorNode, focusNode, keyboard }
//   keyboard is true for a click synthesized by Enter/Space (event.detail === 0);
//   keyboard toggling is never suppressed.
// header: the <summary> element (anything with .contains(node)).
export function shouldSuppressToggle(selectionInfo, header) {
    if (!selectionInfo || !header) return false;
    if (selectionInfo.keyboard) return false;
    if (selectionInfo.isCollapsed || !(selectionInfo.rangeCount > 0)) return false;
    const inHeader = (n) => !!n && typeof header.contains === 'function' && header.contains(n);
    return inHeader(selectionInfo.anchorNode) || inHeader(selectionInfo.focusNode);
}
