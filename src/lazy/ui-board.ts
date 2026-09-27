/**
 * The sprint board, laid out like a Jira board: a toolbar with search, helper
 * avatars and quick filters; columns with swimlanes; a list view; an issue
 * view; and board changes (new issue, priority, notes, skip, reopen) that go
 * straight to the sprint's task list through bd. Runs inside the SPRINTS_JS
 * closure, so it shares el/api/S and friends. String.raw: never put a
 * backtick or dollar-brace in here.
 */

export const BOARD_CSS = String.raw`
.jb { display: flex; flex-direction: column; gap: 10px; }
.jb-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.jb-search { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px 6px 30px; font: inherit; font-size: 13px; width: 220px; max-width: 100%;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='7' cy='7' r='4.5' fill='none' stroke='%23888' stroke-width='1.6'/%3E%3Cpath d='M10.5 10.5L14 14' stroke='%23888' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: 9px 50%; background-size: 14px; }
.jb-search:focus { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 0; border-color: var(--accent); }
.jb-avs { display: flex; align-items: center; padding-left: 6px; }
.jb-avs button { background: none; border: 0; padding: 0; margin-left: -6px; cursor: pointer; border-radius: 50%; }
.jb-avs button .av { width: 30px; height: 30px; font-size: 11px; box-shadow: 0 0 0 2px var(--bg); }
.jb-avs button.on .av { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
.jb-avs button:hover { transform: translateY(-2px); z-index: 1; }
.jb-quick { display: flex; gap: 4px; flex-wrap: wrap; }
.jb-quick button { background: none; border: 1px solid transparent; border-radius: 6px; padding: 4px 9px; font: inherit; font-size: 13px; color: var(--ink); cursor: pointer; }
.jb-quick button:hover { background: var(--chip); }
.jb-quick button.on { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); font-weight: 600; }
.jb-grow { flex: 1; }
.jb-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.jb-seg button { background: var(--panel); border: 0; padding: 5px 10px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer; }
.jb-seg button + button { border-left: 1px solid var(--line); }
.jb-seg button.on { background: var(--chip); color: var(--ink); font-weight: 600; }
.jb select.jb-sel { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 13px; }
.jb-count { font-size: 12.5px; color: var(--muted); display: flex; gap: 10px; align-items: center; }
.jb-count button { background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; font-size: 12.5px; padding: 0; }

.svg-i { display: inline-flex; width: 16px; height: 16px; flex: none; align-items: center; justify-content: center; }
.svg-i svg { width: 100%; height: 100%; display: block; }
.lz { display: inline-block; border-radius: 3px; padding: 1px 5px; font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; line-height: 1.5; white-space: nowrap; }
.lz.todo { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--ink); }
.lz.progress { background: color-mix(in srgb, #2684ff 18%, transparent); color: #2270e0; }
.lz.done { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.lz.blocked { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
.lz.epic { color: #fff; text-transform: none; font-weight: 600; letter-spacing: 0; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }

.jb-board { overflow: auto; padding-bottom: 8px; max-height: calc(100vh - 150px); }
@media (max-width: 700px) { .jb-board { max-height: none; } }
.jb-grid { display: grid; grid-template-columns: repeat(4, minmax(240px, 1fr)); column-gap: 8px; min-width: 1000px; }
.jb-colhead { position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--chip) 70%, var(--bg)); border-radius: 8px 8px 0 0; padding: 10px 10px 6px; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.jb-colhead .n { font-weight: 600; letter-spacing: 0; }
.jb-colhead .svg-i { color: var(--ok); width: 14px; height: 14px; }
.jb-lane { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 12px 6px 6px; font-size: 13.5px; cursor: pointer; user-select: none; border-top: 1px solid var(--line); }
.jb-lane:first-of-type { border-top: 0; }
.jb-lane .caret { color: var(--muted); width: 14px; height: 14px; }
.jb-lane b { font-weight: 600; }
.jb-lane small { color: var(--muted); }
.jb-lane .lane-bar { width: 110px; height: 5px; }
.jb-lane .lz { margin-left: 4px; }
.jb-cell { background: color-mix(in srgb, var(--chip) 70%, var(--bg)); padding: 4px 6px 8px; min-height: 48px; display: flex; flex-direction: column; gap: 6px; transition: background .15s; }
.jb-cell.drop { background: color-mix(in srgb, var(--accent) 12%, var(--chip)); outline: 2px dashed color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: -3px; }
.jb-cell.last { border-radius: 0 0 8px 8px; }
.jc { background: var(--panel); border-radius: 6px; padding: 9px 10px 8px; cursor: pointer; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 1px color-mix(in srgb, var(--ink) 18%, transparent), 0 0 1px color-mix(in srgb, var(--ink) 25%, transparent); transition: background .12s, box-shadow .12s; position: relative; }
.jc:hover { background: color-mix(in srgb, var(--chip) 45%, var(--panel)); }
.jc:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.jc.backlog { opacity: .62; }
.jc.skipped { opacity: .55; background: color-mix(in srgb, var(--chip) 60%, var(--panel)); }
.jc.skipped .t { text-decoration: line-through; }
.lz.wont { background: color-mix(in srgb, var(--muted) 14%, transparent); color: var(--muted); }
.jc.working::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; border-radius: 0 3px 3px 0; background: var(--ok); }
.jc.dragging { opacity: .4; }
.jc .t { font-size: 13.5px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.jc .tags { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
.jc .foot { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.jc .foot .key { font-family: var(--mono); font-size: 11.5px; font-weight: 600; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.jc.done .foot .key { text-decoration: line-through; }
.jc .foot .grow { flex: 1; }
.jc .foot .cm { display: inline-flex; gap: 3px; align-items: center; }
.jc .foot .cm .svg-i { width: 14px; height: 14px; }
.jc .foot .av { width: 24px; height: 24px; font-size: 10px; }
.svg-i.nobody { width: 24px; height: 24px; color: var(--muted); }
.jc .live-line { font-size: 12px; color: var(--ok); display: flex; gap: 6px; align-items: center; font-weight: 600; }
.jc .live-line .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 1.4s infinite; }
.jc .wait { font-size: 12px; color: var(--bad); display: flex; gap: 5px; align-items: center; }
.jb-empty-cell { color: var(--muted); font-size: 12px; text-align: center; padding: 12px 0 6px; opacity: .7; }

.jl { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 13px; }
.jl-wrap { overflow-x: auto; }
.jl th { text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); padding: 8px 10px; border-bottom: 2px solid var(--line); cursor: pointer; white-space: nowrap; user-select: none; }
.jl th.on::after { content: " v"; font-size: 10px; }
.jl th.on.up::after { content: " ^"; }
.jl td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.jl tr:last-child td { border-bottom: 0; }
.jl tbody tr { cursor: pointer; }
.jl tbody tr:hover td { background: color-mix(in srgb, var(--chip) 55%, transparent); }
.jl .sum { min-width: 260px; }
.jl .key { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; }
.jl .who { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.jl .who .av { width: 22px; height: 22px; font-size: 9.5px; }

/* issue view */
.iv-bg { position: fixed; inset: 0; background: color-mix(in srgb, #000 42%, transparent); z-index: 30; display: flex; align-items: flex-start; justify-content: center; padding: 5vh 16px 16px; overflow: auto; }
.iv { background: var(--panel); color: var(--ink); border-radius: 10px; width: min(1040px, 100%); box-shadow: 0 20px 60px color-mix(in srgb, #000 35%, transparent); display: flex; flex-direction: column; }
.iv-top { display: flex; align-items: center; gap: 8px; padding: 14px 18px 0; font-size: 13px; color: var(--muted); flex-wrap: wrap; }
.iv-top .crumb { display: inline-flex; gap: 6px; align-items: center; }
.iv-top .crumb a { color: var(--muted); text-decoration: none; cursor: pointer; }
.iv-top .crumb a:hover { text-decoration: underline; }
.iv-top .grow { flex: 1; }
.iv-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; padding: 8px 18px 22px; }
@media (max-width: 820px) { .iv-body { grid-template-columns: 1fr; } }
.iv h2 { font-size: 22px; margin: 6px 0 14px; line-height: 1.3; font-weight: 600; letter-spacing: -.01em; overflow-wrap: anywhere; }
.iv h2.editable { cursor: text; border-radius: 6px; padding: 2px 4px; margin-left: -4px; }
.iv h2.editable:hover { background: var(--chip); }
.iv .title-in { width: 100%; font: inherit; font-size: 20px; font-weight: 600; padding: 6px 8px; border: 2px solid var(--accent); border-radius: 6px; background: var(--bg); color: var(--ink); margin: 4px 0 12px; }
.iv h4 { margin: 18px 0 6px; font-size: 14px; font-weight: 600; }
.iv .txt { white-space: pre-wrap; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.iv .muted { color: var(--muted); font-size: 13px; }
.iv-tabs { display: flex; gap: 2px; margin: 18px 0 8px; border-bottom: 1px solid var(--line); }
.iv-tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer; }
.iv-tabs button.on { color: var(--ink); border-color: var(--accent); font-weight: 600; }
.iv-cmt { display: flex; gap: 10px; padding: 8px 0; }
.iv-cmt .av { width: 28px; height: 28px; font-size: 10.5px; }
.iv-cmt .who { font-size: 13px; }
.iv-cmt .who b { margin-right: 6px; }
.iv-cmt .who span { color: var(--muted); font-size: 12px; }
.iv-cmt .txt { margin-top: 3px; }
.iv-add { display: flex; gap: 10px; align-items: flex-start; margin: 6px 0 4px; }
.iv-add textarea { flex: 1; min-height: 40px; resize: vertical; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13.5px; }
.iv-add textarea:focus { min-height: 90px; outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); }
.iv-side { display: flex; flex-direction: column; gap: 12px; }
.iv-status { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.iv-status .lz { font-size: 12.5px; padding: 4px 10px; border-radius: 5px; }
.iv-det { border: 1px solid var(--line); border-radius: 8px; }
.iv-det > div:first-child { padding: 10px 12px; font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--line); }
.iv-det dl { margin: 0; padding: 8px 12px 12px; display: grid; grid-template-columns: 110px 1fr; gap: 10px 10px; font-size: 13px; align-items: center; }
.iv-det dt { color: var(--muted); }
.iv-det dd { margin: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; overflow-wrap: anywhere; }
.iv-det dd .av { width: 22px; height: 22px; font-size: 9.5px; }
.iv-det select { background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 13px; }
.iv-link { color: var(--accent); cursor: pointer; font-family: var(--mono); font-size: 12px; background: none; border: 0; padding: 0; }
.iv-link:hover { text-decoration: underline; }
.iv-dep { display: flex; gap: 6px; align-items: center; width: 100%; min-width: 0; }
.iv-dep .iv-link { font-family: inherit; font-size: 13px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iv-rv { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 13px; }
.iv-rv .mono { font-size: 12px; color: var(--muted); }
.iv-foot { color: var(--muted); font-size: 12px; }

/* create issue */
.ci { background: var(--panel); border-radius: 10px; width: min(640px, 100%); box-shadow: 0 20px 60px color-mix(in srgb, #000 35%, transparent); padding: 18px 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ci h3 { grid-column: 1 / -1; margin: 0 0 4px; font-size: 18px; }
.ci label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.ci label.wide, .ci .wide { grid-column: 1 / -1; }
.ci input, .ci select, .ci textarea { background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 14px; }
.ci textarea { min-height: 90px; resize: vertical; }
.ci .actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
.ci .hint { grid-column: 1 / -1; font-size: 12.5px; color: var(--muted); }
@media (max-width: 560px) { .ci { grid-template-columns: 1fr; } }
`;

