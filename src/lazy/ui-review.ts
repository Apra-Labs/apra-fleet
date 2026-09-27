/**
 * Code changes tab: a review tool for the sprint's diff. File tree with viewed
 * marks, unified or split diff with syntax colors and word-level changes,
 * more context on demand, comments on a line or a dragged/selected range,
 * threads with replies, edits, suggestions and resolve, and a live view that
 * follows new commits as helpers land work. Sending comments files them as
 * tasks in the sprint's own task list (or starts a follow-up sprint). All of
 * it is local git and bd behind the lazyfleet server; nothing goes to GitHub.
 * Runs inside the SPRINTS_JS closure. String.raw: never put a backtick or
 * dollar-brace in here (write \x60 for a backtick).
 */

export const REVIEW_CSS = String.raw`
.rv { display: flex; flex-direction: column; gap: 10px; }
.rv [hidden], .jb [hidden], .rv-float[hidden] { display: none !important; }
.rv-top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rv-top .grow { flex: 1; }
.rv-top .sum { font-size: 13px; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rv-top .sum b { color: var(--ink); }
.rv-live { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ok); font-weight: 600; }
.rv-live i { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 1.6s infinite; }
.rv-top select { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 13px; max-width: 260px; }
.rv-banner { background: color-mix(in srgb, #2684ff 11%, var(--panel)); border: 1px solid color-mix(in srgb, #2684ff 40%, var(--line)); border-radius: 10px; padding: 9px 12px; font-size: 13.5px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.rv-banner .grow { flex: 1; min-width: 200px; }
.rv-banner.ok { background: color-mix(in srgb, var(--ok) 10%, var(--panel)); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
.rv-grid { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 960px) { .rv-grid { grid-template-columns: 1fr; } }
.rv-side { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; position: sticky; top: 8px; max-height: calc(100vh - 24px); display: flex; flex-direction: column; }
@media (max-width: 960px) { .rv-side { position: static; max-height: 360px; } }
.rv-stabs { display: flex; border-bottom: 1px solid var(--line); }
.rv-stabs button { flex: 1; background: none; border: 0; border-bottom: 2px solid transparent; padding: 9px 6px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer; }
.rv-stabs button.on { color: var(--ink); border-color: var(--accent); font-weight: 600; }
.rv-stabs .n { background: var(--chip); border-radius: 999px; padding: 0 6px; font-size: 11px; margin-left: 4px; }
.rv-sbody { overflow: auto; flex: 1; }
.rv-filter { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line); align-items: center; }
.rv-filter input, .rv-filter select { flex: 1; min-width: 0; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 12.5px; }
.rv-prog { padding: 8px 10px; font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 5px; border-bottom: 1px solid var(--line); }
.rv-tree { padding: 4px 0; }
.rv-dir { display: flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 12.5px; color: var(--muted); cursor: pointer; user-select: none; font-family: var(--mono); }
.rv-dir:hover { color: var(--ink); }
.rv-f { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; background: none; border: 0; padding: 5px 10px; font: inherit; font-size: 12.5px; color: var(--ink); cursor: pointer; }
.rv-f:hover { background: var(--chip); }
.rv-f.on { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
.rv-f.viewed .nm { color: var(--muted); }
.rv-f .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12px; }
.rv-f .st { font-family: var(--mono); font-size: 10.5px; font-weight: 800; width: 12px; text-align: center; }
.rv-f .st.D { color: var(--bad); } .rv-f .st.M { color: var(--warn); } .rv-f .st.A { color: var(--ok); }
.rv-f .dot { width: 7px; height: 7px; border-radius: 50%; background: #2684ff; flex: none; }
.rv-f .cb { background: var(--accent); color: var(--accent-ink); border-radius: 999px; font-size: 10.5px; padding: 0 6px; font-weight: 700; }
.rv-f .ck { color: var(--ok); font-size: 11px; font-weight: 700; }
.plus { color: var(--ok); font-family: var(--mono); font-size: 11.5px; } .minus { color: var(--bad); font-family: var(--mono); font-size: 11.5px; }
.rv-cm { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); padding: 8px 10px; font: inherit; font-size: 12.5px; color: var(--ink); cursor: pointer; }
.rv-cm:hover { background: var(--chip); }
.rv-cm .loc { font-family: var(--mono); font-size: 11.5px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.rv-cm .ex { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rv-co { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); padding: 8px 10px; font: inherit; font-size: 12.5px; color: var(--ink); cursor: pointer; }
.rv-co:hover, .rv-co.on { background: var(--chip); }
.rv-co .meta { color: var(--muted); font-size: 11.5px; display: flex; gap: 6px; }

.rv-pane { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; min-width: 0; overflow: hidden; }
.rv-scroll { max-height: calc(100vh - 24px); overflow: auto; }
.rv-fh { position: sticky; top: 0; z-index: 3; background: var(--panel); border-bottom: 1px solid var(--line); padding: 8px 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.rv-fh .path { font-family: var(--mono); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.rv-fh .grow { flex: 1; }
.rv-fh label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; cursor: pointer; border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; }
.rv-fh label.on { background: color-mix(in srgb, var(--ok) 12%, transparent); border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
.rv-note { padding: 10px 14px; font-size: 13px; color: var(--muted); border-bottom: 1px solid var(--line); }
.rv-ph { padding: 40px 20px; color: var(--muted); text-align: center; }
.rv-rows { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
.dl { display: grid; grid-template-columns: 48px 48px 22px minmax(0, 1fr); position: relative; }
.dl .g { color: var(--muted); text-align: right; padding: 0 8px 0 0; user-select: none; cursor: pointer; font-size: 11.5px; opacity: .75; }
.dl .gs { user-select: none; text-align: center; color: var(--muted); position: relative; }
.dl .code { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: 12px; min-width: 0; }
.dl.add { background: color-mix(in srgb, var(--ok) 11%, transparent); }
.dl.add .g, .dl.add .gs { background: color-mix(in srgb, var(--ok) 16%, transparent); }
.dl.del { background: color-mix(in srgb, var(--bad) 10%, transparent); }
.dl.del .g, .dl.del .gs { background: color-mix(in srgb, var(--bad) 15%, transparent); }
.dl .wd { border-radius: 2px; }
.dl.add .wd { background: color-mix(in srgb, var(--ok) 30%, transparent); }
.dl.del .wd { background: color-mix(in srgb, var(--bad) 28%, transparent); }
.dl.hunk { background: color-mix(in srgb, #2684ff 8%, transparent); color: var(--muted); }
.dl.hunk .code { padding: 3px 0; }
.dl.gap { background: color-mix(in srgb, #2684ff 6%, var(--chip)); color: var(--muted); font-family: inherit; }
.dl.gap .code { display: flex; gap: 12px; padding: 4px 0; font-family: system-ui, sans-serif; font-size: 12px; flex-wrap: wrap; }
.dl.gap button { background: none; border: 0; color: #2270e0; cursor: pointer; font: inherit; padding: 0; }
.dl.gap button:hover { text-decoration: underline; }
.dl.sel, .dh.sel { box-shadow: inset 3px 0 0 #d4a300; }
.dl.sel .code, .dl.sel .g, .dh.sel .code, .dh.sel .g { background: color-mix(in srgb, #ffd23f 28%, transparent); }
.dl .add-c, .dh .add-c { position: absolute; left: -2px; top: 1px; width: 20px; height: 18px; border-radius: 5px; border: 0; background: #2684ff; color: #fff; font-weight: 800; font-size: 14px; line-height: 16px; cursor: pointer; display: none; z-index: 1; padding: 0; }
.rv-rows.can .dl.cmt:hover .add-c, .rv-rows.can .dh.cmt:hover .add-c { display: block; }
.dl2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.dh { display: grid; grid-template-columns: 44px 22px minmax(0, 1fr); position: relative; min-width: 0; }
.dh + .dh { border-left: 1px solid var(--line); }
.dh.add { background: color-mix(in srgb, var(--ok) 11%, transparent); }
.dh.del { background: color-mix(in srgb, var(--bad) 10%, transparent); }
.dh.none { background: color-mix(in srgb, var(--chip) 60%, transparent); }
.dh .g { color: var(--muted); text-align: right; padding-right: 8px; user-select: none; cursor: pointer; font-size: 11.5px; opacity: .75; }
.dh .gs { user-select: none; text-align: center; color: var(--muted); position: relative; }
.dh .code { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: 10px; min-width: 0; }
.dh.add .wd { background: color-mix(in srgb, var(--ok) 30%, transparent); }
.dh.del .wd { background: color-mix(in srgb, var(--bad) 28%, transparent); }
.tk-c { color: #6a737d; font-style: italic; }
.tk-s { color: #0a7d32; }
.tk-n { color: #b35c00; }
.tk-k { color: #b0167a; font-weight: 600; }
.tk-t { color: #1f5fbf; }
:root[data-theme="dark"] .tk-s { color: #7ee2a0; } :root[data-theme="dark"] .tk-n { color: #ffb86b; } :root[data-theme="dark"] .tk-k { color: #ff8fd0; } :root[data-theme="dark"] .tk-t { color: #8ab8ff; } :root[data-theme="dark"] .tk-c { color: #8b949e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .tk-s { color: #7ee2a0; } :root:not([data-theme="light"]) .tk-n { color: #ffb86b; } :root:not([data-theme="light"]) .tk-k { color: #ff8fd0; } :root:not([data-theme="light"]) .tk-t { color: #8ab8ff; } :root:not([data-theme="light"]) .tk-c { color: #8b949e; } }

.rv-th, .rv-comp { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13.5px; line-height: 1.5; margin: 6px 12px 8px 60px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 1px 3px color-mix(in srgb, var(--ink) 10%, transparent); overflow: hidden; }
@media (max-width: 640px) { .rv-th, .rv-comp { margin-left: 8px; } }
.rv-th.flash { animation: flash 1.6s; }
@keyframes flash { 0%, 40% { box-shadow: 0 0 0 3px #ffd23f; } 100% { box-shadow: 0 1px 3px transparent; } }
.rv-th-head { display: flex; gap: 6px; align-items: center; padding: 6px 10px; background: color-mix(in srgb, var(--chip) 60%, transparent); border-bottom: 1px solid var(--line); flex-wrap: wrap; font-size: 12.5px; }
.rv-th-head .grow { flex: 1; }
.rv-th-head button, .rv-comp button, .rv-c .acts button { font-size: 12.5px; padding: 3px 9px; }
.rv-th.resolved .rv-th-head { background: color-mix(in srgb, var(--ok) 8%, transparent); }
.rv-badge { border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
.rv-badge.out { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.rv-badge.mv { background: color-mix(in srgb, #2684ff 15%, transparent); color: #2270e0; }
.rv-badge.res { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
.rv-badge.sent { background: color-mix(in srgb, #904ee2 16%, transparent); color: #7c3aed; }
.rv-c { display: flex; gap: 10px; padding: 9px 12px; }
.rv-c + .rv-c { border-top: 1px solid var(--line); }
.rv-c .av { width: 26px; height: 26px; font-size: 10px; }
.rv-c .bd { flex: 1; min-width: 0; }
.rv-c .who { font-size: 12.5px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.rv-c .who span { color: var(--muted); font-size: 12px; }
.rv-c .acts { margin-left: auto; display: flex; gap: 4px; }
.rv-c .acts button { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 0 4px; }
.rv-c .acts button:hover { color: var(--ink); text-decoration: underline; }
.rv-c.sys { background: color-mix(in srgb, var(--ok) 6%, transparent); }
.md { overflow-wrap: anywhere; }
.md .p { white-space: pre-wrap; }
.md code { background: var(--chip); border-radius: 4px; padding: 0 4px; font-size: 12px; }
.md pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 6px 0; white-space: pre-wrap; font-size: 12px; overflow-wrap: anywhere; }
.sugg { border: 1px solid var(--line); border-radius: 6px; margin: 6px 0; overflow: hidden; font-family: var(--mono); font-size: 12px; }
.sugg > div:first-child { font-family: system-ui, sans-serif; font-size: 12px; font-weight: 600; padding: 4px 8px; background: var(--chip); border-bottom: 1px solid var(--line); }
.sugg .l { white-space: pre-wrap; padding: 0 8px; overflow-wrap: anywhere; }
.sugg .l.d { background: color-mix(in srgb, var(--bad) 12%, transparent); }
.sugg .l.a { background: color-mix(in srgb, var(--ok) 13%, transparent); }
.rv-reply { padding: 8px 12px; border-top: 1px solid var(--line); background: color-mix(in srgb, var(--chip) 35%, transparent); }
.rv-reply .fake { width: 100%; text-align: left; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; color: var(--muted); font: inherit; font-size: 13px; cursor: text; }
.rv-ta { width: 100%; min-height: 76px; resize: vertical; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 13.5px; box-sizing: border-box; }
.rv-ta:focus { outline: 2px solid color-mix(in srgb, #2684ff 55%, transparent); border-color: #2684ff; }
.rv-bar { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.rv-bar .grow { flex: 1; }
.rv-bar .hint { font-size: 11.5px; color: var(--muted); }
.rv-comp { padding: 10px 12px; border-color: #2684ff; }
.rv-comp .what { font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
.rv-else { border-bottom: 1px solid var(--line); padding: 8px 0 4px; background: color-mix(in srgb, var(--warn) 5%, transparent); }
.rv-else > div:first-child { padding: 0 14px 4px; font-size: 12.5px; color: var(--muted); font-weight: 600; }
.rv-else .rv-th { margin-left: 12px; }
.rv-snip { font-family: var(--mono); font-size: 12px; background: var(--bg); border-bottom: 1px solid var(--line); padding: 4px 10px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 140px; overflow: auto; color: var(--muted); }
.rv-float { position: fixed; z-index: 25; background: #2684ff; color: #fff; border: 0; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px color-mix(in srgb, #000 25%, transparent); }
.rv-cfile { border-bottom: 1px solid var(--line); }
.rv-cfile > .rv-fh { position: static; }
.rv-chead { padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 13.5px; }
.rv-chead .mono { color: var(--muted); font-size: 12px; }
.rv .muted { color: var(--muted); }
.chg { font-size: 10.5px; font-weight: 700; color: #2270e0; background: color-mix(in srgb, #2684ff 12%, transparent); border-radius: 4px; padding: 0 5px; }
.rv-cm.on { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
.jb-seg button:disabled { opacity: .45; cursor: default; }
`;

