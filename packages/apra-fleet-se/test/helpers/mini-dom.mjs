// A minimal HTML tree + DOM subset for running a served dashboard page's own
// client scripts in a test. This repo has no jsdom/browser dependency; rather
// than asserting on HTML strings, this parses the real served markup into an
// element tree so a test can run the page's real functions (tab switching,
// extension renderers, form submit handlers) and ask DOM questions of the
// result: which elements exist, where they sit in the tree, and whether one is
// visible (no ancestor with display:none or an inactive .tab-content).
//
// Supported: getElementById, querySelector/querySelectorAll with simple
// compound selectors (tag, #id, .class, [attr], [attr=value], :checked),
// closest(), classList, style.display, innerHTML (setter re-parses),
// textContent, getAttribute, document.addEventListener/dispatchEvent.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

export function decodeEntities(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&middot;/g, '\u00b7').replace(/&amp;/g, '&');
}

function parseAttrs(src) {
    const attrs = {};
    const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = re.exec(src))) {
        attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return attrs;
}

class MiniElement {
    constructor(tag, attrs = {}, ownerDocument = null) {
        this.tagName = tag.toUpperCase();
        this.attrs = attrs;
        this.children = [];
        this.parent = null;
        this.text = '';
        this.value = tag === 'textarea' ? '' : (attrs.value ?? '');
        this.checked = 'checked' in attrs;
        this.ownerDocument = ownerDocument;
        const self = this;
        this.style = {};
        const styleAttr = attrs.style || '';
        const disp = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(styleAttr);
        if (disp) this.style.display = disp[1].trim();
        this.classList = {
            add(c) { const set = self._classes(); set.add(c); self.attrs.class = [...set].join(' '); },
            remove(c) { const set = self._classes(); set.delete(c); self.attrs.class = [...set].join(' '); },
            contains(c) { return self._classes().has(c); },
        };
    }
    _classes() { return new Set(String(this.attrs.class || '').split(/\s+/).filter(Boolean)); }
    get id() { return this.attrs.id || ''; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    appendChild(child) {
        // Text nodes are plain strings (no parent link needed).
        if (child instanceof MiniElement) child.parent = this;
        this.children.push(child);
        return child;
    }
    get textContent() {
        if (RAW_TEXT.has(this.tagName.toLowerCase())) return this.text;
        return this.children.map((c) => (c instanceof MiniElement ? c.textContent : decodeEntities(c))).join('');
    }
    set textContent(v) { this.children = [String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')]; }
    get innerHTML() { return this._innerHTML ?? ''; }
    set innerHTML(html) {
        this._innerHTML = String(html);
        this.children = [];
        parseInto(this, this._innerHTML, this.ownerDocument);
    }
    *descendants() {
        for (const c of this.children) {
            if (c instanceof MiniElement) { yield c; yield* c.descendants(); }
        }
    }
    querySelectorAll(selector) { return [...this.descendants()].filter((el) => matches(el, selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) {
        for (let el = this; el; el = el.parent) if (el instanceof MiniElement && matches(el, selector)) return el;
        return null;
    }
    /** Rendered unless it or an ancestor is display:none or an inactive tab panel. */
    isVisible() {
        for (let el = this; el && el instanceof MiniElement; el = el.parent) {
            if (el.style.display === 'none') return false;
            if (el.classList.contains('tab-content') && !el.classList.contains('active')) return false;
        }
        return true;
    }
}

function matches(el, selector) {
    const re = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:(checked)/g;
    let m; let consumed = 0;
    while ((m = re.exec(selector))) {
        if (m.index !== consumed) throw new Error(`mini-dom: unsupported selector ${selector}`);
        consumed = re.lastIndex;
        if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
        if (m[2] && el.id !== m[2]) return false;
        if (m[3] && !el.classList.contains(m[3])) return false;
        if (m[4]) {
            const v = el.getAttribute(m[4]);
            if (v === null) return false;
            const want = m[5] ?? m[6] ?? m[7];
            if (want !== undefined && v !== want) return false;
        }
        if (m[8] && !el.checked) return false;
    }
    if (consumed !== selector.length) throw new Error(`mini-dom: unsupported selector ${selector}`);
    return true;
}


const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isNameCh = (c) => c !== undefined && !isWs(c) && c !== '=' && c !== '/' && c !== '>';

/**
 * Linear-time open-tag scanner (replaces a nested-quantifier regex that could
 * backtrack exponentially on hostile input). Returns [whole, name, attrs,
 * selfClosingSlash] like the old regex exec result, or null when the text at
 * `i` is not a well-formed open tag.
 */
function matchOpenTag(html, i) {
    if (html[i] !== '<' || !/[a-zA-Z]/.test(html[i + 1] || '')) return null;
    let p = i + 2;
    while (p < html.length && /[a-zA-Z0-9-]/.test(html[p])) p++;
    const name = html.slice(i + 1, p);
    const attrsStart = p;
    let attrsEnd = p;
    for (;;) {
        let q = p;
        while (isWs(html[q])) q++;
        const c = html[q];
        if (c === '>') return [html.slice(i, q + 1), name, html.slice(attrsStart, attrsEnd), ''];
        if (c === '/' && html[q + 1] === '>') return [html.slice(i, q + 2), name, html.slice(attrsStart, attrsEnd), '/'];
        if (q === p || !isNameCh(c)) return null; // attributes need leading whitespace
        let r = q;
        while (isNameCh(html[r])) r++;
        p = r;
        let s = r;
        while (isWs(html[s])) s++;
        if (html[s] === '=') {
            s++;
            while (isWs(html[s])) s++;
            const quote = html[s];
            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, s + 1);
                if (close === -1) return null;
                p = close + 1;
            } else {
                let v = s;
                while (v < html.length && !isWs(html[v]) && html[v] !== '>') v++;
                if (v === s) return null;
                p = v;
            }
        }
        attrsEnd = p;
    }
}

function parseInto(root, html, doc) {
    const stack = [root];
    const top = () => stack[stack.length - 1];
    let i = 0;
    while (i < html.length) {
        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        if (html.startsWith('<!', i)) { i = html.indexOf('>', i) + 1; continue; }
        if (html.startsWith('</', i)) {
            const end = html.indexOf('>', i);
            const tag = html.slice(i + 2, end).trim().toLowerCase();
            for (let k = stack.length - 1; k > 0; k--) {
                if (stack[k].tagName.toLowerCase() === tag) { stack.length = k; break; }
            }
            i = end + 1;
            continue;
        }
        const open = matchOpenTag(html, i);
        if (open) {
            const tag = open[1].toLowerCase();
            const el = new MiniElement(tag, parseAttrs(open[2]), doc);
            top().appendChild(el);
            i += open[0].length;
            if (RAW_TEXT.has(tag)) {
                const close = html.toLowerCase().indexOf(`</${tag}`, i);
                const end = close === -1 ? html.length : close;
                el.text = html.slice(i, end);
                if (tag === 'textarea') el.value = decodeEntities(el.text);
                i = close === -1 ? html.length : html.indexOf('>', close) + 1;
            } else if (!VOID.has(tag) && !open[3]) {
                stack.push(el);
            }
            continue;
        }
        const next = html.indexOf('<', i + 1);
        const text = html.slice(i, next === -1 ? html.length : next);
        if (text) top().appendChild(text);
        i = next === -1 ? html.length : next;
    }
}

/** Parses a full HTML page into a document-like object. */
export function parseDocument(html) {
    const listeners = new Map();
    const doc = {
        getElementById(id) { return doc.root.querySelector('#' + id); },
        querySelectorAll(sel) { return doc.root.querySelectorAll(sel); },
        querySelector(sel) { return doc.root.querySelector(sel); },
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        dispatchEvent(ev) { for (const fn of listeners.get(ev.type) || []) fn(ev); return true; },
        /** Every <script> body in document order. */
        scripts() { return doc.root.querySelectorAll('script').map((s) => s.text); },
    };
    doc.root = new MiniElement('#document', {}, doc);
    parseInto(doc.root, html, doc);
    return doc;
}