export const BOARD_JS = String.raw`
  // ---- icons ---------------------------------------------------------------
  var SVG = {
    task: '<svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#4bade8"/><path d="M4.6 8.3l2.2 2.2 4.6-4.9" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bug: '<svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#e5493a"/><circle cx="8" cy="8" r="3.3" fill="#fff"/></svg>',
    chore: '<svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#8993a4"/><path d="M4.6 5.8h6.8M4.6 8h6.8M4.6 10.2h4.2" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>',
    feature: '<svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#63ba3c"/><path d="M5.4 3.8h5.2v8.4L8 10.2l-2.6 2z" fill="#fff"/></svg>',
    epic: '<svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#904ee2"/><path d="M9.2 3.2L5 8.8h3l-1 4 4.2-5.6h-3z" fill="#fff"/></svg>',
    p0: '<svg viewBox="0 0 16 16"><path d="M3.5 8.2L8 4l4.5 4.2M3.5 12.2L8 8l4.5 4.2" stroke="#e5493a" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    p1: '<svg viewBox="0 0 16 16"><path d="M3.5 10.2L8 6l4.5 4.2" stroke="#f15c4a" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    p2: '<svg viewBox="0 0 16 16"><path d="M3.5 6.3h9M3.5 9.7h9" stroke="#ffab00" stroke-width="1.9" stroke-linecap="round"/></svg>',
    p3: '<svg viewBox="0 0 16 16"><path d="M3.5 5.8L8 10l4.5-4.2" stroke="#2684ff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    p4: '<svg viewBox="0 0 16 16"><path d="M3.5 3.8L8 8l4.5-4.2M3.5 7.8L8 12l4.5-4.2" stroke="#2684ff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    comment: '<svg viewBox="0 0 16 16"><path d="M2.5 3.2h11v7.3H7.6L4.6 13v-2.5H2.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    flag: '<svg viewBox="0 0 16 16"><path d="M4 14.5V2.5" stroke="#e5493a" stroke-width="1.5" stroke-linecap="round"/><path d="M4.6 3h7.6l-2 3 2 3H4.6z" fill="#e5493a"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3.3 8.6l3 3 6.4-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="currentColor" opacity=".18"/><circle cx="12" cy="9.5" r="4" fill="currentColor" opacity=".55"/><path d="M4.8 19.5c1.4-3.2 4-4.8 7.2-4.8s5.8 1.6 7.2 4.8" fill="currentColor" opacity=".55"/></svg>',
    down: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    right: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    review: '<svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#ff8b00"/><path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>'
  };
  var PRIO_NAME = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
  var COL_LZ = { todo: 'To do', blocked: 'Blocked', progress: 'In progress', done: 'Done' };
  function svgIcon(name, title, cls) {
    var s = el('span', { cls: 'svg-i' + (cls ? ' ' + cls : ''), title: title || null, 'aria-label': title || null });
    s.innerHTML = SVG[name] || '';
    return s;
  }
  function typeIcon(type) {
    var t = type === 'bug' ? 'bug' : type === 'epic' ? 'epic' : type === 'feature' ? 'feature' : type === 'chore' ? 'chore' : 'task';
    return svgIcon(t, { bug: 'Bug', epic: 'Epic', feature: 'Feature', chore: 'Chore', task: 'Task' }[t]);
  }
  function prio(p) { var n = Math.min(4, Math.max(0, Number(p) || 0)); return svgIcon('p' + n, 'Priority: ' + PRIO_NAME[n] + ' (P' + n + ')'); }
  function lozenge(col, skipped) { return skipped ? el('span', { cls: 'lz wont', title: 'Taken off the sprint; nobody built it', text: 'Won\'t do' }) : el('span', { cls: 'lz ' + col, text: COL_LZ[col] || col }); }
  function laneChip(lane) { return el('span', { cls: 'lz epic', title: lane.title, style: 'background: hsl(' + hue(lane.id || '') + ' 48% 46%)', text: lane.title }); }
  function isRoot(id) { var r = S.sprint && S.sprint.record; return !!r && r.rootIssue === id; }
  function whoOf(c) { return c.working.length ? c.working[0].member : c.lastHelper; }

  // ---- filters (remembered per browser) --------------------------------------
  function loadBf() {
    // A phone gets the list: four columns do not fit on it.
    var f = { q: '', who: null, quick: {}, group: 'lane', view: window.innerWidth < 700 ? 'list' : 'board', sort: 'priority', up: true };
    try { var saved = JSON.parse(localStorage.getItem('lazy.boardFilters') || '{}'); f.group = saved.group || f.group; f.view = saved.view || f.view; } catch (e) {}
    return f;
  }
  function saveBf() { try { localStorage.setItem('lazy.boardFilters', JSON.stringify({ group: S.bf.group, view: S.bf.view })); } catch (e) {} }
  var QUICK = [
    ['working', 'Working now', function (c) { return c.working.length > 0; }],
    ['blocked', 'Blocked', function (c) { return c.column === 'blocked'; }],
    ['bugs', 'Bugs', function (c) { return c.type === 'bug'; }],
    ['review', 'From review', function (c) { return (c.labels || []).indexOf('review') !== -1; }],
    ['recent', 'Recently updated', function (c) { var t = Date.parse(c.updatedAt || c.closedAt || c.startedAt || ''); return !isNaN(t) && Date.now() - t < 3600000; }],
    ['goal', 'In this sprint', function (c) { return c.inSprint; }]
  ];
  function matches(c, F) {
    if (F.q) {
      var q = F.q.toLowerCase();
      if ((c.title + ' ' + c.id + ' ' + (c.labels || []).join(' ')).toLowerCase().indexOf(q) === -1) return false;
    }
    if (F.who && whoOf(c) !== F.who) return false;
    for (var i = 0; i < QUICK.length; i++) if (F.quick[QUICK[i][0]] && !QUICK[i][2](c)) return false;
    return true;
  }
  function anyFilter(F) { return !!(F.q || F.who || Object.keys(F.quick).some(function (k) { return F.quick[k]; })); }

  // ---- the board component -------------------------------------------------
  // Built once per sprint and updated in place, so typing in the search box
  // and the scroll position survive the live refresh.
  function boardComp() {
    var F = S.bf || (S.bf = loadBf());
    var cur = null, sig = '';
    var search = el('input', { type: 'search', cls: 'jb-search', placeholder: 'Search this board', 'aria-label': 'Search this board' });
    search.value = F.q || '';
    search.addEventListener('input', function () { F.q = search.value; draw(); });
    var avs = el('div', { cls: 'jb-avs' });
    var quick = el('div', { cls: 'jb-quick' });
    var group = el('select', { cls: 'jb-sel', 'aria-label': 'Group by' }, [el('option', { value: 'lane', text: 'Group: Features' }), el('option', { value: 'helper', text: 'Group: Helpers' }), el('option', { value: 'none', text: 'Group: None' })]);
    group.value = F.group;
    group.addEventListener('change', function () { F.group = group.value; saveBf(); draw(); });
    var seg = el('div', { cls: 'jb-seg' });
    var create = el('button', { cls: 'act primary', type: 'button', text: 'Create issue', title: 'Add an issue to this sprint (c)', onclick: function () { createIssue(); } });
    var bar = el('div', { cls: 'jb-bar' }, [search, avs, quick, el('span', { cls: 'jb-grow' }), group, seg, create]);
    var count = el('div', { cls: 'jb-count' });
    var body = el('div', {});
    var wrap = el('div', { cls: 'jb' }, [bar, count, body]);

    function drawBar() {
      var b = cur.board;
      var names = [];
      b.cards.forEach(function (c) { var w = whoOf(c); if (w && names.indexOf(w) === -1) names.push(w); });
      (b.members || []).forEach(function (m) { if (names.indexOf(m) === -1) names.push(m); });
      names.sort(function (x, y) { return helperLabel(x).localeCompare(helperLabel(y), undefined, { numeric: true }); });
      avs.textContent = '';
      names.slice(0, 12).forEach(function (n) {
        var live = b.cards.some(function (c) { return c.working.some(function (w) { return w.member === n; }); });
        avs.appendChild(el('button', { type: 'button', cls: F.who === n ? 'on' : '', title: helperLabel(n) + (live ? ' (working)' : '') + ' - show only their issues', onclick: function () { F.who = F.who === n ? null : n; drawBar(); draw(); } }, [avatar(n, live)]));
      });
      quick.textContent = '';
      QUICK.forEach(function (qf) {
        quick.appendChild(el('button', { type: 'button', cls: F.quick[qf[0]] ? 'on' : '', 'aria-pressed': F.quick[qf[0]] ? 'true' : 'false', text: qf[1], onclick: function () { F.quick[qf[0]] = !F.quick[qf[0]]; drawBar(); draw(); } }));
      });
      seg.textContent = '';
      [['board', 'Board'], ['list', 'List']].forEach(function (o) {
        seg.appendChild(el('button', { type: 'button', cls: F.view === o[0] ? 'on' : '', text: o[1], onclick: function () { F.view = o[0]; saveBf(); drawBar(); draw(); } }));
      });
      create.hidden = !cur.canEdit;
    }

    function draw() {
      if (!cur) return;
      var b = cur.board;
      var shown = b.cards.filter(function (c) { return matches(c, F); });
      count.textContent = '';
      if (anyFilter(F)) {
        count.appendChild(el('span', { text: 'Showing ' + shown.length + ' of ' + b.cards.length + ' issues' }));
        count.appendChild(el('button', { type: 'button', text: 'Clear filters', onclick: function () { F.q = ''; search.value = ''; search.blur(); F.who = null; F.quick = {}; drawBar(); draw(); } }));
      }
      var keepX = body.firstChild ? body.firstChild.scrollLeft : 0;
      body.textContent = '';
      if (!b.cards.length) {
        body.appendChild(el('div', { cls: 'empty', text: b.live ? 'Helpers are planning - issues appear here as they are created.' : 'This sprint has no issues.' }));
        return;
      }
      if (!shown.length) { body.appendChild(el('div', { cls: 'empty', text: 'No issues match these filters.' })); return; }
      body.appendChild(F.view === 'list' ? listView(b, shown) : boardView(b, shown));
      if (body.firstChild) body.firstChild.scrollLeft = keepX;
    }

    function update(v, force) {
      var fresh = cur === null;
      cur = v;
      var s = JSON.stringify([v.board.cards, v.board.lanes, v.canEdit, v.board.members]);
      if (!fresh && !force && s === sig) return;
      sig = s;
      drawBar();
      draw();
      // A link straight to one issue (#sprints/<run>/board/<issue>).
      if (fresh && S.hashArg) { var want = S.hashArg; S.hashArg = null; openTask(want); }
    }
    return { el: wrap, update: update, focusSearch: function () { search.focus(); search.select(); } };
  }

  function groupsFor(b, shown) {
    var F = S.bf;
    if (F.group === 'none') return [{ id: '_all', title: null, cards: shown }];
    if (F.group === 'helper') {
      var by = {}, order = [];
      shown.forEach(function (c) { var w = whoOf(c) || ''; if (!by[w]) { by[w] = []; order.push(w); } by[w].push(c); });
      order.sort(function (a, z) { return a === '' ? 1 : z === '' ? -1 : helperLabel(a).localeCompare(helperLabel(z), undefined, { numeric: true }); });
      return order.map(function (w) { return { id: 'h:' + w, title: w ? helperLabel(w) : 'Nobody yet', who: w, cards: by[w] }; });
    }
    return b.lanes.map(function (lane) {
      return { id: 'l:' + lane.id, lane: lane, title: lane.title, cards: shown.filter(function (c) { return c.lane === lane.id; }) };
    }).filter(function (g) { return g.cards.length || !anyFilter(F); });
  }

  function boardView(b, shown) {
    var wrap = el('div', { cls: 'jb-board' });
    var grid = el('div', { cls: 'jb-grid' });
    b.columns.forEach(function (c) {
      var n = shown.filter(function (x) { return x.column === c.key; }).length;
      grid.appendChild(el('div', { cls: 'jb-colhead' }, [el('span', { text: c.title }), el('span', { cls: 'n', text: String(n) }), c.key === 'done' && n ? svgIcon('check', 'Done') : null]));
    });
    var groups = groupsFor(b, shown);
    groups.forEach(function (g, gi) {
      var collapsed = S.collapsed[g.id];
      var laneLike = S.bf.group !== 'none' && (groups.length > 1 || (g.lane && g.lane.id));
      if (laneLike) {
        // Won't-do cards are neither finished work nor work left.
        var counted = g.cards.filter(function (c) { return !c.skipped; });
        var done = counted.filter(function (c) { return c.column === 'done'; }).length;
        grid.appendChild(el('div', { cls: 'jb-lane', role: 'button', tabindex: '0', 'data-g': g.id, 'aria-expanded': collapsed ? 'false' : 'true', onclick: function () {
          S.collapsed[g.id] = !collapsed; S.shell && S.shell.comp && S.shell.comp.update(S.sprint, true);
          var again = [].slice.call(document.querySelectorAll('.jb-lane')).filter(function (n) { return n.getAttribute('data-g') === g.id; })[0];
          if (again) again.focus();
        }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } }, [
          svgIcon(collapsed ? 'right' : 'down', null, 'caret'),
          g.lane && g.lane.id && !isRoot(g.lane.id) ? typeIcon(g.lane.type) : g.who ? avatar(g.who, g.cards.some(function (c) { return c.working.length; })) : null,
          el('b', { text: g.title }),
          g.lane && g.lane.id && !isRoot(g.lane.id) ? el('small', { cls: 'mono', text: g.lane.id }) : null,
          el('small', { text: '(' + g.cards.length + ' issue' + (g.cards.length === 1 ? '' : 's') + ')' }),
          el('div', { cls: 'bar lane-bar' }, [el('i', { style: 'width:' + (counted.length ? Math.round(done * 100 / counted.length) : 0) + '%' })]),
          el('small', { text: done + ' of ' + counted.length + ' done' }),
          g.lane && g.lane.id && g.lane.status === 'closed' ? el('span', { cls: 'lz done', text: 'Done' }) : null
        ]));
      }
      if (collapsed && laneLike) return;
      b.columns.forEach(function (c) {
        var cell = el('div', { cls: 'jb-cell' + (gi === groups.length - 1 ? ' last' : ''), 'data-col': c.key });
        var here = g.cards.filter(function (x) { return x.column === c.key; });
        here.forEach(function (card) { cell.appendChild(cardEl(card, b)); });
        dropTarget(cell, c.key);
        grid.appendChild(cell);
      });
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function cardEl(c, b) {
    var live = c.working.length > 0;
    var who = whoOf(c);
    var laneOf = null;
    b.lanes.forEach(function (l) { if (l.id && l.id === c.lane && !isRoot(l.id)) laneOf = l; });
    var tags = [];
    if (laneOf && S.bf.group !== 'lane') tags.push(laneChip(laneOf));
    if ((c.labels || []).indexOf('review') !== -1) tags.push(el('span', { cls: 'lz progress', style: 'text-transform:none', text: 'From review' }));
    if (c.stage === 'landing') tags.push(el('span', { cls: 'stage landing', text: 'Landing' }));
    if (c.stage === 'fixing') tags.push(el('span', { cls: 'stage fixing', text: 'Fixing after a failed landing' }));
    if (c.bounces) tags.push(el('span', { cls: 'bounce', text: 'sent back ' + c.bounces + 'x' }));
    if (c.skipped) tags.push(lozenge('done', true));
    if (!c.inSprint) tags.push(el('span', { cls: 'chip', title: 'Below this sprint\'s goal; helpers only get to it if everything else is done', text: 'Later' }));
    var kids = [
      el('div', { cls: 't', text: c.title }),
      live ? el('div', { cls: 'live-line' }, [el('span', { cls: 'dot' }), el('span', { text: helperLabel(c.working[0].member) + ' is on it' }), el('span', { 'data-since': c.working[0].since, text: dur(Date.now() - c.working[0].since) })]) : null,
      c.blockedBy.length && c.column === 'blocked' ? el('div', { cls: 'wait' }, [svgIcon('flag', 'Blocked'), el('span', { text: 'Waiting on ' + c.blockedBy.join(', ') })]) : null,
      tags.length ? el('div', { cls: 'tags' }, tags) : null,
      el('div', { cls: 'foot' }, [
        typeIcon(c.type),
        el('span', { cls: 'key', title: c.id, text: c.id }),
        el('span', { cls: 'grow' }),
        c.model ? el('span', { cls: 'chip', title: 'Model tier', text: c.model }) : null,
        c.comments ? el('span', { cls: 'cm', title: c.comments + ' note' + (c.comments === 1 ? '' : 's') }, [svgIcon('comment'), String(c.comments)]) : null,
        prio(c.priority),
        who ? avatar(who, live) : svgIcon('person', 'Nobody yet', 'nobody')
      ])
    ];
    var draggable = S.sprint && S.sprint.canEdit && c.column !== 'progress';
    var card = el('div', { cls: 'jc' + (live ? ' working' : '') + (c.inSprint ? '' : ' backlog') + (c.column === 'done' ? ' done' : '') + (c.skipped ? ' skipped' : ''), tabindex: '0', role: 'button', 'aria-label': c.id + ': ' + c.title, draggable: draggable ? 'true' : null, onclick: function () { openTask(c.id); }, onkeydown: function (e) { if (e.key === 'Enter') openTask(c.id); } }, kids);
    if (draggable) {
      card.addEventListener('dragstart', function (e) { S.dragCard = c; card.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} });
      card.addEventListener('dragend', function () { S.dragCard = null; card.classList.remove('dragging'); document.querySelectorAll('.jb-cell.drop').forEach(function (n) { n.classList.remove('drop'); }); });
    }
    return card;
  }

  // Dragging a card is how you take it off the sprint (to Done) or bring it
  // back (to To do); helpers own everything in between.
  function dropAllowed(c, col) {
    if (!c) return false;
    if (col === 'done') return c.column === 'todo' || c.column === 'blocked';
    if (col === 'todo') return c.column === 'done';
    return false;
  }
  function dropTarget(cell, col) {
    cell.addEventListener('dragover', function (e) { if (dropAllowed(S.dragCard, col)) { e.preventDefault(); cell.classList.add('drop'); } });
    cell.addEventListener('dragleave', function () { cell.classList.remove('drop'); });
    cell.addEventListener('drop', function (e) {
      e.preventDefault(); cell.classList.remove('drop');
      var c = S.dragCard; S.dragCard = null;
      if (!dropAllowed(c, col)) return;
      if (col === 'done') {
        if (!confirm('Mark "' + c.title + '" as won\'t do? Helpers will not build it; it shows in Done, crossed out. You can drag it back to To do.')) return;
        taskOp(c.id, 'skip', { reason: 'Skipped from the board' }, 'Marked won\'t do');
      } else taskOp(c.id, 'reopen', {}, 'Back in To do');
    });
  }
  function taskOp(id, op, body, done) {
    return api('sprints/' + encodeURIComponent(S.runId) + '/tasks/' + encodeURIComponent(id) + '/' + op, { method: 'POST', body: body || {} })
      .then(function () { if (done) toast(done); refresh(true); })
      .catch(function (e) { toast(e.message); throw e; });
  }

  function listView(b, shown) {
    var F = S.bf;
    var laneTitle = {};
    b.lanes.forEach(function (l) { laneTitle[l.id] = l.title; });
    var ORDER = { todo: 0, blocked: 1, progress: 2, done: 3 };
    var cols = [
      ['type', 'Type', function (c) { return c.type; }],
      ['key', 'Key', function (c) { return c.id; }],
      ['summary', 'Summary', function (c) { return c.title.toLowerCase(); }],
      ['status', 'Status', function (c) { return ORDER[c.column]; }],
      ['priority', 'Priority', function (c) { return c.priority; }],
      ['who', 'Assignee', function (c) { return whoOf(c) ? helperLabel(whoOf(c)) : '~'; }],
      ['lane', 'Feature', function (c) { return laneTitle[c.lane] || '~'; }],
      ['updated', 'Updated', function (c) { return -(Date.parse(c.updatedAt || c.closedAt || c.startedAt || '') || 0); }]
    ];
    var key = cols.filter(function (x) { return x[0] === F.sort; })[0] || cols[4];
    var rows = shown.slice().sort(function (a, z) {
      var x = key[2](a), y = key[2](z);
      var r = x < y ? -1 : x > y ? 1 : a.id.localeCompare(z.id, undefined, { numeric: true });
      return F.up ? r : -r;
    });
    var head = el('tr', {});
    cols.forEach(function (col) {
      var sortBy = function () { if (F.sort === col[0]) F.up = !F.up; else { F.sort = col[0]; F.up = true; } S.shell.comp.update(S.sprint, true); var h = document.querySelector('.jl th[data-k="' + col[0] + '"]'); if (h) h.focus(); };
      head.appendChild(el('th', { cls: (F.sort === col[0] ? 'on' : '') + (F.sort === col[0] && !F.up ? ' up' : ''), 'data-k': col[0], tabindex: '0', 'aria-sort': F.sort === col[0] ? (F.up ? 'ascending' : 'descending') : null, onclick: sortBy, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(); } }, text: col[1] }));
    });
    var tb = el('tbody', {});
    rows.forEach(function (c) {
      var w = whoOf(c);
      tb.appendChild(el('tr', { tabindex: '0', onclick: function () { openTask(c.id); }, onkeydown: function (e) { if (e.key === 'Enter') openTask(c.id); } }, [
        el('td', {}, [typeIcon(c.type)]),
        el('td', { cls: 'key', text: c.id }),
        el('td', { cls: 'sum', text: c.title }),
        el('td', {}, [lozenge(c.column, c.skipped), c.inSprint ? null : el('span', { cls: 'chip', style: 'margin-left:6px', title: 'Below this sprint\'s goal', text: 'Later' })]),
        el('td', {}, [el('span', { style: 'display:inline-flex; gap:5px; align-items:center' }, [prio(c.priority), PRIO_NAME[Math.min(4, Math.max(0, c.priority))]])]),
        el('td', {}, [w ? el('span', { cls: 'who' }, [avatar(w, c.working.length > 0), helperLabel(w)]) : el('span', { cls: 'muted', text: 'Nobody yet' })]),
        el('td', { text: laneTitle[c.lane] || '' }),
        el('td', { cls: 'muted', text: c.updatedAt || c.closedAt || c.startedAt ? ago(c.updatedAt || c.closedAt || c.startedAt) : '' })
      ]));
    });
    if (!rows.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '8', cls: 'muted', text: 'No issues match.' })]));
    return el('div', { cls: 'jl-wrap' }, [el('table', { cls: 'jl' }, [el('thead', {}, [head]), tb])]);
  }

  // ---- issue view ------------------------------------------------------------
  var returnFocus = null;
  function closeDrawer() {
    var had = document.querySelector('.iv-bg');
    document.querySelectorAll('.drawer, .drawer-bg, .iv-bg').forEach(function (n) { n.remove(); });
    if (S.openTaskId && S.view === 'sprint' && S.sub === 'board') history.replaceState(null, '', '#sprints/' + S.runId);
    S.openTaskId = null;
    if (had && returnFocus && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  function overlay(inner) {
    var from = document.activeElement;
    closeDrawer();
    if (!returnFocus) returnFocus = from && from !== document.body ? from : null;
    var bg = el('div', { cls: 'iv-bg', role: 'dialog', 'aria-modal': 'true' }, [inner]);
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) closeDrawer(); });
    // Keep Tab inside the dialog.
    bg.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = [].slice.call(bg.querySelectorAll('button, input, select, textarea, [tabindex="0"]')).filter(function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    document.body.appendChild(bg);
    var first = bg.querySelector('input, textarea, h2, button');
    if (first) { if (first.tagName === 'H2') first.setAttribute('tabindex', '-1'); first.focus(); }
    return bg;
  }
  function openTask(id, tab) {
    var runId = S.runId;
    Promise.all([
      api('sprints/' + encodeURIComponent(runId) + '/tasks/' + encodeURIComponent(id)),
      api('sprints/' + encodeURIComponent(runId) + '/review').catch(function () { return null; })
    ]).then(function (res) {
      if (S.runId !== runId) return;
      var t = res[0], rv = res[1];
      var b = S.sprint && S.sprint.board;
      var card = b ? b.cards.filter(function (c) { return c.id === id; })[0] : null;
      var lane = b && card ? b.lanes.filter(function (l) { return l.id && l.id === card.lane; })[0] : null;
      var col = card ? card.column : (t.status === 'closed' ? 'done' : t.status === 'in_progress' ? 'progress' : 'todo');
      var canEdit = !!t.canEdit;
      var kind = card ? card.type : (t.issue_type || 'task');
      var working = card && card.working.length;
      S.openTaskId = id;
      if (S.sub === 'board') history.replaceState(null, '', '#sprints/' + S.runId + '/board/' + encodeURIComponent(id));

      var main = el('div', {});
      var title = el('h2', { cls: canEdit ? 'editable' : '', title: canEdit ? 'Click to rename' : null, text: t.title || t.id });
      if (canEdit) title.addEventListener('click', function () {
        var inp = el('input', { cls: 'title-in', type: 'text', maxlength: '200' });
        inp.value = t.title || '';
        var done = false;
        function save() {
          if (done) return; done = true;
          var v = inp.value.trim();
          if (!v || v === t.title) { inp.replaceWith(title); return; }
          taskOp(id, 'update', { title: v }, 'Renamed').then(function () { openTask(id); }, function () { inp.replaceWith(title); });
        }
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); done = true; inp.replaceWith(title); } });
        inp.addEventListener('blur', save);
        title.replaceWith(inp); inp.focus(); inp.select();
      });
      main.appendChild(title);
      [['Description', t.description], ['Acceptance criteria', t.acceptance_criteria], ['Notes from helpers', t.notes]].forEach(function (p) {
        if (!p[1]) return; main.appendChild(el('h4', { text: p[0] })); main.appendChild(el('div', { cls: 'txt', text: p[1] }));
      });
      if (!t.description && !t.acceptance_criteria) main.appendChild(el('div', { cls: 'muted', text: 'No description.' }));

      var linked = rv ? rv.threads.filter(function (th) { return th.sent && th.sent.taskId === id; }) : [];
      if (linked.length) {
        main.appendChild(el('h4', { text: 'Review comments in this issue' }));
        linked.forEach(function (th) {
          main.appendChild(el('div', { cls: 'iv-rv' }, [
            el('div', { cls: 'mono', text: th.file + ':' + th.lineNow + (th.state === 'outdated' ? ' (code changed since)' : '') }),
            el('div', { cls: 'txt', text: th.comments[0] ? th.comments[0].body : '' }),
            el('button', { cls: 'iv-link', type: 'button', text: 'Open in Code changes', onclick: function () { closeDrawer(); S.jumpThread = th.id; go(S.runId, 'code'); } })
          ]));
        });
      }

      var tabs = el('div', { cls: 'iv-tabs' });
      var pane = el('div', {});
      var which = tab || 'comments';
      function showTab(k) {
        which = k;
        tabs.querySelectorAll('button').forEach(function (bt) { bt.className = bt.getAttribute('data-k') === k ? 'on' : ''; });
        pane.textContent = '';
        if (k === 'comments') {
          if (canEdit || t.comments.length) {
            if (canEdit) {
              var ta = el('textarea', { placeholder: 'Add a note for the helpers... (Ctrl+Enter to save)', 'aria-label': 'Add a note' });
              var saveBtn = el('button', { cls: 'act primary', type: 'button', text: 'Save' });
              var send = function () {
                if (!ta.value.trim()) return;
                saveBtn.disabled = true;
                taskOp(id, 'comment', { text: ta.value }, 'Note added').then(function () { openTask(id, 'comments'); }, function () { saveBtn.disabled = false; });
              };
              saveBtn.addEventListener('click', send);
              ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
              pane.appendChild(el('div', { cls: 'iv-add' }, [el('span', { cls: 'av', style: 'background: var(--accent); color: var(--accent-ink)', text: 'You' }), ta, saveBtn]));
              pane.appendChild(el('div', { cls: 'iv-foot', text: 'Helpers read these notes when they pick the issue up.' }));
            }
            t.comments.slice().reverse().forEach(function (c) {
              var mine = c.author === 'you' || c.author === 'You';
              pane.appendChild(el('div', { cls: 'iv-cmt' }, [
                mine ? el('span', { cls: 'av', style: 'background: var(--accent); color: var(--accent-ink)', text: 'You' }) : avatar(c.author),
                el('div', { style: 'min-width:0' }, [el('div', { cls: 'who' }, [el('b', { text: mine ? 'You' : helperLabel(c.author) }), el('span', { text: ago(c.created_at) })]), el('div', { cls: 'txt', text: c.text })])
              ]));
            });
          }
          if (!t.comments.length && !canEdit) pane.appendChild(el('div', { cls: 'muted', text: 'No notes.' }));
        } else {
          if (!t.history.length) pane.appendChild(el('div', { cls: 'muted', text: 'No finished work yet.' }));
          t.history.forEach(function (h) {
            pane.appendChild(el('div', { cls: 'iv-cmt' }, [avatar(h.member), el('div', {}, [
              el('div', { cls: 'who' }, [el('b', { text: helperLabel(h.member) }), el('span', { text: dur(h.duration) + (h.endedAt ? ' - ' + ago(new Date(h.endedAt).toISOString()) : '') })]),
              el('div', { cls: 'txt' }, [h.text || h.label, h.success === false ? ' ' : null, h.success === false ? el('span', { cls: 'pill failed', text: 'failed' }) : null])
            ])]));
          });
        }
      }
      [['comments', 'Notes (' + t.comments.length + ')'], ['work', 'Work log (' + t.history.length + ')']].forEach(function (p) {
        tabs.appendChild(el('button', { type: 'button', 'data-k': p[0], text: p[1], onclick: function () { showTab(p[0]); } }));
      });
      main.appendChild(tabs); main.appendChild(pane);
      showTab(which);

      var side = el('div', { cls: 'iv-side' });
      var status = el('div', { cls: 'iv-status' }, [lozenge(col, card && card.skipped)]);
      if (canEdit && (col === 'todo' || col === 'blocked')) status.appendChild(el('button', { cls: 'act', type: 'button', text: 'Won\'t do', title: 'Take it off the sprint; helpers will not build it', onclick: function () {
        if (!confirm('Take this issue off the sprint? Helpers will not build it. You can reopen it later.')) return;
        taskOp(id, 'skip', { reason: 'Skipped from the dashboard' }, 'Marked won\'t do').then(function () { openTask(id); });
      } }));
      if (canEdit && col === 'done') status.appendChild(el('button', { cls: 'act', type: 'button', text: 'Reopen', title: 'Put it back in To do so a helper picks it up again', onclick: function () {
        taskOp(id, 'reopen', {}, 'Reopened').then(function () { openTask(id); });
      } }));
      side.appendChild(status);
      if (working) side.appendChild(el('div', { cls: 'muted' }, [helperLabel(card.working[0].member) + ' is working on it: ' + card.working[0].text]));

      var dl = el('dl', {});
      function row(k, v) { if (v === null || v === undefined || v === '') return; dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', {}, Array.isArray(v) ? v : [v])); }
      var who = card ? whoOf(card) : t.assignee;
      row('Assignee', who ? [avatar(who, !!working), helperLabel(who)] : el('span', { cls: 'muted', text: 'Nobody yet' }));
      var p = t.priority === undefined ? 2 : t.priority;
      if (canEdit && col !== 'done') {
        var ps = el('select', { 'aria-label': 'Priority' });
        PRIO_NAME.forEach(function (n, i) { ps.appendChild(el('option', { value: String(i), text: n + ' (P' + i + ')' })); });
        ps.value = String(p);
        ps.addEventListener('change', function () { taskOp(id, 'update', { priority: Number(ps.value) }, 'Priority changed').then(function () { openTask(id, which); }); });
        row('Priority', [prio(p), ps]);
      } else row('Priority', [prio(p), PRIO_NAME[p] + ' (P' + p + ')']);
      row('Type', [typeIcon(kind), kind.replace(/^./, function (m) { return m.toUpperCase(); })]);
      if (lane) row('Feature', [laneChip(lane)]);
      if (t.metadata && t.metadata.model) row('Model tier', String(t.metadata.model));
      var deps = (t.dependencies || []).filter(function (x) { return x.issue_id === t.id && x.type === 'blocks'; });
      function linkTo(otherId) {
        var o = b ? b.cards.filter(function (c) { return c.id === otherId; })[0] : null;
        return el('span', { cls: 'iv-dep' }, [o ? lozenge(o.column, o.skipped) : null, el('button', { cls: 'iv-link', type: 'button', title: otherId, text: o ? o.title : otherId, onclick: function () { openTask(otherId); } })]);
      }
      if (deps.length) row('Waits on', deps.map(function (x) { return linkTo(x.depends_on_id); }));
      var blocks = b ? b.cards.filter(function (c) { return c.blockedBy.indexOf(id) !== -1; }) : [];
      if (blocks.length) row('Holds up', blocks.map(function (c) { return linkTo(c.id); }));
      var labels = (t.labels || []).filter(function (l) { return l.indexOf('kind:') !== 0; });
      if (labels.length) row('Labels', labels.map(function (l) { return el('span', { cls: 'chip', text: l }); }));
      if (card && !card.inSprint) row('Goal', 'Below this sprint\'s goal');
      side.appendChild(el('div', { cls: 'iv-det' }, [el('div', { text: 'Details' }), dl]));
      var times = [];
      if (t.created_at) times.push('Created ' + ago(t.created_at));
      if (t.updated_at) times.push('Updated ' + ago(t.updated_at));
      if (t.closed_at) times.push('Closed ' + ago(t.closed_at) + (t.close_reason ? ': ' + t.close_reason : ''));
      side.appendChild(el('div', { cls: 'iv-foot', text: times.join(' - ') }));
      if (!canEdit && S.sprint && S.sprint.board && S.sprint.board.live === false) side.appendChild(el('div', { cls: 'iv-foot', text: 'This sprint has finished, so the issue is read-only. Comment on the code to ask for more work.' }));

      var top = el('div', { cls: 'iv-top' }, [
        el('span', { cls: 'crumb' }, [lane ? typeIcon(lane.type) : null, lane ? el('a', { text: lane.id, onclick: function () { openTask(lane.id); } }) : null, lane ? '/' : null, typeIcon(kind), el('span', { cls: 'mono', text: t.id })]),
        el('span', { cls: 'grow' }),
        el('button', { cls: 'act', type: 'button', text: 'Copy id', onclick: function () { navigator.clipboard.writeText(t.id).then(function () { toast('Copied ' + t.id); }, function () { toast(t.id); }); } }),
        el('button', { cls: 'act', type: 'button', 'aria-label': 'Close', text: 'Close', onclick: closeDrawer })
      ]);
      overlay(el('div', { cls: 'iv' }, [top, el('div', { cls: 'iv-body' }, [main, side])]));
    }).catch(function (e) { toast(e.message); });
  }

  function createIssue() {
    var b = S.sprint && S.sprint.board;
    if (!b || !S.sprint.canEdit) return;
    var title = el('input', { type: 'text', maxlength: '200', required: true, placeholder: 'What needs doing?' });
    var type = el('select', {}, [el('option', { value: 'task', text: 'Task' }), el('option', { value: 'bug', text: 'Bug' }), el('option', { value: 'chore', text: 'Chore' })]);
    var pr = el('select', {});
    PRIO_NAME.forEach(function (n, i) { pr.appendChild(el('option', { value: String(i), text: n + ' (P' + i + ')' })); });
    pr.value = '1';
    var parent = el('select', {}, [el('option', { value: '', text: 'The sprint itself' })]);
    b.lanes.forEach(function (l) { if (l.id && !isRoot(l.id)) parent.appendChild(el('option', { value: l.id, text: l.title })); });
    var desc = el('textarea', { placeholder: 'Details a helper needs: where, what, why.' });
    var acc = el('textarea', { placeholder: 'Optional: how to tell it is done.' });
    var btn = el('button', { cls: 'act primary', type: 'submit', text: 'Create' });
    var goalMax = { P1: 1, 'P1/P2': 2, 'P1/P2/P3': 3 }[b.goal] || 2;
    var hint = el('div', { cls: 'hint' });
    function hintText() { hint.textContent = Number(pr.value) > goalMax ? 'This priority is below the sprint\'s goal, so helpers only get to it if everything else is done.' : 'A free helper picks it up on its next look at the task list.'; }
    pr.addEventListener('change', hintText); hintText();
    var form = el('form', { cls: 'ci', onsubmit: function (e) {
      e.preventDefault();
      if (!title.value.trim()) { title.focus(); return; }
      btn.disabled = true; btn.textContent = 'Creating...';
      api('sprints/' + encodeURIComponent(S.runId) + '/tasks', { method: 'POST', body: { title: title.value, type: type.value, priority: Number(pr.value), parent: parent.value || undefined, description: desc.value, acceptance: acc.value } })
        .then(function (r) { closeDrawer(); toast('Created ' + (r.task && r.task.id ? r.task.id : 'the issue')); refresh(true); })
        .catch(function (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Create'; });
    } }, [
      el('h3', { text: 'Create issue' }),
      el('label', { cls: 'wide' }, ['Summary', title]),
      el('label', {}, ['Type', type]),
      el('label', {}, ['Priority', pr]),
      el('label', { cls: 'wide' }, ['Feature', parent]),
      el('label', { cls: 'wide' }, ['Description', desc]),
      el('label', { cls: 'wide' }, ['Acceptance criteria', acc]),
      hint,
      el('div', { cls: 'actions' }, [el('button', { cls: 'act', type: 'button', text: 'Cancel', onclick: closeDrawer }), btn])
    ]);
    overlay(form);
    title.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (document.querySelector('.iv-bg')) { closeDrawer(); e.preventDefault(); } return; }
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!active() || S.view !== 'sprint' || S.sub !== 'board' || document.querySelector('.iv-bg')) return;
    var comp = S.shell && S.shell.comp;
    if (e.key === '/' && comp && comp.focusSearch) { e.preventDefault(); comp.focusSearch(); }
    if (e.key === 'c' && S.sprint && S.sprint.canEdit) { e.preventDefault(); createIssue(); }
  });
`;