export const REVIEW_JS = String.raw`
  // ---- code review -----------------------------------------------------------
  var BT = '\x60';
  var KW = {};
  ('abstract as async await break case catch class const continue def default defer del delete do elif else enum except export extends false final finally fn for from func function go if impl implements import in instanceof interface is lambda let match mod module mut namespace new nil none null of or and not package pass private protected pub public raise readonly return self static struct super switch this throw throws trait true try type typeof undefined use var void where while with yield None True False').split(' ').forEach(function (w) { KW[w] = 1; });
  var HASH_LANG = { py: 1, rb: 1, sh: 1, bash: 1, zsh: 1, fish: 1, yml: 1, yaml: 1, toml: 1, pl: 1, r: 1, conf: 1, ini: 1, cfg: 1, mk: 1, dockerfile: 1, makefile: 1, gitignore: 1, env: 1, nix: 1, cmake: 1 };
  var DASH_LANG = { sql: 1, lua: 1, hs: 1 };
  var PLAIN_LANG = { md: 1, markdown: 1, txt: 1, rst: 1, csv: 1, log: 1, lock: 1, svg: 1, html: 0 };
  var RE_STR = '"(?:[^"\\\\\\n]|\\\\.)*"?|\'(?:[^\'\\\\\\n]|\\\\.)*\'?|' + BT + '(?:[^' + BT + '\\\\]|\\\\.)*' + BT + '?';
  var RE_TAIL = '|(' + RE_STR + ')|(\\b\\d[\\w.]*\\b)|(\\b[A-Za-z_$][\\w$]*\\b)';
  var TOK = {
    c: new RegExp('(\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$))' + RE_TAIL, 'g'),
    hash: new RegExp('(#.*$)' + RE_TAIL, 'g'),
    dash: new RegExp('(--.*$)' + RE_TAIL, 'g')
  };
  function langOf(file) {
    var b = base(file).toLowerCase();
    var ext = b.indexOf('.') === -1 ? b : b.split('.').pop();
    if (PLAIN_LANG[ext]) return null;
    if (HASH_LANG[ext]) return 'hash';
    if (DASH_LANG[ext]) return 'dash';
    return 'c';
  }
  // [start, end, class] pieces covering the line.
  function tokens(text, lang) {
    var out = [];
    if (!lang || text.length > 2000) return [[0, text.length, '']];
    var re = TOK[lang], m, last = 0;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      var cls = m[1] ? 'tk-c' : m[2] ? 'tk-s' : m[3] ? 'tk-n' : m[4] ? (KW[m[4]] ? 'tk-k' : /^[A-Z][a-z]/.test(m[4]) ? 'tk-t' : '') : '';
      if (!cls) continue;
      if (m.index > last) out.push([last, m.index, '']);
      out.push([m.index, m.index + m[0].length, cls]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push([last, text.length, '']);
    return out;
  }
  function codeEl(text, lang, wd) {
    var c = el('span', { cls: 'code' });
    if (!text) { c.textContent = ' '; return c; }
    tokens(text, lang).forEach(function (p) {
      var cuts = [p[0], p[1]];
      if (wd) { if (wd[0] > p[0] && wd[0] < p[1]) cuts.push(wd[0]); if (wd[1] > p[0] && wd[1] < p[1]) cuts.push(wd[1]); }
      cuts.sort(function (a, z) { return a - z; });
      for (var i = 0; i + 1 < cuts.length; i++) {
        var s = cuts[i], e = cuts[i + 1];
        if (e <= s) continue;
        var inWd = wd && s >= wd[0] && e <= wd[1];
        var cls = (p[2] ? p[2] : '') + (inWd ? ' wd' : '');
        if (cls.trim()) c.appendChild(el('span', { cls: cls.trim(), text: text.slice(s, e) }));
        else c.appendChild(document.createTextNode(text.slice(s, e)));
      }
    });
    return c;
  }
  // The changed middle of a changed line, when the rest of it stayed the same.
  function wordDiff(a, b) {
    var p = 0, max = Math.min(a.length, b.length);
    while (p < max && a.charAt(p) === b.charAt(p)) p++;
    var s = 0;
    while (s < max - p && a.charAt(a.length - 1 - s) === b.charAt(b.length - 1 - s)) s++;
    if (p + s < Math.max(a.length, b.length) * 0.3) return null;
    // Snap to whole words, so a change never starts or ends mid-word.
    var w = /[A-Za-z0-9_$]/;
    while (p > 0 && w.test(a.charAt(p - 1)) && w.test(a.charAt(p))) p--;
    while (s > 0 && w.test(a.charAt(a.length - s)) && w.test(a.charAt(a.length - s - 1))) s--;
    while (s > 0 && w.test(b.charAt(b.length - s)) && w.test(b.charAt(b.length - s - 1))) s--;
    return [[p, a.length - s], [p, b.length - s]];
  }
  function pairWords(rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].k !== 'del') continue;
      var j = i; while (j < rows.length && rows[j].k === 'del') j++;
      var k = j; while (k < rows.length && rows[k].k === 'add') k++;
      for (var x = 0; x < Math.min(j - i, k - j); x++) {
        var w = wordDiff(rows[i + x].t, rows[j + x].t);
        if (w) { rows[i + x].wd = w[0]; rows[j + x].wd = w[1]; }
      }
      i = k - 1;
    }
    return rows;
  }

  function mdEl(text, anchor) {
    var box = el('div', { cls: 'md' });
    var re = new RegExp(BT + BT + BT + '(\\w*)\\n([\\s\\S]*?)' + BT + BT + BT, 'g');
    var last = 0, m;
    function inline(s) {
      s = s.replace(/^\n+|\n+$/g, '');
      if (!s) return;
      var p = el('div', { cls: 'p' });
      s.split(new RegExp('(' + BT + '[^' + BT + '\\n]+' + BT + '|\\*\\*[^*\\n]+\\*\\*)')).forEach(function (part) {
        if (!part) return;
        if (part.charAt(0) === BT && part.length > 2) p.appendChild(el('code', { text: part.slice(1, -1) }));
        else if (part.indexOf('**') === 0 && part.length > 4) p.appendChild(el('b', { text: part.slice(2, -2) }));
        else p.appendChild(document.createTextNode(part));
      });
      box.appendChild(p);
    }
    while ((m = re.exec(text))) {
      inline(text.slice(last, m.index));
      var body = m[2].replace(/\n$/, '');
      if (m[1] === 'suggestion') {
        var s = el('div', { cls: 'sugg' }, [el('div', { text: 'Suggested change' })]);
        (anchor || []).forEach(function (l) { s.appendChild(el('div', { cls: 'l d', text: '- ' + l })); });
        body.split('\n').forEach(function (l) { s.appendChild(el('div', { cls: 'l a', text: '+ ' + l })); });
        box.appendChild(s);
      } else box.appendChild(el('pre', { text: body }));
      last = re.lastIndex;
    }
    inline(text.slice(last));
    return box;
  }

  function reviewComp(runId) {
    var P = 'sprints/' + encodeURIComponent(runId) + '/';
    var R = { code: null, rv: null, file: null, mode: 'all', since: null, commit: null, diff: null, cdiff: null, err: null, sel: null, drag: null, comp: null, drafts: {}, replying: {}, editing: {}, showRes: {}, exp: {}, lines: {}, prevSeen: null, tab: 'files', cfilter: 'open', ffilter: '', banner: null, busy: false, started: false, closedDirs: {}, live: false, rowText: {} };
    try { R.layout = localStorage.getItem('lazy.diffLayout') === 'split' ? 'split' : 'unified'; } catch (e) { R.layout = 'unified'; }
    var viewedKey = 'lazy.viewed.' + runId;
    function viewedMap() { try { return JSON.parse(localStorage.getItem(viewedKey) || '{}'); } catch (e) { return {}; } }
    function isViewed(f) { return !!f && viewedMap()[f.path] === f.blob; }
    function setViewed(f, on) { var v = viewedMap(); if (on) v[f.path] = f.blob; else delete v[f.path]; try { localStorage.setItem(viewedKey, JSON.stringify(v)); } catch (e) {} }

    var top = el('div', { cls: 'rv-top' });
    var banner = el('div', { cls: 'rv-banner', hidden: true });
    var side = el('div', { cls: 'rv-side' });
    var pane = el('div', { cls: 'rv-pane' });
    var floatBtn = el('button', { cls: 'rv-float', type: 'button', hidden: true });
    var wrap = el('div', { cls: 'rv' }, [top, banner, el('div', { cls: 'rv-grid' }, [side, pane]), floatBtn]);

    function fileByPath(p) { return R.code && R.code.files ? R.code.files.filter(function (f) { return f.path === p; })[0] : null; }
    // In "since" mode the numbers are for that range only.
    function statOf(f) { var st = R.mode === 'since' && R.code.sinceStats ? R.code.sinceStats[f.path] : null; return st || f; }
    function threadsFor(file) { return R.rv ? R.rv.threads.filter(function (t) { return t.file === file; }) : []; }
    function openCount(file) { return threadsFor(file).filter(function (t) { return t.status === 'open'; }).length; }
    function validSince(sha) { var c = R.code; return !!(sha && c && c.available && (sha === c.mergeBase || c.commits.some(function (x) { return x.sha === sha; }))); }
    function dirOf(p) { var i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }
    function treeOrder(list) {
      return list.slice().sort(function (a, z) { var da = dirOf(a.path), dz = dirOf(z.path); return da === dz ? a.path.localeCompare(z.path) : da.localeCompare(dz); });
    }
    function visibleFiles() {
      var c = R.code; if (!c || !c.available) return [];
      var list = treeOrder(c.files);
      if (R.mode === 'since' && c.changedSince) list = list.filter(function (f) { return c.changedSince.indexOf(f.path) !== -1; });
      if (R.ffilter) { var q = R.ffilter.toLowerCase(); list = list.filter(function (f) { return f.path.toLowerCase().indexOf(q) !== -1; }); }
      return list;
    }
    function canComment(sideName) {
      if (R.mode === 'commit' || !R.diff || !R.rv || R.rv.err) return false;
      if (R.mode === 'since') return sideName === 'new';
      return true;
    }

    // ---- loading -------------------------------------------------------------
    function loadCode() {
      var s = R.mode === 'since' ? R.since : R.prevSeen;
      return api(P + 'code' + (s ? '?since=' + s : '')).then(function (c) {
        R.code = c; S.code = c;
        if (R.prevSeen && !validSince(R.prevSeen)) R.prevSeen = null;
        var list = visibleFiles();
        if (!R.file || !list.some(function (f) { return f.path === R.file; })) {
          var first = list.filter(function (f) { return !isViewed(f) && f.blob !== 'deleted'; })[0] || list[0];
          R.file = first ? first.path : null; R.diff = null;
        }
      });
    }
    function loadDiff() {
      R.err = null;
      if (R.mode === 'commit') {
        var sha = R.commit;
        return api(P + 'code/commit/' + sha).then(function (d) { if (R.commit === sha) { R.cdiff = d; drawPane(); } }).catch(function (e) { R.err = e.message; drawPane(); });
      }
      if (!R.file) { R.diff = null; drawPane(); return Promise.resolve(); }
      linkFile();
      var f = R.file, key = f + '|' + R.mode + '|' + (R.since || '') + '|' + (R.code && R.code.head);
      R.loading = key;
      if (!R.diff || R.diff.file !== f) { R.diff = null; drawPane(); }
      return api(P + 'code/file?path=' + encodeURIComponent(f) + (R.mode === 'since' && R.since ? '&since=' + R.since : '')).then(function (d) {
        if (R.loading !== key) return;
        d.file = f; R.diff = d;
        var lk = f + '@' + d.head;
        if (R.exp[f] && Object.keys(R.exp[f]).length && !R.lines[lk]) return loadLines(f).then(drawPane);
        drawPane();
      }).catch(function (e) { if (R.loading === key) { R.err = e.message; drawPane(); } });
    }
    function loadLines(f) {
      var lk = f + '@' + (R.diff && R.diff.head);
      if (R.lines[lk]) return Promise.resolve(R.lines[lk]);
      return api(P + 'code/lines?side=new&path=' + encodeURIComponent(f)).then(function (r) { R.lines[lk] = r.lines; return r.lines; });
    }
    function reloadReview() { return api(P + 'review').then(function (rv) { R.rv = rv; drawTop(); drawSide(); drawPane(); }); }
    function start() {
      R.started = true;
      if (S.hashArg) { R.file = S.hashArg; S.hashArg = null; }
      api(P + 'review').catch(function (e) {
        return { threads: [], counts: { open: 0, resolved: 0, outdated: 0, unsent: 0 }, rev: 0, err: e.message };
      }).then(function (rv) {
        R.rv = rv;
        R.prevSeen = rv.seenHead && rv.seenHead !== rv.head ? rv.seenHead : null;
        if (rv.head) api(P + 'review/seen', { method: 'POST', body: { head: rv.head } }).catch(function () {});
        return loadCode();
      }).then(function () {
        drawAll();
        if (S.jumpThread) { var id = S.jumpThread; S.jumpThread = null; jump(id); } else loadDiff();
      }).catch(function (e) { R.err = e.message; drawAll(); });
    }
    function threadSig(rv) { return rv ? JSON.stringify([rv.rev, rv.threads.map(function (t) { return [t.id, t.state, t.lineNow, t.task && t.task.status, t.comments.length]; })]) : ''; }
    function poll() {
      if (R.busy || !R.rv || R.rv.err) return;
      R.busy = true;
      var old = R.rv;
      api(P + 'review').then(function (rv) {
        R.rv = rv;
        if (rv.head && old.head && rv.head !== old.head) {
          api(P + 'review/seen', { method: 'POST', body: { head: rv.head } }).catch(function () {});
          return loadCode().then(function () {
            var fresh = [];
            for (var i = 0; i < R.code.commits.length && R.code.commits[i].sha !== old.head; i++) fresh.push(R.code.commits[i]);
            R.banner = { kind: 'new', from: R.banner && R.banner.kind === 'new' ? R.banner.from : old.head, commits: fresh.concat(R.banner && R.banner.kind === 'new' ? R.banner.commits : []) };
            drawAll();
            return loadDiff();
          });
        }
        if (threadSig(old) !== threadSig(rv)) { drawTop(); drawSide(); drawPane(); }
      }).catch(function () {}).then(function () { R.busy = false; });
    }

    // ---- top bar -------------------------------------------------------------
    function setMode(mode, arg) {
      R.mode = mode; R.sel = null; R.comp = null;
      if (mode === 'since') R.since = arg;
      if (mode === 'commit') { R.commit = arg; R.cdiff = null; }
      if (mode === 'all') R.since = null;
      (mode === 'commit' ? Promise.resolve() : loadCode()).then(function () { drawAll(); loadDiff(); });
    }
    function narrow() { return window.innerWidth < 760; }
    function layout() { return narrow() ? 'unified' : R.layout; }
    function drawTop() {
      top.textContent = '';
      var c = R.code;
      if (!c || !c.available) return;
      var modeSel = el('select', { 'aria-label': 'Which changes' });
      modeSel.appendChild(el('option', { value: 'all', text: 'All changes (' + c.totals.files + ' files)' }));
      if (R.prevSeen) {
        var n = 0; for (var i = 0; i < c.commits.length && c.commits[i].sha !== R.prevSeen; i++) n++;
        modeSel.appendChild(el('option', { value: 'since:' + R.prevSeen, text: 'Since your last visit (' + n + ' commit' + (n === 1 ? '' : 's') + ')' }));
      }
      if (R.mode === 'since' && R.since && R.since !== R.prevSeen) modeSel.appendChild(el('option', { value: 'since:' + R.since, text: 'Only the newest changes' }));
      if (c.commits.length) {
        var og = el('optgroup', { label: 'One commit' });
        c.commits.forEach(function (m) { og.appendChild(el('option', { value: 'commit:' + m.sha, text: m.sha.slice(0, 7) + ' ' + m.subject.slice(0, 60) })); });
        modeSel.appendChild(og);
      }
      modeSel.value = R.mode === 'all' ? 'all' : R.mode === 'since' ? 'since:' + R.since : 'commit:' + R.commit;
      modeSel.addEventListener('change', function () {
        var v = modeSel.value;
        if (v === 'all') setMode('all');
        else if (v.indexOf('since:') === 0) setMode('since', v.slice(6));
        else setMode('commit', v.slice(7));
      });
      var seg = el('div', { cls: 'jb-seg' });
      [['unified', 'Unified'], ['split', 'Split']].forEach(function (o) {
        seg.appendChild(el('button', { type: 'button', cls: layout() === o[0] ? 'on' : '', disabled: narrow() && o[0] === 'split' ? true : null, title: narrow() && o[0] === 'split' ? 'Needs a wider window' : null, text: o[1], onclick: function () { R.layout = o[0]; try { localStorage.setItem('lazy.diffLayout', o[0]); } catch (e) {} drawTop(); drawPane(); } }));
      });
      top.appendChild(modeSel);
      top.appendChild(seg);
      var tot = c.totals;
      if (R.mode === 'since' && c.sinceStats) tot = Object.keys(c.sinceStats).reduce(function (a, k) { return { added: a.added + c.sinceStats[k].added, removed: a.removed + c.sinceStats[k].removed }; }, { added: 0, removed: 0 });
      top.appendChild(el('span', { cls: 'sum' }, [el('span', { cls: 'plus', text: '+' + tot.added }), el('span', { cls: 'minus', text: '-' + tot.removed }), el('span', { text: c.commits.length + ' commit' + (c.commits.length === 1 ? '' : 's') })]));
      if (R.live) top.appendChild(el('span', { cls: 'rv-live', title: 'New commits show up here as helpers land them' }, [el('i'), 'Live']));
      top.appendChild(el('span', { cls: 'grow' }));
      var cnt = R.rv ? R.rv.counts : null;
      if (cnt && (cnt.open || cnt.resolved)) {
        var bits = [];
        if (cnt.open) bits.push(cnt.open + ' open' + (cnt.unsent ? ' (' + cnt.unsent + ' not sent)' : ''));
        if (cnt.resolved) bits.push(cnt.resolved + ' resolved');
        top.appendChild(el('span', { cls: 'sum', text: 'Comments: ' + bits.join(', ') }));
      }
      if (cnt && cnt.unsent) {
        top.appendChild(el('button', { cls: 'act primary', type: 'button', text: R.live ? 'Send ' + cnt.unsent + ' to helpers' : 'Fix ' + cnt.unsent + ' in a follow-up sprint', title: R.live ? 'Each file with comments becomes a task in this sprint; a free helper picks it up' : 'Starts a new sprint from this sprint\'s branch that works on your comments', onclick: function () { sendThreads(); } }));
      }
    }
    function sendThreads(ids) {
      var n = ids ? ids.length : R.rv.counts.unsent;
      var msg = R.live
        ? 'Send ' + n + ' comment' + (n === 1 ? '' : 's') + ' to the helpers? Each file with comments becomes a task in this sprint, and a free helper picks it up.'
        : 'This sprint has finished. Start a follow-up sprint that works on ' + n + ' comment' + (n === 1 ? '' : 's') + '? It starts from this sprint\'s branch.';
      if (!confirm(msg)) return;
      api(P + 'review/send', { method: 'POST', body: ids ? { ids: ids } : {} }).then(function (r) {
        if (r.mode === 'tasks') { toast('Sent to the helpers'); R.banner = { kind: 'sent', tasks: r.tasks, notified: r.notified }; }
        else { toast('Follow-up sprint started'); R.banner = { kind: 'follow', runId: r.followUp }; }
        drawBanner();
        return reloadReview();
      }).catch(function (e) { toast(e.message); });
    }
    function drawBanner() {
      var b = R.banner;
      banner.textContent = ''; banner.hidden = !b; banner.className = 'rv-banner' + (b && b.kind !== 'new' ? ' ok' : '');
      if (!b) return;
      var dismiss = el('button', { cls: 'act', type: 'button', text: 'Dismiss', onclick: function () { R.banner = null; drawBanner(); } });
      if (b.kind === 'new') {
        var n = b.commits.length;
        banner.appendChild(el('span', { cls: 'grow' }, [el('b', { text: 'New changes landed' }), ': ' + (n ? n + ' commit' + (n === 1 ? '' : 's') + (b.commits[0] ? ' - ' + b.commits[0].subject : '') : 'the branch moved') + '. The diff is up to date.']));
        if (validSince(b.from)) banner.appendChild(el('button', { cls: 'act', type: 'button', text: 'Show only these', onclick: function () { R.banner = null; drawBanner(); setMode('since', b.from); } }));
      } else if (b.kind === 'sent') {
        var made = b.tasks.filter(function (t) { return !t.added; }), joined = b.tasks.filter(function (t) { return t.added; });
        var say = [];
        if (made.length) say.push('New task' + (made.length === 1 ? '' : 's') + ' for ' + made.map(function (t) { return t.file + (t.after ? ' (starts when the helper already on that file is done)' : ''); }).join(', ') + '.');
        if (joined.length) say.push('Added to the waiting task' + (joined.length === 1 ? '' : 's') + ' for ' + joined.map(function (t) { return t.file; }).join(', ') + '.');
        say.push('A free helper picks ' + (b.tasks.length === 1 ? 'it' : 'them') + ' up' + (b.notified ? '; the ' + b.notified + ' helper' + (b.notified === 1 ? '' : 's') + ' building now got a heads-up' : '') + '.');
        banner.appendChild(el('span', { cls: 'grow' }, [el('b', { text: 'Sent to the helpers. ' }), say.join(' ')]));
        banner.appendChild(el('button', { cls: 'act', type: 'button', text: 'See on the board', onclick: function () { go(S.runId, 'board'); } }));
      } else {
        banner.appendChild(el('span', { cls: 'grow', text: 'A follow-up sprint is working on your comments, starting from this sprint\'s branch.' }));
        banner.appendChild(el('button', { cls: 'act primary', type: 'button', text: 'Open it', onclick: function () { go(b.runId); } }));
      }
      banner.appendChild(dismiss);
    }

    // ---- side panel ------------------------------------------------------------
    function drawSide() {
      var keep = side.querySelector('.rv-sbody'); var y = keep ? keep.scrollTop : 0;
      var focused = document.activeElement && side.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
      side.textContent = '';
      var c = R.code;
      if (!c || !c.available) return;
      var cnt = R.rv ? R.rv.threads.length : 0;
      var tabs = el('div', { cls: 'rv-stabs', role: 'tablist' });
      [['files', 'Files', c.totals.files], ['commits', 'Commits', c.commits.length], ['comments', 'Comments', cnt]].forEach(function (t) {
        tabs.appendChild(el('button', { type: 'button', role: 'tab', 'aria-selected': R.tab === t[0] ? 'true' : 'false', cls: R.tab === t[0] ? 'on' : '', onclick: function () { R.tab = t[0]; drawSide(); } }, [t[1], el('span', { cls: 'n', text: String(t[2]) })]));
      });
      side.appendChild(tabs);
      var body = el('div', { cls: 'rv-sbody' });
      if (R.tab === 'files') {
        var fi = el('input', { type: 'search', placeholder: 'Filter files', 'aria-label': 'Filter files' });
        fi.value = R.ffilter;
        fi.addEventListener('input', function () { R.ffilter = fi.value; drawSide(); });
        side.appendChild(el('div', { cls: 'rv-filter' }, [fi]));
        if (focused) setTimeout(function () { fi.focus(); fi.setSelectionRange(fi.value.length, fi.value.length); }, 0);
        var vm = viewedMap(), seen = c.files.filter(function (f) { return vm[f.path] === f.blob; }).length;
        body.appendChild(el('div', { cls: 'rv-prog' }, [el('span', { text: seen + ' of ' + c.files.length + ' files viewed' }), bar(seen, c.files.length)]));
        body.appendChild(fileTree(visibleFiles()));
        if (R.mode === 'since') body.appendChild(el('div', { cls: 'note', style: 'padding: 0 10px', text: 'Showing files that changed since then.' }));
      } else if (R.tab === 'commits') {
        c.commits.forEach(function (m) {
          body.appendChild(el('button', { type: 'button', cls: 'rv-co' + (R.mode === 'commit' && R.commit === m.sha ? ' on' : ''), onclick: function () { setMode('commit', m.sha); } }, [
            el('span', { text: m.subject }),
            el('span', { cls: 'meta' }, [el('span', { cls: 'mono', text: m.sha.slice(0, 7) }), el('span', { text: helperLabel(m.author) }), el('span', { text: ago(m.date) })])
          ]));
        });
        if (!c.commits.length) body.appendChild(el('div', { cls: 'empty', text: 'No commits yet.' }));
      } else {
        var sel2 = el('select', { 'aria-label': 'Which comments' }, [el('option', { value: 'open', text: 'Open' }), el('option', { value: 'unsent', text: 'Not sent yet' }), el('option', { value: 'resolved', text: 'Resolved' }), el('option', { value: 'outdated', text: 'Outdated' }), el('option', { value: 'all', text: 'All' })]);
        sel2.value = R.cfilter;
        sel2.addEventListener('change', function () { R.cfilter = sel2.value; drawSide(); });
        side.appendChild(el('div', { cls: 'rv-filter' }, [sel2]));
        var list = (R.rv ? R.rv.threads : []).filter(function (t) {
          return R.cfilter === 'all' || (R.cfilter === 'open' && t.status === 'open') || (R.cfilter === 'resolved' && t.status === 'resolved') || (R.cfilter === 'outdated' && t.state === 'outdated') || (R.cfilter === 'unsent' && t.status === 'open' && !t.sent);
        });
        list.forEach(function (t) {
          var first = t.comments[0];
          body.appendChild(el('button', { type: 'button', cls: 'rv-cm' + (R.active === t.id ? ' on' : ''), onclick: function () { jump(t.id); } }, [
            el('span', { cls: 'loc' }, [el('span', { title: t.file, text: t.file + ':' + t.lineNow + (t.side === 'old' ? ' (old version)' : '') }), badges(t)]),
            el('span', { cls: 'ex', text: first ? first.body : '' }),
            t.comments.length > 1 ? el('span', { cls: 'loc', text: (t.comments.length - 1) + ' repl' + (t.comments.length === 2 ? 'y' : 'ies') }) : null
          ]));
        });
        if (!list.length) body.appendChild(el('div', { cls: 'empty', text: cnt ? 'None here.' : 'No comments yet. Click a line number (or drag across several) in the diff to comment.' }));
      }
      side.appendChild(body);
      body.scrollTop = y;
    }
    function badges(t) {
      var box = el('span', { style: 'display:inline-flex; gap:4px; flex-wrap:wrap' });
      if (t.state === 'outdated') box.appendChild(el('span', { cls: 'rv-badge out', title: 'The code this was on has changed', text: 'Outdated' }));
      if (t.state === 'moved') box.appendChild(el('span', { cls: 'rv-badge mv', title: 'Was on line ' + t.line + '; the code moved', text: 'Moved' }));
      if (t.status === 'resolved') box.appendChild(el('span', { cls: 'rv-badge res', text: 'Resolved' }));
      if (t.sent && t.sent.taskId) box.appendChild(el('span', { cls: 'rv-badge sent', title: 'Sent to the helpers as ' + t.sent.taskId, text: t.task && t.task.status === 'closed' ? 'Handled' : 'Sent' }));
      if (t.sent && t.sent.followUp) box.appendChild(el('span', { cls: 'rv-badge sent', text: 'In follow-up' }));
      return box;
    }
    function fileTree(files) {
      var tree = el('div', { cls: 'rv-tree' });
      if (!files.length) { tree.appendChild(el('div', { cls: 'empty', text: R.ffilter ? 'No files match.' : 'No file changes.' })); return tree; }
      var changed = R.code.changedSince || [];
      var lastDir = null;
      files.forEach(function (f) {
        var i = f.path.lastIndexOf('/');
        var dir = i === -1 ? '' : f.path.slice(0, i);
        if (dir !== lastDir) {
          lastDir = dir;
          if (dir) {
            var closed = R.closedDirs[dir];
            tree.appendChild(el('div', { cls: 'rv-dir', title: dir, onclick: function () { R.closedDirs[dir] = !closed; drawSide(); } }, [el('span', { text: closed ? '>' : 'v' }), el('span', { text: dir + '/' })]));
          }
        }
        if (dir && R.closedDirs[dir]) return;
        var v = isViewed(f), oc = openCount(f.path), vm = viewedMap();
        var st = f.blob === 'deleted' ? 'D' : f.removed === 0 && f.added > 0 ? 'A' : 'M';
        tree.appendChild(el('button', { type: 'button', cls: 'rv-f' + (R.mode !== 'commit' && R.file === f.path ? ' on' : '') + (v ? ' viewed' : ''), title: f.path, style: dir ? 'padding-left: 22px' : null, onclick: function () { pickFile(f.path); } }, [
          el('span', { cls: 'st ' + st, title: { D: 'Deleted', A: 'Added', M: 'Changed' }[st], text: st }),
          el('span', { cls: 'nm', text: base(f.path) }),
          R.mode !== 'since' && changed.indexOf(f.path) !== -1 ? el('span', { cls: 'dot', title: 'Changed since your last visit' }) : null,
          oc ? el('span', { cls: 'cb', title: oc + ' open comment' + (oc === 1 ? '' : 's'), text: String(oc) }) : null,
          f.binary ? el('span', { cls: 'chip', text: 'bin' }) : el('span', { cls: 'plus', text: '+' + statOf(f).added }),
          f.binary ? null : el('span', { cls: 'minus', text: '-' + statOf(f).removed }),
          v ? el('span', { cls: 'ck', title: 'Viewed', text: 'OK' }) : vm[f.path] ? el('span', { cls: 'chg', title: 'Changed since you marked it viewed', text: 'changed' }) : null
        ]));
      });
      return tree;
    }
    function linkFile() { if (R.file && S.runId === runId && S.sub === 'code') history.replaceState(null, '', '#sprints/' + runId + '/code/' + encodeURIComponent(R.file)); }
    function pickFile(p) {
      if (R.mode === 'commit') { R.mode = R.since ? 'since' : 'all'; drawTop(); }
      R.file = p; linkFile(); R.sel = null; R.comp = null; R.diff = null;
      drawSide(); loadDiff();
      var sc = pane.querySelector('.rv-scroll'); if (sc) sc.scrollTop = 0;
      if (window.innerWidth < 960) pane.scrollIntoView({ block: 'start' });
    }
    function markViewed(f, on) {
      setViewed(f, on); drawSide(); drawPane();
      if (on) { var next = visibleFiles().filter(function (x) { return !isViewed(x); })[0]; if (next) pickFile(next.path); }
    }
    function step(dir) {
      var list = visibleFiles(); if (!list.length) return;
      var i = list.map(function (f) { return f.path; }).indexOf(R.file);
      var n = list[(i + dir + list.length) % list.length];
      if (n) pickFile(n.path);
    }
    function jump(id) {
      var t = R.rv && R.rv.threads.filter(function (x) { return x.id === id; })[0];
      if (!t) return;
      R.active = id; if (R.tab === 'comments') drawSide();
      if (t.status === 'resolved') R.showRes[id] = true;
      var need = R.mode === 'commit' || (R.mode === 'since' && t.side === 'old');
      if (need) { R.mode = 'all'; R.since = null; }
      var after = function () {
        var n = pane.querySelector('[data-thread="' + id + '"]');
        if (n) { n.scrollIntoView({ block: 'center' }); n.classList.add('flash'); }
      };
      if (R.file !== t.file || need || !R.diff) {
        R.file = t.file; R.diff = null;
        (need ? loadCode() : Promise.resolve()).then(function () { drawAll(); return loadDiff(); }).then(function () { setTimeout(after, 30); });
      } else { drawPane(); setTimeout(after, 30); }
    }

    // ---- the diff ----------------------------------------------------------------
    // Diff rows plus any context lines the reader asked to see.
    function rowsWithContext(d) {
      var rows = d.parsed.rows, out = [];
      var f = d.file, exp = R.exp[f] || {}, lines = R.lines[f + '@' + d.head], total = d.newLines;
      var lastN = 0, lastO = 0;
      function gap(gs, ge, delta, key, dir) {
        var size = ge === null ? null : ge - gs + 1;
        if (size !== null && size <= 0) return;
        var want = exp[key] || 0;
        var reveal = lines ? Math.min(want, size === null ? Math.max(0, lines.length - gs + 1) : size) : 0;
        if (ge === null && lines) { ge = lines.length; size = Math.max(0, ge - gs + 1); }
        var ctx = [];
        if (dir === 'up') for (var n = ge - reveal + 1; n <= ge; n++) ctx.push({ k: 'ctx', n: n, o: n + delta, t: lines[n - 1], x: true });
        else for (var m = gs; m < gs + reveal; m++) ctx.push({ k: 'ctx', n: m, o: m + delta, t: lines[m - 1], x: true });
        var hidden = size === null ? null : size - reveal;
        var gapRow = hidden === null || hidden > 0 ? { k: 'gap', key: key, hidden: hidden } : null;
        if (dir === 'up') { if (gapRow) out.push(gapRow); out.push.apply(out, ctx); }
        else { out.push.apply(out, ctx); if (gapRow) out.push(gapRow); }
        return hidden;
      }
      rows.forEach(function (r) {
        if (r.k === 'hunk') {
          var left = gap(lastN + 1, r.n - 1, r.o - r.n, 'u' + r.n, 'up');
          // The @@ line only marks a jump; once nothing above it is hidden it is noise.
          if (left) out.push(r);
          lastN = r.n - 1; lastO = r.o - 1;
          return;
        }
        out.push(r);
        if (r.n) lastN = r.n;
        if (r.o) lastO = r.o;
      });
      if (rows.length && !d.truncated && d.parsed.newPath) {
        var end = lines ? lines.length : typeof total === 'number' ? total : null;
        if (end === null || end > lastN) gap(lastN + 1, end, lastO - lastN, 'end', 'down');
      }
      return pairWords(out.map(function (r) { return Object.assign({}, r); }));
    }
    function expand(key, all) {
      var f = R.file;
      loadLines(f).then(function () {
        var e = R.exp[f] || (R.exp[f] = {});
        e[key] = all ? 1e9 : (e[key] || 0) + 20;
        drawPane();
      }).catch(function (err) { toast(err.message); });
    }
    function inSel(sideName, num) { var s = R.sel; return !!s && s.side === sideName && num >= Math.min(s.a, s.b) && num <= Math.max(s.a, s.b); }

    function gutterBtn() { return el('button', { cls: 'add-c', type: 'button', tabindex: '-1', title: 'Comment (drag, or shift-click, for several lines)', text: '+' }); }
    function uniRow(r, lang, idx) {
      if (r.k === 'hunk') return el('div', { cls: 'dl hunk' }, [el('span', { cls: 'g' }), el('span', { cls: 'g' }), el('span', { cls: 'gs' }), el('span', { cls: 'code', text: r.t })]);
      if (r.k === 'note') return el('div', { cls: 'dl hunk' }, [el('span', { cls: 'g' }), el('span', { cls: 'g' }), el('span', { cls: 'gs' }), el('span', { cls: 'code', text: r.t })]);
      if (r.k === 'gap') return gapRow(r, 'dl gap', [el('span', { cls: 'g' }), el('span', { cls: 'g' }), el('span', { cls: 'gs' })]);
      var sd = r.k === 'del' ? 'old' : 'new', num = sd === 'old' ? r.o : r.n, can = canComment(sd);
      var row = el('div', { cls: 'dl ' + r.k + (can ? ' cmt' : '') + (inSel(sd, num) ? ' sel' : ''), 'data-side': sd, 'data-num': String(num) }, [
        el('span', { cls: 'g', text: r.o ? String(r.o) : '' }),
        el('span', { cls: 'g', text: r.n ? String(r.n) : '' }),
        el('span', { cls: 'gs' }, [can ? gutterBtn() : null, r.k === 'add' ? '+' : r.k === 'del' ? '-' : '']),
        codeEl(r.t, lang, r.wd)
      ]);
      R.rowText[sd + ':' + num] = r.t;
      idx[sd + ':' + num] = row;
      if (r.k === 'ctx' && r.o) { idx['old:' + r.o] = idx['old:' + r.o] || row; R.rowText['old:' + r.o] = r.t; }
      return row;
    }
    function gapRow(r, cls, lead) {
      var btns = el('span', { cls: 'code' });
      if (r.hidden === null || r.hidden > 20) btns.appendChild(el('button', { type: 'button', text: r.key.charAt(0) === 'u' ? 'Show 20 more lines above' : 'Show 20 more lines', onclick: function () { expand(r.key, false); } }));
      btns.appendChild(el('button', { type: 'button', text: r.hidden === null ? 'Show the rest of the file' : 'Show ' + (r.hidden > 20 ? 'all ' : '') + r.hidden + ' hidden line' + (r.hidden === 1 ? '' : 's'), onclick: function () { expand(r.key, true); } }));
      return el('div', { cls: cls }, lead.concat([btns]));
    }
    function half(r, sd, lang, idx) {
      if (!r) return el('div', { cls: 'dh none' }, [el('span', { cls: 'g' }), el('span', { cls: 'gs' }), el('span', { cls: 'code', text: ' ' })]);
      var num = sd === 'old' ? r.o : r.n, can = canComment(sd);
      var k = r.k === 'ctx' ? 'ctx' : r.k;
      var h = el('div', { cls: 'dh ' + k + (can ? ' cmt' : '') + (inSel(sd, num) ? ' sel' : ''), 'data-side': sd, 'data-num': String(num) }, [
        el('span', { cls: 'g', text: String(num) }),
        el('span', { cls: 'gs' }, [can ? gutterBtn() : null, r.k === 'add' ? '+' : r.k === 'del' ? '-' : '']),
        codeEl(r.t, lang, r.wd)
      ]);
      R.rowText[sd + ':' + num] = r.t;
      return h;
    }
    function splitRows(rows, lang, idx, into) {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.k === 'hunk' || r.k === 'note') { into.push(el('div', { cls: 'dl hunk', style: 'grid-template-columns: 44px 1fr' }, [el('span', { cls: 'g' }), el('span', { cls: 'code', text: r.t })])); continue; }
        if (r.k === 'gap') { into.push(gapRow(r, 'dl gap', [el('span', { cls: 'g' }), el('span', { cls: 'g' }), el('span', { cls: 'gs' })])); continue; }
        if (r.k === 'ctx') {
          var row = el('div', { cls: 'dl2' }, [half(r, 'old', lang), half(r, 'new', lang)]);
          idx['new:' + r.n] = row; idx['old:' + r.o] = idx['old:' + r.o] || row;
          into.push(row); continue;
        }
        var j = i; while (j < rows.length && rows[j].k === 'del') j++;
        var k = j; while (k < rows.length && rows[k].k === 'add') k++;
        var n = Math.max(j - i, k - j);
        for (var x = 0; x < n; x++) {
          var dr = i + x < j ? rows[i + x] : null, ar = j + x < k ? rows[j + x] : null;
          var row2 = el('div', { cls: 'dl2' }, [half(dr, 'old', lang), half(ar, 'new', lang)]);
          if (dr) idx['old:' + dr.o] = row2;
          if (ar) idx['new:' + ar.n] = row2;
          into.push(row2);
        }
        i = k - 1;
      }
    }

    function drawPane() {
      var sc = pane.querySelector('.rv-scroll');
      var y = sc ? sc.scrollTop : 0;
      var same = R.paneKey === R.mode + '|' + (R.mode === 'commit' ? R.commit : R.file);
      var ae = document.activeElement, focus = null;
      if (ae && pane.contains(ae) && ae.getAttribute('data-key')) focus = { key: ae.getAttribute('data-key'), s: ae.selectionStart, e: ae.selectionEnd };
      pane.textContent = '';
      R.rowText = {};
      R.paneKey = R.mode + '|' + (R.mode === 'commit' ? R.commit : R.file);
      var scroll = el('div', { cls: 'rv-scroll' });
      pane.appendChild(scroll);
      var c = R.code;
      if (!c) { scroll.appendChild(el('div', { cls: 'rv-ph', text: R.err || 'Loading changes...' })); return; }
      if (!c.available) { scroll.appendChild(el('div', { cls: 'rv-ph', text: c.reason || 'No changes yet.' })); return; }
      if (R.err) scroll.appendChild(el('div', { cls: 'rv-note', text: R.err }));
      if (R.mode === 'commit') drawCommit(scroll);
      else drawFile(scroll);
      if (same) scroll.scrollTop = y;
      if (focus) {
        var t = pane.querySelector('[data-key="' + CSS.escape(focus.key) + '"]');
        if (t) { t.focus(); try { t.setSelectionRange(focus.s, focus.e); } catch (e) {} }
      }
    }
    function drawCommit(scroll) {
      var d = R.cdiff;
      if (!d) { scroll.appendChild(el('div', { cls: 'rv-ph', text: 'Loading the commit...' })); return; }
      var m = d.commit || {};
      scroll.appendChild(el('div', { cls: 'rv-chead' }, [el('b', { text: m.subject || '' }), el('div', { cls: 'mono' }, [(m.sha || '').slice(0, 10) + ' - ' + helperLabel(m.author || '') + ' - ' + ago(m.date)])]));
      scroll.appendChild(el('div', { cls: 'rv-note', text: 'One commit, read-only. Pick "All changes" to comment on the code.' }));
      if (!d.files.length) scroll.appendChild(el('div', { cls: 'rv-ph', text: 'This commit changes no files (a merge, or only metadata).' }));
      d.files.forEach(function (fd) {
        var p = fd.newPath || fd.oldPath || '';
        var box = el('div', { cls: 'rv-cfile' }, [el('div', { cls: 'rv-fh' }, [el('span', { cls: 'path', text: p })])]);
        var rows = el('div', { cls: 'rv-rows' }), lang = langOf(p), idx = {};
        var list = pairWords(fd.rows.map(function (r) { return Object.assign({}, r); }));
        if (layout() === 'split') { var out = []; splitRows(list, lang, idx, out); out.forEach(function (n) { rows.appendChild(n); }); }
        else list.forEach(function (r) { rows.appendChild(uniRow(r, lang, idx)); });
        if (fd.binary) rows.appendChild(el('div', { cls: 'rv-note', text: 'Binary file, not shown.' }));
        box.appendChild(rows);
        scroll.appendChild(box);
      });
      if (d.truncated) scroll.appendChild(el('div', { cls: 'rv-note', text: 'This commit is very large; the rest is not shown.' }));
    }
    function drawFile(scroll) {
      var f = fileByPath(R.file);
      if (!f) { scroll.appendChild(el('div', { cls: 'rv-ph', text: visibleFiles().length ? 'Pick a file.' : (R.mode === 'since' ? 'Nothing changed since then.' : 'No file changes yet.') })); return; }
      var v = isViewed(f);
      var vc = el('input', { type: 'checkbox' }); vc.checked = v;
      vc.addEventListener('change', function () { markViewed(f, vc.checked); });
      var oc = openCount(f.path);
      scroll.appendChild(el('div', { cls: 'rv-fh' }, [
        el('span', { cls: 'path', text: f.path }),
        f.binary ? el('span', { cls: 'chip', text: 'binary' }) : el('span', { cls: 'plus', text: '+' + statOf(f).added }),
        f.binary ? null : el('span', { cls: 'minus', text: '-' + statOf(f).removed }),
        oc ? el('span', { cls: 'chip', text: oc + ' open comment' + (oc === 1 ? '' : 's') }) : null,
        !v && viewedMap()[f.path] ? el('span', { cls: 'chg', text: 'changed since you viewed it' }) : null,
        el('span', { cls: 'grow' }),
        el('button', { cls: 'act', type: 'button', title: 'Previous file (p)', text: 'Prev', onclick: function () { step(-1); } }),
        el('button', { cls: 'act', type: 'button', title: 'Next file (n)', text: 'Next', onclick: function () { step(1); } }),
        el('label', { cls: v ? 'on' : '', title: 'Mark as viewed (v); it unmarks itself if the file changes again' }, [vc, 'Viewed'])
      ]));
      var d = R.diff;
      if (!d || d.file !== f.path) { scroll.appendChild(el('div', { cls: 'rv-ph', text: 'Loading the diff...' })); return; }
      if (R.mode === 'since') scroll.appendChild(el('div', { cls: 'rv-note', text: 'Only what changed since then. You can comment on the new side.' }));
      if (d.parsed.binary || f.binary) { scroll.appendChild(el('div', { cls: 'rv-ph', text: 'Binary file, not shown.' })); return; }
      var ts = threadsFor(f.path).filter(function (t) { return !(R.mode === 'since' && t.side === 'old'); });
      var rowsBox = el('div', { cls: 'rv-rows' + (canComment('new') ? ' can' : '') });
      var lang = langOf(f.path), idx = {};
      var list = rowsWithContext(d);
      var nodes = [];
      if (layout() === 'split') splitRows(list, lang, idx, nodes);
      else list.forEach(function (r) { nodes.push(uniRow(r, lang, idx)); });
      nodes.forEach(function (n) { rowsBox.appendChild(n); });
      if (!d.parsed.rows.length) rowsBox.appendChild(el('div', { cls: 'rv-ph', text: 'No line changes (renamed, or only its permissions changed).' }));
      // Threads and the open composer go under the last line they cover.
      var placed = {};
      ts.forEach(function (t) {
        if (t.state === 'outdated') return;
        var at = idx[t.side + ':' + t.endLineNow];
        if (!at) return;
        placed[t.id] = true;
        insertAfter(at, threadEl(t), rowsBox);
      });
      if (R.comp && R.comp.file === f.path) {
        var ca = idx[R.comp.side + ':' + R.comp.b];
        if (ca) insertAfter(ca, composerEl(R.comp), rowsBox);
        else R.comp = null;
      }
      var elsewhere = ts.filter(function (t) { return !placed[t.id]; });
      if (elsewhere.length) {
        var out = elsewhere.filter(function (t) { return t.state === 'outdated'; }).length, hid = elsewhere.length - out;
        var say = [];
        if (out) say.push(out + ' on code that has changed since');
        if (hid) say.push(hid + ' on lines not shown here');
        var box = el('div', { cls: 'rv-else' }, [el('div', { text: 'Comments: ' + say.join(', ') })]);
        elsewhere.forEach(function (t) { box.appendChild(threadEl(t, true)); });
        scroll.appendChild(box);
      }
      scroll.appendChild(rowsBox);
      if (d.truncated) scroll.appendChild(el('div', { cls: 'rv-note', text: 'This diff is very large; the rest is not shown.' }));
    }
    // After a row and any threads already under it.
    function insertAfter(row, node, box) {
      var ref = row.nextSibling;
      while (ref && ref.classList && (ref.classList.contains('rv-th') || ref.classList.contains('rv-comp'))) ref = ref.nextSibling;
      box.insertBefore(node, ref);
    }

    // ---- threads ------------------------------------------------------------------
    function authorAv(c) {
      if (c.system) return avatar('Helper');
      return el('span', { cls: 'av', style: 'background: var(--accent); color: var(--accent-ink)', text: 'You' });
    }
    function threadEl(t, withSnippet) {
      var res = t.status === 'resolved';
      var th = el('div', { cls: 'rv-th' + (res ? ' resolved' : ''), 'data-thread': t.id });
      var collapsed = res && !R.showRes[t.id];
      var head = el('div', { cls: 'rv-th-head' }, [
        el('span', { cls: 'mono', text: (t.state === 'outdated' ? 'Was ' + (t.line === t.endLine ? 'line ' + t.line : 'lines ' + t.line + '-' + t.endLine) : t.lineNow === t.endLineNow ? 'Line ' + t.lineNow : 'Lines ' + t.lineNow + '-' + t.endLineNow) + (t.side === 'old' ? ' (old version)' : '') }),
        badges(t),
        t.state === 'moved' ? el('span', { cls: 'muted', style: 'font-size:12px', text: 'was line ' + t.line }) : null,
        t.task ? el('button', { cls: 'iv-link', type: 'button', title: 'Open the task this comment was sent as (' + t.task.id + ')', text: t.task.status === 'closed' ? 'See the task' : t.task.status === 'in_progress' ? 'A helper is on it' : 'Waiting for a helper', onclick: function () { openTask(t.task.id); } }) : null,
        el('span', { cls: 'grow' }),
        t.status === 'open' && !t.sent ? el('button', { cls: 'act', type: 'button', title: R.live ? 'File just this thread as a task now' : 'Work on just this thread in a follow-up sprint', text: 'Send', onclick: function () { sendThreads([t.id]); } }) : null,
        el('button', { cls: 'act', type: 'button', text: res ? 'Reopen' : 'Resolve', onclick: function () { threadOp(t.id, res ? 'reopen' : 'resolve'); } }),
        res ? el('button', { cls: 'act', type: 'button', text: collapsed ? 'Show' : 'Hide', onclick: function () { R.showRes[t.id] = collapsed; drawPane(); } }) : null
      ]);
      th.appendChild(head);
      if (collapsed) return th;
      if (withSnippet || t.state === 'outdated') th.appendChild(el('div', { cls: 'rv-snip', title: 'The code as it was when the comment was made', text: t.anchor.join('\n') }));
      t.comments.forEach(function (c) {
        var ek = 'e:' + t.id + ':' + c.id;
        var bd = el('div', { cls: 'bd' }, [el('div', { cls: 'who' }, [
          el('b', { text: c.system ? 'Helper' : c.author }),
          el('span', { title: c.at, text: ago(c.at) + (c.editedAt ? ' (edited)' : '') }),
          c.system ? null : el('span', { cls: 'acts' }, [
            el('button', { type: 'button', text: 'Edit', onclick: function () { R.editing[ek] = true; R.drafts[ek] = c.body; drawPane(); focusKey(ek); } }),
            el('button', { type: 'button', text: 'Delete', onclick: function () { if (confirm(t.comments.length === 1 ? 'Delete this comment and its thread?' : 'Delete this comment?')) threadOp(t.id, 'delete-comment', { commentId: c.id }); } })
          ])
        ])]);
        if (R.editing[ek]) {
          var ta = draftArea(ek, '');
          bd.appendChild(ta);
          bd.appendChild(el('div', { cls: 'rv-bar' }, [el('span', { cls: 'grow' }),
            el('button', { cls: 'act', type: 'button', text: 'Cancel', onclick: function () { if (R.drafts[ek] !== c.body && !confirm('Discard your changes?')) return; delete R.editing[ek]; delete R.drafts[ek]; drawPane(); } }),
            el('button', { cls: 'act primary', type: 'button', text: 'Save', onclick: function () { saveEdit(); } })]));
          var saveEdit = function () { threadOp(t.id, 'edit', { commentId: c.id, body: R.drafts[ek] }).then(function () { delete R.editing[ek]; delete R.drafts[ek]; }); };
          ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit(); if (e.key === 'Escape') { e.stopPropagation(); delete R.editing[ek]; drawPane(); } });
        } else bd.appendChild(mdEl(c.body, t.anchor));
        th.appendChild(el('div', { cls: 'rv-c' + (c.system ? ' sys' : '') }, [authorAv(c), bd]));
      });
      var rk = 'r:' + t.id;
      var reply = el('div', { cls: 'rv-reply' });
      if (R.replying[rk] || R.drafts[rk]) {
        var ra = draftArea(rk, 'Reply... (Ctrl+Enter to send)');
        var sendReply = function (resolve) {
          if (!(R.drafts[rk] || '').trim()) return;
          threadOp(t.id, 'reply', { body: R.drafts[rk] }).then(function () {
            delete R.drafts[rk]; delete R.replying[rk];
            if (resolve) return threadOp(t.id, 'resolve');
          });
        };
        ra.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply(false); if (e.key === 'Escape') { e.stopPropagation(); delete R.replying[rk]; drawPane(); } });
        reply.appendChild(ra);
        reply.appendChild(el('div', { cls: 'rv-bar' }, [el('span', { cls: 'grow' }),
          el('button', { cls: 'act', type: 'button', text: 'Cancel', onclick: function () { if ((R.drafts[rk] || '').trim() && !confirm('Discard this reply?')) return; delete R.replying[rk]; delete R.drafts[rk]; drawPane(); } }),
          res ? null : el('button', { cls: 'act', type: 'button', text: 'Reply and resolve', onclick: function () { sendReply(true); } }),
          el('button', { cls: 'act primary', type: 'button', text: 'Reply', onclick: function () { sendReply(false); } })]));
      } else {
        reply.appendChild(el('button', { cls: 'fake', type: 'button', text: 'Reply...', onclick: function () { R.replying[rk] = true; drawPane(); focusKey(rk); } }));
      }
      th.appendChild(reply);
      return th;
    }
    function draftArea(key, placeholder) {
      var ta = el('textarea', { cls: 'rv-ta', 'data-key': key, placeholder: placeholder || null });
      ta.value = R.drafts[key] || '';
      ta.addEventListener('input', function () { R.drafts[key] = ta.value; });
      return ta;
    }
    function focusKey(key) { setTimeout(function () { var t = pane.querySelector('[data-key="' + CSS.escape(key) + '"]'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }, 0); }
    function threadOp(id, op, body) {
      return api(P + 'review/threads/' + id + '/' + op, { method: 'POST', body: body || {} }).then(reloadReview).catch(function (e) { toast(e.message); throw e; });
    }

    // ---- selecting lines and the comment box ------------------------------------------
    function composerEl(cm) {
      var a = Math.min(cm.a, cm.b), b = Math.max(cm.a, cm.b);
      var key = 'c:' + cm.file + ':' + cm.side + ':' + a + '-' + b;
      var box = el('div', { cls: 'rv-comp' });
      box.appendChild(el('div', { cls: 'what', text: 'Comment on ' + (a === b ? 'line ' + a : 'lines ' + a + '-' + b) + (cm.side === 'old' ? ' of the old version' : '') }));
      var ta = draftArea(key, 'What should change? ' + BT + 'code' + BT + ' and **bold** work; "Suggest a change" proposes new code.');
      box.appendChild(ta);
      var submit = el('button', { cls: 'act primary', type: 'button', text: 'Comment' });
      // Esc just closes the box and keeps what was typed for next time; Cancel asks first.
      var close = function () { R.comp = null; R.sel = null; drawPane(); if ((R.drafts[key] || '').trim()) toast('Draft kept; select the same lines to finish it'); };
      var cancel = function () { if ((R.drafts[key] || '').trim() && !confirm('Discard this comment?')) return; delete R.drafts[key]; R.comp = null; R.sel = null; drawPane(); };
      var save = function () {
        var text = (R.drafts[key] || '').trim();
        if (!text) { ta.focus(); return; }
        submit.disabled = true;
        api(P + 'review/threads', { method: 'POST', body: { file: cm.file, side: cm.side, line: a, endLine: b, body: text } }).then(function () {
          delete R.drafts[key]; R.comp = null; R.sel = null;
          return reloadReview();
        }).catch(function (e) { submit.disabled = false; toast(e.message); });
      };
      submit.addEventListener('click', save);
      ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); if (e.key === 'Escape') { e.stopPropagation(); close(); } });
      var suggest = el('button', { cls: 'act', type: 'button', title: 'Propose replacement code for these lines', text: 'Suggest a change', onclick: function () {
        var lines = [];
        for (var n = a; n <= b; n++) lines.push(R.rowText[cm.side + ':' + n] || '');
        var add = BT + BT + BT + 'suggestion\n' + lines.join('\n') + '\n' + BT + BT + BT + '\n';
        ta.value = (ta.value ? ta.value.replace(/\n*$/, '\n\n') : '') + add;
        R.drafts[key] = ta.value;
        ta.focus();
      } });
      box.appendChild(el('div', { cls: 'rv-bar' }, [cm.side === 'new' ? suggest : null, el('span', { cls: 'hint', text: 'Ctrl+Enter to comment, Esc to close (keeps the draft)' }), el('span', { cls: 'grow' }), el('button', { cls: 'act', type: 'button', text: 'Cancel', onclick: cancel }), submit]));
      return box;
    }
    function openComposer() {
      var s = R.sel; if (!s) return;
      R.comp = { file: R.file, side: s.side, a: Math.min(s.a, s.b), b: Math.max(s.a, s.b) };
      floatBtn.hidden = true;
      drawPane();
      var a = R.comp.a, b = R.comp.b;
      focusKey('c:' + R.file + ':' + s.side + ':' + a + '-' + b);
    }
    function paintSel() {
      pane.querySelectorAll('.sel').forEach(function (n) { n.classList.remove('sel'); });
      if (!R.sel) return;
      pane.querySelectorAll('[data-side="' + R.sel.side + '"]').forEach(function (n) { if (inSel(R.sel.side, Number(n.getAttribute('data-num')))) n.classList.add('sel'); });
    }
    function lineAt(node) {
      var n = node && (node.nodeType === 1 ? node : node.parentNode);
      var row = n && n.closest ? n.closest('[data-side]') : null;
      return row && pane.contains(row) ? { side: row.getAttribute('data-side'), num: Number(row.getAttribute('data-num')), row: row } : null;
    }
    pane.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var gut = e.target.closest && e.target.closest('.g, .add-c');
      if (!gut) return;
      var at = lineAt(e.target);
      if (!at || !canComment(at.side)) return;
      e.preventDefault();
      if (e.shiftKey && R.sel && R.sel.side === at.side) { R.sel.b = at.num; paintSel(); openComposer(); return; }
      R.sel = { side: at.side, a: at.num, b: at.num };
      R.drag = true;
      paintSel();
    });
    pane.addEventListener('mouseover', function (e) {
      if (!R.drag || !R.sel) return;
      var at = lineAt(e.target);
      if (at && at.side === R.sel.side && at.num !== R.sel.b) { R.sel.b = at.num; paintSel(); }
    });
    document.addEventListener('mouseup', function (e) {
      if (R.drag) { R.drag = false; if (wrap.isConnected) openComposer(); return; }
      if (!wrap.isConnected || !pane.contains(e.target) || e.target.closest('textarea, button, input, .rv-th, .rv-comp')) return;
      setTimeout(function () {
        var s = window.getSelection();
        if (!s || s.isCollapsed || !s.toString().trim()) { floatBtn.hidden = true; return; }
        var a = lineAt(s.anchorNode), b = lineAt(s.focusNode);
        if (!a || !b) return;
        var sd = b.side;
        if (a.side !== sd) {
          // A selection across old and new lines: keep the side the mouse ended on.
          var nums = [];
          pane.querySelectorAll('[data-side="' + sd + '"]').forEach(function (n) { if (s.containsNode(n, true)) nums.push(Number(n.getAttribute('data-num'))); });
          if (!nums.length) return;
          a = { side: sd, num: Math.min.apply(null, nums) }; b = { side: sd, num: Math.max.apply(null, nums) };
        }
        if (!canComment(sd)) return;
        var lo = Math.min(a.num, b.num), hi = Math.max(a.num, b.num);
        floatBtn.textContent = 'Comment on ' + (lo === hi ? 'line ' + lo : 'lines ' + lo + '-' + hi);
        floatBtn.style.left = Math.min(e.clientX + 8, window.innerWidth - 220) + 'px';
        floatBtn.style.top = Math.max(8, e.clientY - 44) + 'px';
        floatBtn.hidden = false;
        floatBtn.onclick = function () { R.sel = { side: sd, a: lo, b: hi }; s.removeAllRanges(); openComposer(); };
      }, 0);
    });
    document.addEventListener('mousedown', function (e) { if (e.target !== floatBtn) floatBtn.hidden = true; });
    document.addEventListener('keydown', function (e) {
      if (!wrap.isConnected || !active() || S.sub !== 'code' || document.querySelector('.iv-bg')) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'j') { e.preventDefault(); step(1); }
      else if (e.key === 'p' || e.key === 'k') { e.preventDefault(); step(-1); }
      else if (e.key === 'v') { var f = fileByPath(R.file); if (f && R.mode !== 'commit') { e.preventDefault(); markViewed(f, !isViewed(f)); } }
      else if (e.key === 'Escape' && R.sel && !R.comp) { R.sel = null; paintSel(); }
    });

    function drawAll() { drawTop(); drawBanner(); drawSide(); drawPane(); }

    return {
      el: wrap,
      update: function (v) {
        var live = v.status === 'running' || v.status === 'starting' || v.status === 'pausing' || v.status === 'paused';
        var changed = live !== R.live;
        R.live = live;
        if (!R.started) { drawAll(); start(); return; }
        if (changed) drawTop();
        poll();
      }
    };
  }
`;
