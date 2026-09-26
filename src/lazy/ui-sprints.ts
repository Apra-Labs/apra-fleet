/**
 * Sprints section of the settings page: sprint list, "new sprint" form, and
 * per-sprint Board / Helpers / Code / Log views. String.raw so client-side
 * regexes keep their backslashes; never put a backtick or dollar-brace here.
 */

export const SPRINTS_CSS = String.raw`
body.wide header, body.wide main { max-width: 1440px; }
body.wide .stats { display: none; }
.sp-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.sp-top h2 { margin: 0; font-size: 18px; }
.sp-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.sp-item { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 8px; }
.sp-item:hover { border-color: var(--muted); }
.sp-item h3 { margin: 0; font-size: 15px; line-height: 1.35; }
.sp-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 12.5px; }
.pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; background: var(--chip); color: var(--muted); }
.pill.running, .pill.starting { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
.pill.failed, .pill.stopped, .pill.aborted { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.pill.success { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
.pill.pausing, .pill.paused { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.pill .pulse { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: pulse 1.4s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 60%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.bar { height: 6px; background: var(--chip); border-radius: 999px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--ok); border-radius: 999px; transition: width .4s; }

.sp-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 12px; }
.sp-head h2 { margin: 4px 0 6px; font-size: 20px; letter-spacing: -0.01em; }
.back { background: none; border: 0; color: var(--muted); cursor: pointer; font: inherit; padding: 0; font-size: 13px; }
.back:hover { color: var(--ink); }
.sp-stats { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted); font-size: 13px; align-items: center; }
.sp-stats b { color: var(--ink); font-size: 15px; }
.phases { display: flex; gap: 0; margin: 6px 0 14px; overflow-x: auto; }
.phase { flex: 1 0 auto; min-width: 88px; padding: 7px 12px; font-size: 12.5px; color: var(--muted); background: var(--panel); border: 1px solid var(--line); border-left-width: 0; white-space: nowrap; }
.phase:first-child { border-left-width: 1px; border-radius: 8px 0 0 8px; }
.phase:last-child { border-radius: 0 8px 8px 0; }
.phase.done { color: var(--ink); }
.phase.done::before { content: "[OK] "; color: var(--ok); font-weight: 700; font-size: 11px; }
.phase.current { color: var(--accent); font-weight: 700; background: color-mix(in srgb, var(--accent) 9%, var(--panel)); }
.subnav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 14px; }
.subnav button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; color: var(--muted); font: inherit; font-size: 14px; cursor: pointer; }
.subnav button[aria-selected="true"] { color: var(--ink); border-color: var(--accent); }
.subnav .count { background: var(--chip); border-radius: 999px; padding: 0 7px; font-size: 11px; margin-left: 4px; }

/* board */
.board { overflow-x: auto; padding-bottom: 8px; }
.board-grid { display: grid; grid-template-columns: repeat(4, minmax(230px, 1fr)); gap: 10px; min-width: 960px; }
.col-head { position: sticky; top: 0; z-index: 1; background: var(--bg); padding: 6px 4px 8px; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.col-head .n { background: var(--chip); border-radius: 999px; padding: 0 8px; font-weight: 600; letter-spacing: 0; }
.lane { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; padding: 10px 4px 4px; font-size: 13px; font-weight: 700; cursor: pointer; user-select: none; }
.lane .caret { color: var(--muted); width: 12px; display: inline-block; }
.lane .lane-bar { width: 120px; }
.lane small { color: var(--muted); font-weight: 500; }
.cell { background: color-mix(in srgb, var(--chip) 55%, transparent); border-radius: 10px; padding: 6px; min-height: 54px; display: flex; flex-direction: column; gap: 6px; }
.tcard { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 7px; box-shadow: 0 1px 0 color-mix(in srgb, var(--ink) 6%, transparent); transition: transform .12s, box-shadow .12s; }
.tcard:hover { transform: translateY(-1px); box-shadow: 0 3px 10px color-mix(in srgb, var(--ink) 10%, transparent); }
.tcard.backlog { opacity: .6; }
.tcard.working { border-color: color-mix(in srgb, var(--ok) 55%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--ok) 35%, transparent); }
.tcard .t { font-size: 13.5px; line-height: 1.35; }
.tcard .row { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); }
.tcard .row .grow { flex: 1; }
.ico { width: 14px; height: 14px; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 9px; font-weight: 800; flex: none; }
.ico.task { background: #2563eb; } .ico.bug { background: #dc2626; } .ico.feature, .ico.epic { background: #7c3aed; } .ico.chore { background: #64748b; }
.prio { font-weight: 800; font-size: 11px; }
.prio.p0, .prio.p1 { color: #dc2626; } .prio.p2 { color: #d97706; } .prio.p3, .prio.p4 { color: #64748b; }
.av { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; font-weight: 700; flex: none; position: relative; }
.av.live::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--ok); animation: ring 1.6s infinite; }
@keyframes ring { 0% { opacity: 1; transform: scale(.9); } 100% { opacity: 0; transform: scale(1.35); } }
.working-strip { font-size: 12px; color: var(--ok); display: flex; gap: 6px; align-items: center; }
.empty-col { color: var(--muted); font-size: 12px; text-align: center; padding: 10px 0; }
.stage { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 1px 8px; }
.stage.landing { background: color-mix(in srgb, #2563eb 15%, transparent); color: #2563eb; }
.stage.fixing { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.bounce { font-size: 11px; color: var(--warn); }
.feed { margin-top: 14px; }
.feed .ev { display: flex; gap: 10px; font-size: 13px; padding: 7px 12px; border-bottom: 1px solid var(--line); align-items: center; }
.feed .ev:last-child { border-bottom: 0; }
.feed .ev .when { color: var(--muted); width: 96px; flex: none; white-space: nowrap; }
.feed .ev.landed .what { color: var(--ok); }
.feed .ev.bounce .what, .feed .ev.given-back .what { color: var(--warn); }

/* helpers */
.helpers-grid { display: grid; gap: 10px; }
.helper { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: grid; grid-template-columns: 220px 1fr; gap: 14px; align-items: center; }
.helper .who { display: flex; gap: 10px; align-items: center; }
.helper .who .av { width: 32px; height: 32px; font-size: 12px; }
.helper .now { font-size: 13px; }
.helper .now .idle { color: var(--muted); }
.gantt { position: relative; height: 22px; background: var(--chip); border-radius: 6px; margin-top: 8px; overflow: hidden; }
.gantt i { position: absolute; top: 3px; bottom: 3px; border-radius: 4px; min-width: 3px; opacity: .85; }
.gantt i.run { animation: glow 1.6s infinite alternate; }
@keyframes glow { from { opacity: .6; } to { opacity: 1; } }
.axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin: 2px 0 0 234px; }
@media (max-width: 760px) { .helper { grid-template-columns: 1fr; } .axis { margin-left: 0; } }

/* code */
.code-grid { display: grid; grid-template-columns: 340px 1fr; gap: 12px; align-items: start; }
@media (max-width: 900px) { .code-grid { grid-template-columns: 1fr; } }
.side { display: flex; flex-direction: column; gap: 12px; }
.list { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.list h4 { margin: 0; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border-bottom: 1px solid var(--line); }
.list button { display: flex; width: 100%; gap: 8px; align-items: center; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); padding: 8px 12px; font: inherit; font-size: 12.5px; color: var(--ink); cursor: pointer; }
.list button:last-child { border-bottom: 0; }
.list button:hover, .list button.on { background: var(--chip); }
.list .path { flex: 1; font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.plus { color: var(--ok); font-family: var(--mono); font-size: 12px; } .minus { color: var(--bad); font-family: var(--mono); font-size: 12px; }
.diff { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: auto; max-height: 72vh; }
.diff pre { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.5; }
.diff .ln { display: block; padding: 0 12px; white-space: pre; }
.diff .ln.a { background: color-mix(in srgb, var(--ok) 13%, transparent); }
.diff .ln.d { background: color-mix(in srgb, var(--bad) 12%, transparent); }
.diff .ln.h { color: var(--accent); background: var(--chip); }
.diff .ln.m { color: var(--muted); }
.diff .ph { padding: 30px; color: var(--muted); text-align: center; font-family: inherit; }

/* setup / log / drawer / form */
.steps { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: grid; gap: 8px; font-size: 14px; }
.steps .s.bad { color: var(--bad); }
.steps .s.ok::before { content: "[OK] "; color: var(--ok); font-weight: 700; font-size: 12px; }
pre.log { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; font-family: var(--mono); font-size: 12px; max-height: 70vh; overflow: auto; white-space: pre-wrap; margin: 0; }
.drawer-bg { position: fixed; inset: 0; background: color-mix(in srgb, #000 35%, transparent); z-index: 20; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100vw); background: var(--panel); border-left: 1px solid var(--line); z-index: 21; overflow: auto; padding: 18px 20px 40px; }
.drawer h3 { margin: 6px 0 12px; font-size: 18px; line-height: 1.35; }
.drawer .kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; font-size: 13px; margin-bottom: 14px; }
.drawer .kv span:nth-child(odd) { color: var(--muted); }
.drawer .block { white-space: pre-wrap; font-size: 13.5px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 4px 0 14px; }
.drawer h4 { margin: 12px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.close-x { float: right; }
.form-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-card .wide { grid-column: 1 / -1; }
.form-card label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.form-card label.inline { flex-direction: row; align-items: center; gap: 8px; color: var(--ink); }
.form-card textarea, .form-card select { background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: inherit; }
.form-card textarea { min-height: 90px; resize: vertical; }
.form-card .actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 640px) { .form-card { grid-template-columns: 1fr; } }

.track { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.track .st { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 3px 9px; font-size: 12.5px; line-height: 1.4; }
.track .st b { font-weight: 600; }
.track .st small { color: var(--muted); margin-left: 6px; }
.track .st.off { opacity: .5; text-decoration: line-through; }
.track .st.custom { border-style: dashed; }
.track .st.now { border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok) inset; }
.track .to { color: var(--muted); font-size: 12px; }
.dz { display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: 16px; align-items: start; }
.dz-list { display: flex; flex-direction: column; gap: 8px; }
.dz-item { text-align: left; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; cursor: pointer; color: var(--ink); font: inherit; display: flex; flex-direction: column; gap: 4px; }
.dz-item:hover { border-color: var(--muted); }
.dz-item.on { border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok) inset; }
.dz-item .src { font-size: 11px; color: var(--muted); }
.dz-item p { margin: 0; font-size: 12.5px; color: var(--muted); }
.dz-ed { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.dz-ed h3 { margin: 0; font-size: 16px; }
.dz-sec { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px 12px; border-top: 1px solid var(--line); padding-top: 12px; }
.dz-sec > h4 { grid-column: 1 / -1; margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.dz-sec label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.dz-sec label.inline { flex-direction: row; align-items: center; gap: 8px; color: var(--ink); }
.dz-ed input[type=text], .dz-ed input[type=number], .dz-ed select, .dz-ed textarea { background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; font: inherit; min-width: 0; }
.dz-ed textarea { min-height: 70px; resize: vertical; }
.dz-blk { grid-column: 1 / -1; border: 1px dashed var(--line); border-radius: 10px; padding: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px 10px; }
.dz-blk .wide { grid-column: 1 / -1; }
.dz-blk .row { display: flex; gap: 6px; justify-content: flex-end; grid-column: 1 / -1; }
.dz-msg { font-size: 13px; }
.dz-msg.bad { color: var(--bad); }
.dz-msg.ok { color: var(--ok); }
.dz-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.chip-d { font-size: 11.5px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--muted); }
.pill.verdict-fail { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.pill.verdict-pass { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
@media (max-width: 820px) { .dz { grid-template-columns: 1fr; } }
`;

export const SPRINTS_HTML = String.raw`
  <section id="tab-sprints" hidden>
    <div id="sp-root"></div>
  </section>
`;

export const SPRINTS_JS = String.raw`
(function () {
  var root = document.getElementById('sp-root');
  var S = { view: 'list', runId: null, sub: 'board', list: [], sprint: null, code: null, diffKey: null, collapsed: {}, timer: null, formOpen: false, designs: null, defaultDesign: 'pipeline', designId: null, draft: null, formDesign: null };

  function api(path, opts) {
    opts = opts || {};
    return fetch('/_lazy/api/' + path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-lazy': '1' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'cls') e.className = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function toast(m) { var t = document.getElementById('toast'); t.textContent = m; t.classList.add('on'); setTimeout(function () { t.classList.remove('on'); }, 2000); }
  function hue(name) {
    // Golden-angle spread so lz-x-0, lz-x-1, lz-x-2 get clearly different colors.
    var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100003;
    return Math.round((h * 137.508) % 360);
  }
  function helperLabel(name) {
    // lz-<project>-<n> reads better as "Helper n+1"
    var m = /^lz-.+-(\d+)$/.exec(name || '');
    return m ? 'Helper ' + (Number(m[1]) + 1) : (name || 'helper');
  }
  function avatar(name, live) {
    var label = helperLabel(name);
    var initials = /^Helper (\d+)$/.test(label) ? 'H' + label.split(' ')[1] : label.slice(0, 2).toUpperCase();
    return el('span', { cls: 'av' + (live ? ' live' : ''), style: 'background: hsl(' + hue(name || '') + ' 55% 42%)', title: label }, [initials]);
  }
  function dur(ms) {
    if (ms === undefined || ms === null || isNaN(ms)) return '-';
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function ago(iso) { if (!iso) return '-'; return dur(Date.now() - Date.parse(iso)) + ' ago'; }
  function money(n) { return '$' + (n || 0).toFixed(2); }
  function statusPill(status) {
    var live = status === 'running' || status === 'starting';
    var labels = { running: 'Running', starting: 'Starting', success: 'Done', failed: 'Failed', stopped: 'Stopped', aborted: 'Stopped', pausing: 'Pausing', paused: 'Paused', finished: 'Finished' };
    return el('span', { cls: 'pill ' + status }, [live ? el('span', { cls: 'pulse' }) : null, labels[status] || status]);
  }
  function verdictPill(v) {
    return el('span', { cls: 'pill ' + (v === 'PASS' ? 'verdict-pass' : 'verdict-fail'), title: 'The final review verdict' }, [v === 'PASS' ? 'Passed review' : 'Review: ' + v]);
  }
  function track(steps, nowStep) {
    var t = el('div', { cls: 'track' });
    (steps || []).forEach(function (st, i) {
      if (i) t.appendChild(el('span', { cls: 'to', text: '->' }));
      var custom = ['Plan', 'Build', 'Review', 'Test', 'Final review', 'Wrap up'].indexOf(st.step) === -1;
      t.appendChild(el('span', { cls: 'st' + (st.on ? '' : ' off') + (custom ? ' custom' : '') + (nowStep && st.step === nowStep ? ' now' : ''), title: st.detail }, [el('b', { text: st.step }), st.on && st.detail ? el('small', { text: st.detail }) : null]));
    });
    return t;
  }
  function bar(done, total) { var pct = total ? Math.round(done * 100 / total) : 0; return el('div', { cls: 'bar' }, [el('i', { style: 'width:' + pct + '%' })]); }
  function typeIcon(type) {
    var t = type === 'bug' ? 'bug' : type === 'feature' || type === 'epic' ? 'feature' : type === 'chore' ? 'chore' : 'task';
    var glyph = { bug: '!', feature: '*', chore: '~', task: '+' }[t];
    return el('span', { cls: 'ico ' + (type === 'epic' ? 'epic' : t), title: type }, [glyph]);
  }
  function prio(p) { return el('span', { cls: 'prio p' + p, title: 'Priority ' + p }, ['P' + p]); }

  // ---- routing -------------------------------------------------------------
  function parseHash() {
    var parts = location.hash.slice(1).split('/');
    if (parts[0] !== 'sprints') return false;
    if (parts[1] === 'designs') {
      S.view = 'designs'; S.runId = null; S.designId = parts[2] || null;
      return true;
    }
    S.runId = parts[1] || null;
    S.view = S.runId ? 'sprint' : 'list';
    S.sub = parts[2] || 'board';
    return true;
  }
  function go(runId, sub) {
    var h = '#sprints' + (runId ? '/' + runId + (sub && sub !== 'board' ? '/' + sub : '') : '');
    history.replaceState(null, '', h);
    parseHash();
    S.sprint = null; S.code = null; S.diffKey = null;
    refresh(true);
  }
  function goDesigns(id) {
    history.replaceState(null, '', '#sprints/designs' + (id ? '/' + id : ''));
    parseHash();
    S.draft = null;
    refresh(true);
  }
  function active() { return !document.getElementById('tab-sprints').hidden; }
  function loadDesigns() {
    return api('designs').then(function (r) { S.designs = r.designs; S.defaultDesign = r['default']; return r.designs; });
  }

  // ---- data ----------------------------------------------------------------
  function refresh(force) {
    if (!active()) return;
    if (S.view === 'designs') {
      if (force || !S.designs) loadDesigns().then(render).catch(function (e) { renderError(e); });
      return;
    }
    if (S.view === 'list') {
      api('sprints').then(function (r) { S.list = r.sprints; render(); }).catch(function (e) { renderError(e); });
    } else {
      api('sprints/' + encodeURIComponent(S.runId)).then(function (r) {
        S.sprint = r;
        if (S.sub === 'code' && (force || !S.code)) loadCode();
        if (S.sub === 'log') loadLog();
        render();
      }).catch(function (e) { renderError(e); });
    }
  }
  function loadCode() {
    api('sprints/' + encodeURIComponent(S.runId) + '/code').then(function (c) {
      S.code = c; render();
      if (!S.diffKey && c.available && c.files.length) showDiff('f:' + c.files[0].path, 'code/file?path=' + encodeURIComponent(c.files[0].path));
    });
  }
  function loadLog() {
    api('sprints/' + encodeURIComponent(S.runId) + '/log?tail=400').then(function (r) { S.log = r.log; if (S.sub === 'log') render(); });
  }
  function schedule() {
    clearInterval(S.timer);
    S.timer = setInterval(function () {
      if (!active()) return;
      // Live seconds tick without refetching.
      document.querySelectorAll('[data-since]').forEach(function (n) { n.textContent = dur(Date.now() - Number(n.getAttribute('data-since'))); });
    }, 1000);
    setInterval(function () { if (active() && !document.querySelector('.drawer') && !(S.formOpen && S.view === 'list')) refresh(false); }, 3000);
  }

  // ---- render --------------------------------------------------------------
  function renderError(e) { root.textContent = ''; root.appendChild(el('div', { cls: 'empty' }, ['Could not load sprints: ' + e.message])); }

  function render() {
    document.body.classList.toggle('wide', active());
    if (S.view === 'list') return renderList();
    if (S.view === 'designs') return renderDesigns();
    return renderSprint();
  }

  function renderList() {
    // Keep the form (and whatever is being typed) across refreshes.
    var keepForm = S.formOpen ? root.querySelector('.form-card') : null;
    root.textContent = '';
    root.appendChild(el('div', { cls: 'sp-top' }, [
      el('h2', { text: 'Sprints' }),
      el('div', { style: 'display:flex; gap:8px' }, [
        el('button', { cls: 'act', type: 'button', text: 'Sprint designs', onclick: function () { goDesigns(null); } }),
        el('button', { cls: 'act primary', type: 'button', text: S.formOpen ? 'Close' : 'New sprint', onclick: function () { S.formOpen = !S.formOpen; render(); } })
      ])
    ]));
    if (S.formOpen) root.appendChild(keepForm || newSprintForm());
    if (!S.list.length) {
      root.appendChild(el('div', { cls: 'card empty-state' }, [el('div', { cls: 'empty', text: 'No sprints yet. Start one: describe what you want done, pick the project folder, and helpers plan it, split it into issues and work them in parallel.' })]));
      return;
    }
    var grid = el('div', { cls: 'sp-list' });
    S.list.forEach(function (s) {
      grid.appendChild(el('div', { cls: 'sp-item', onclick: function () { go(s.runId); } }, [
        el('div', { cls: 'sp-meta' }, [statusPill(s.status), s.verdict ? verdictPill(s.verdict) : null, s.currentPhase ? el('span', { text: s.currentPhase }) : null, s.design ? el('span', { cls: 'chip-d', text: s.design }) : null, el('span', { text: ago(s.startedAt) })]),
        el('h3', { text: s.title }),
        bar(s.progress.done, s.progress.total),
        el('div', { cls: 'sp-meta' }, [
          el('span', { text: s.progress.total ? s.progress.done + ' of ' + s.progress.total + ' done' : (s.status === 'starting' ? 'Setting up' : 'Planning') }),
          s.working ? el('span', { text: s.working + ' working now' }) : null,
          el('span', { text: s.helpers + ' helper' + (s.helpers === 1 ? '' : 's') }),
          s.cost ? el('span', { text: money(s.cost) }) : null
        ])
      ]));
    });
    root.appendChild(grid);
  }

  function newSprintForm() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem('lazy.sprintForm') || '{}'); } catch (e) {}
    var repo = el('input', { type: 'text', placeholder: '/home/you/code/my-app', required: true, value: saved.repo || '' });
    var ask = el('textarea', { placeholder: 'e.g. Add a dark mode with a toggle in settings, remember the choice, and cover it with tests.' });
    var helpers = el('input', { type: 'number', min: '1', max: '64', placeholder: 'no limit', value: saved.maxHelpers ? String(saved.maxHelpers) : '' });
    var gate = el('input', { type: 'text', placeholder: 'optional, e.g. npm ci && npm test', value: saved.gateCommand || '' });
    var goal = el('select', {}, [
      el('option', { value: 'P1', text: 'Must-haves only' }),
      el('option', { value: 'P1/P2', text: 'Must-haves and should-haves' }),
      el('option', { value: 'P1/P2/P3', text: 'Everything it finds' })
    ]);
    goal.value = saved.goal || 'P1/P2';
    var base = el('input', { type: 'text', placeholder: 'current branch', value: saved.base || '' });
    var budget = el('input', { type: 'number', min: '0', step: '1', placeholder: 'no limit' });
    var publish = el('input', { type: 'checkbox' });
    var design = el('select', {});
    var designAbout = el('div', { cls: 'wide', style: 'display:flex; flex-direction:column; gap:6px' });
    function showDesign() {
      var d = (S.designs || []).filter(function (x) { return x.id === design.value; })[0];
      designAbout.textContent = '';
      if (!d) return;
      designAbout.appendChild(el('div', { style: 'font-size:13px; color: var(--muted)', text: d.description }));
      designAbout.appendChild(track(d.steps));
    }
    function fillDesigns() {
      design.textContent = '';
      (S.designs || []).forEach(function (d) { design.appendChild(el('option', { value: d.id, text: d.name + (d.source === 'built-in' ? '' : d.source === 'project' ? ' (this project)' : ' (yours)') })); });
      design.value = S.formDesign || saved.design || S.defaultDesign;
      if (!design.value && S.designs && S.designs.length) design.value = S.designs[0].id;
      showDesign();
    }
    design.addEventListener('change', showDesign);
    if (S.designs) fillDesigns(); else loadDesigns().then(fillDesigns);
    var btn = el('button', { cls: 'act primary', type: 'submit', text: 'Start sprint' });
    var form = el('form', { cls: 'form-card', onsubmit: function (e) {
      e.preventDefault();
      var body = { repo: repo.value.trim(), ask: ask.value, goal: goal.value, base: base.value.trim() || undefined, publish: publish.checked, design: design.value || undefined };
      if (helpers.value) body.maxHelpers = Number(helpers.value);
      if (gate.value.trim()) body.gateCommand = gate.value.trim();
      if (budget.value) body.budget = Number(budget.value);
      try { localStorage.setItem('lazy.sprintForm', JSON.stringify({ repo: body.repo, maxHelpers: body.maxHelpers, gateCommand: body.gateCommand, goal: body.goal, base: base.value.trim(), design: body.design })); } catch (e2) {}
      S.formDesign = null;
      btn.disabled = true; btn.textContent = 'Starting...';
      api('sprints', { method: 'POST', body: body }).then(function (r) { S.formOpen = false; toast('Sprint started'); go(r.runId); })
        .catch(function (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Start sprint'; });
    } }, [
      el('label', { cls: 'wide' }, ['What should get done?', ask]),
      el('label', { cls: 'wide' }, ['Sprint design', design]),
      designAbout,
      el('label', {}, ['Project folder', repo]),
      el('label', {}, ['Start from branch', base]),
      el('label', { title: 'Every ready task starts at once. Set a number only if you want to hold back.' }, ['Most helpers at once', helpers]),
      el('label', {}, ['How far to go', goal]),
      el('label', { title: 'An estimate from token prices. With a Claude subscription this is plan usage, not money.' }, ['Usage limit (estimated $)', budget]),
      el('label', { cls: 'wide', title: 'Runs in a fresh copy of your project, so include any install step. Overrides the design check.' }, ['Check after each merge (a failing check sends the work back to its helper)', gate]),
      el('label', { cls: 'inline' }, [publish, 'Open a pull request when done (otherwise the work lands as a branch in your project)']),
      el('div', { cls: 'actions' }, [btn])
    ]);
    return form;
  }

  function renderSprint() {
    root.textContent = '';
    var v = S.sprint;
    root.appendChild(el('button', { cls: 'back', type: 'button', text: '<- All sprints', onclick: function () { go(null); } }));
    if (!v) { root.appendChild(el('div', { cls: 'empty', text: 'Loading...' })); return; }
    var b = v.board, rec = v.record;
    var title = (b && b.title) || (rec && rec.title) || S.runId;
    var live = v.status === 'running' || v.status === 'starting' || v.status === 'pausing' || v.status === 'paused';

    var stats = el('div', { cls: 'sp-stats' }, [statusPill(v.status), v.verdict ? verdictPill(v.verdict) : null, v.design ? el('span', { cls: 'chip-d', title: 'Sprint design', text: v.design.name }) : null]);
    if (b) {
      stats.appendChild(el('span', {}, [el('b', { text: b.progress.done + '/' + b.progress.total }), ' done']));
      if (b.pipeline && b.live) {
        stats.appendChild(el('span', {}, [el('b', { text: String(b.pipeline.building) }), ' building']));
        if (b.pipeline.landing) stats.appendChild(el('span', {}, [el('b', { text: String(b.pipeline.landing) }), ' landing']));
        if (b.pipeline.waitingForMember) stats.appendChild(el('span', { title: 'Ready tasks waiting for a helper; more helpers are being added' }, [el('b', { text: String(b.pipeline.waitingForMember) }), ' waiting for a helper']));
        stats.appendChild(el('span', {}, [el('b', { text: String(b.pipeline.builders) }), ' helpers' + (b.pipeline.limit ? ' (limit ' + b.pipeline.limit + ')' : '')]));
      } else {
        stats.appendChild(el('span', {}, [el('b', { text: String(b.helpersNow.length) }), ' working now']));
      }
      stats.appendChild(el('span', {}, [el('b', { text: money(b.cost) }), ' spent']));
      if (b.startedAt) stats.appendChild(el('span', {}, [el('b', { text: dur((b.endedAt ? Date.parse(b.endedAt) : Date.now()) - Date.parse(b.startedAt)) }), ' elapsed']));
    }
    if (rec) stats.appendChild(el('span', { cls: 'mono', text: rec.branch }));
    var actions = el('div', {}, [live && rec ? el('button', { cls: 'act danger', type: 'button', text: 'Stop sprint', onclick: function () {
      if (!confirm('Stop this sprint? Work done so far stays on its branch.')) return;
      api('sprints/' + encodeURIComponent(S.runId) + '/stop', { method: 'POST' }).then(function () { toast('Stopping'); refresh(true); });
    } }) : null]);
    root.appendChild(el('div', { cls: 'sp-head' }, [el('div', {}, [el('h2', { text: title }), stats]), actions]));
    if (b) root.appendChild(v.design && v.design.steps && v.design.steps.length ? designBar(v.design, b) : phaseBar(b));

    if (!b) {
      root.appendChild(setupSteps(rec));
      return;
    }
    if (b.progress.total) root.appendChild(el('div', { style: 'margin: -6px 0 12px' }, [bar(b.progress.done, b.progress.total)]));

    var tabs = [['board', 'Board', b.cards.length], ['helpers', 'Helpers', b.helpersNow.length], ['code', 'Code changes', S.code && S.code.available ? S.code.totals.files : null], ['log', 'Log', null]];
    var nav = el('div', { cls: 'subnav' });
    tabs.forEach(function (t) {
      nav.appendChild(el('button', { type: 'button', 'aria-selected': S.sub === t[0] ? 'true' : 'false', onclick: function () { go(S.runId, t[0]); } }, [t[1], t[2] !== null && t[2] !== undefined ? el('span', { cls: 'count', text: String(t[2]) }) : null]));
    });
    root.appendChild(nav);
    if (S.sub === 'helpers') return root.appendChild(helpersView(b));
    if (S.sub === 'code') return root.appendChild(codeView());
    if (S.sub === 'log') return root.appendChild(el('pre', { cls: 'log', text: S.log || 'No log yet.' }));
    root.appendChild(boardView(b));
    if (rec && rec.setup && rec.setup.state !== 'started') root.appendChild(setupSteps(rec));
  }

  // Which design step the engine is on now, from its current phase title.
  function stepNow(b, design) {
    var t = String(b.currentPhase || '');
    if (!b.live || !t) return null;
    var m = /^Block: (.+?)( C\d+)?$/.exec(t);
    if (m) return m[1];
    if (/^Final Review/i.test(t)) return 'Final review';
    var cur = (b.stages || []).filter(function (x) { return x.state === 'current'; })[0];
    return cur ? cur.stage : null;
  }
  function designBar(design, b) {
    var wrap = el('div', { style: 'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom: 12px' });
    wrap.appendChild(track(design.steps.filter(function (st) { return st.on; }), stepNow(b, design)));
    if (b.cycle > 1) wrap.appendChild(el('span', { cls: 'chip-d', title: 'The sprint loops back when review or testing finds more to do', text: 'Round ' + b.cycle }));
    return wrap;
  }
  function phaseBar(b) {
    var wrap = el('div', { cls: 'phases' });
    (b.stages || []).forEach(function (st) {
      wrap.appendChild(el('div', { cls: 'phase' + (st.state === 'current' ? ' current' : st.state === 'done' ? ' done' : ''), text: st.stage }));
    });
    if (b.cycle > 1) wrap.appendChild(el('div', { cls: 'phase', title: 'The sprint loops back when review or testing finds more to do', text: 'Round ' + b.cycle }));
    return wrap;
  }

  function setupSteps(rec) {
    var box = el('div', { cls: 'steps' });
    if (!rec) return box;
    rec.setup.steps.forEach(function (s) { box.appendChild(el('div', { cls: 's ' + (s.ok ? 'ok' : 'bad'), text: s.text })); });
    if (rec.setup.state === 'preparing') box.appendChild(el('div', { cls: 's', text: 'Working on it...' }));
    if (rec.setup.state === 'started' && !rec.setup.error) box.appendChild(el('div', { cls: 's', text: 'Waiting for the helpers to report in...' }));
    return box;
  }

  // ---- board ---------------------------------------------------------------
  function boardView(b) {
    var wrap = el('div', { cls: 'board' });
    if (!b.cards.length) {
      wrap.appendChild(el('div', { cls: 'empty', text: b.live ? 'Helpers are planning - issues appear here as they are created.' : 'This sprint has no issues.' }));
      return wrap;
    }
    var grid = el('div', { cls: 'board-grid' });
    b.columns.forEach(function (c) {
      var n = b.cards.filter(function (x) { return x.column === c.key; }).length;
      grid.appendChild(el('div', { cls: 'col-head' }, [c.title, el('span', { cls: 'n', text: String(n) })]));
    });
    b.lanes.forEach(function (lane) {
      var collapsed = S.collapsed[lane.id || '_'];
      if (b.lanes.length > 1 || lane.id) {
        grid.appendChild(el('div', { cls: 'lane', onclick: function () { S.collapsed[lane.id || '_'] = !collapsed; render(); } }, [
          el('span', { cls: 'caret', text: collapsed ? '>' : 'v' }),
          lane.id ? typeIcon(lane.type) : null,
          el('span', { text: lane.title }),
          lane.id ? el('small', { cls: 'mono', text: lane.id }) : null,
          el('div', { cls: 'bar lane-bar' }, [el('i', { style: 'width:' + (lane.total ? Math.round(lane.done * 100 / lane.total) : 0) + '%' })]),
          el('small', { text: lane.done + '/' + lane.total })
        ]));
      }
      if (collapsed) return;
      b.columns.forEach(function (c) {
        var cell = el('div', { cls: 'cell' });
        b.cards.filter(function (x) { return x.lane === lane.id && x.column === c.key; }).forEach(function (card) { cell.appendChild(cardEl(card)); });
        grid.appendChild(cell);
      });
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function cardEl(c) {
    var live = c.working.length > 0;
    var who = live ? c.working[0].member : c.lastHelper;
    var kids = [
      el('div', { cls: 't', text: c.title }),
      live ? el('div', { cls: 'working-strip' }, [el('span', { text: helperLabel(c.working[0].member) + ' working' }), el('span', { 'data-since': c.working[0].since, text: dur(Date.now() - c.working[0].since) })]) : null,
      c.blockedBy.length && c.column === 'blocked' ? el('div', { cls: 'row', text: 'Waiting on ' + c.blockedBy.join(', ') }) : null,
      c.stage === 'landing' || c.stage === 'fixing' || c.bounces ? el('div', { cls: 'row' }, [
        c.stage === 'landing' ? el('span', { cls: 'stage landing', text: 'Landing' }) : null,
        c.stage === 'fixing' ? el('span', { cls: 'stage fixing', text: 'Fixing after a failed landing' }) : null,
        c.bounces ? el('span', { cls: 'bounce', text: 'sent back ' + c.bounces + 'x' }) : null
      ]) : null,
      el('div', { cls: 'row' }, [typeIcon(c.type), el('span', { cls: 'mono', text: c.id }), el('span', { cls: 'grow' }), c.model ? el('span', { cls: 'chip', text: c.model }) : null, prio(c.priority), who ? avatar(who, live) : null])
    ];
    return el('div', { cls: 'tcard' + (live ? ' working' : '') + (c.inSprint ? '' : ' backlog'), title: c.inSprint ? '' : 'Below this sprint\'s goal', onclick: function () { openTask(c.id); } }, kids);
  }

  function openTask(id) {
    api('sprints/' + encodeURIComponent(S.runId) + '/tasks/' + encodeURIComponent(id)).then(function (t) {
      closeDrawer();
      var bg = el('div', { cls: 'drawer-bg', onclick: closeDrawer });
      var d = el('div', { cls: 'drawer' });
      d.appendChild(el('button', { cls: 'act close-x', type: 'button', text: 'Close', onclick: closeDrawer }));
      d.appendChild(el('div', { cls: 'row sp-meta' }, [typeIcon(t.issue_type || 'task'), el('span', { cls: 'mono', text: t.id }), prio(t.priority === undefined ? 2 : t.priority), el('span', { cls: 'pill', text: (t.status || 'open').replace('_', ' ') })]));
      d.appendChild(el('h3', { text: t.title || t.id }));
      var kv = el('div', { cls: 'kv' });
      [['Assignee', t.assignee], ['Model tier', t.metadata && t.metadata.model], ['Started', t.started_at && ago(t.started_at)], ['Closed', t.closed_at && ago(t.closed_at)], ['Close reason', t.close_reason]].forEach(function (p) {
        if (!p[1]) return; kv.appendChild(el('span', { text: p[0] })); kv.appendChild(el('span', { text: String(p[1]) }));
      });
      var deps = (t.dependencies || []).filter(function (x) { return x.issue_id === t.id && x.type !== 'parent-child'; });
      if (deps.length) { kv.appendChild(el('span', { text: 'Depends on' })); kv.appendChild(el('span', { cls: 'mono', text: deps.map(function (x) { return x.depends_on_id; }).join(', ') })); }
      d.appendChild(kv);
      [['Description', t.description], ['Acceptance criteria', t.acceptance_criteria], ['Notes', t.notes]].forEach(function (p) {
        if (!p[1]) return; d.appendChild(el('h4', { text: p[0] })); d.appendChild(el('div', { cls: 'block', text: p[1] }));
      });
      d.appendChild(el('h4', { text: 'Work on this issue' }));
      if (!t.history.length) d.appendChild(el('div', { cls: 'note', text: 'No finished work yet.' }));
      t.history.forEach(function (h) {
        d.appendChild(el('div', { cls: 'row sp-meta', style: 'margin: 6px 0' }, [avatar(h.member), el('span', { text: helperLabel(h.member) + ' - ' + (h.text || h.label) }), el('span', { text: dur(h.duration) }), h.success === false ? el('span', { cls: 'pill failed', text: 'failed' }) : null]));
      });
      document.body.appendChild(bg); document.body.appendChild(d);
    }).catch(function (e) { toast(e.message); });
  }
  function closeDrawer() { document.querySelectorAll('.drawer, .drawer-bg').forEach(function (n) { n.remove(); }); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  // ---- helpers -------------------------------------------------------------
  function helpersView(b) {
    var wrap = el('div', {});
    var names = b.members.slice();
    b.helpersNow.concat(b.recent).forEach(function (a) { if (a.member && names.indexOf(a.member) === -1) names.push(a.member); });
    if (!names.length) { wrap.appendChild(el('div', { cls: 'empty', text: 'No helpers have reported yet.' })); return wrap; }
    var t0 = b.startedAt ? Date.parse(b.startedAt) : Date.now() - 3600000;
    var t1 = b.endedAt ? Date.parse(b.endedAt) : Date.now();
    var span = Math.max(t1 - t0, 60000);
    var grid = el('div', { cls: 'helpers-grid' });
    names.forEach(function (name) {
      var now = b.helpersNow.filter(function (a) { return a.member === name; });
      var done = b.recent.filter(function (a) { return a.member === name; });
      var nowBox = el('div', { cls: 'now' });
      if (now.length) {
        now.forEach(function (a) {
          nowBox.appendChild(el('div', {}, [el('b', { text: a.text || a.label || a.phase || 'working' }), ' ', el('span', { cls: 'chip', text: a.phase || '' }), ' ', el('span', { 'data-since': a.since, text: dur(Date.now() - a.since) })]));
        });
      } else {
        nowBox.appendChild(el('div', { cls: 'idle', text: done.length ? 'Idle - last: ' + (done[0].text || done[0].label) : 'Waiting for work' }));
      }
      var g = el('div', { cls: 'gantt' });
      done.concat(now.map(function (a) { return { member: a.member, label: a.text || a.label, run: true, since: a.since }; })).forEach(function (a) {
        var start = a.run ? a.since : (a.endedAt || 0) - (a.duration || 0);
        var end = a.run ? Date.now() : a.endedAt;
        if (!start || !end) return;
        var left = Math.max(0, (start - t0) * 100 / span), width = Math.max(0.4, (end - start) * 100 / span);
        g.appendChild(el('i', { cls: a.run ? 'run' : '', title: a.text || a.label, style: 'left:' + left + '%;width:' + width + '%;background:hsl(' + hue(name) + ' 55% 48%)' }));
      });
      nowBox.appendChild(g);
      grid.appendChild(el('div', { cls: 'helper' }, [el('div', { cls: 'who' }, [avatar(name, now.length > 0), el('div', {}, [el('div', { text: helperLabel(name) }), el('div', { cls: 'sp-meta', text: now.length ? 'working' : 'idle' })])]), nowBox]));
    });
    wrap.appendChild(grid);
    wrap.appendChild(el('div', { cls: 'axis' }, [el('span', { text: 'start' }), el('span', { text: b.endedAt ? 'end' : 'now' })]));
    if (b.pipeline && b.pipeline.events.length) {
      var titleOf = {};
      b.cards.forEach(function (c) { titleOf[c.id] = c.title; });
      var words = {
        started: function (e) { return helperLabel(e.member) + ' started ' + (titleOf[e.taskId] || e.taskId); },
        landed: function (e) { return 'Landed ' + (titleOf[e.taskId] || e.taskId) + (e.detail ? ' (' + e.detail + ')' : ''); },
        bounce: function (e) { return 'Sent ' + (titleOf[e.taskId] || e.taskId) + ' back to ' + helperLabel(e.member) + ': ' + (e.detail || ''); },
        'given-back': function (e) { return 'Gave up on ' + (titleOf[e.taskId] || e.taskId) + ' for now: ' + (e.detail || ''); },
        notified: function (e) {
          var d = (e.detail || '').replace(/^about /, '');
          var overlap = d.indexOf('(overlap)') !== -1;
          return 'Told ' + helperLabel(e.member) + ' that ' + d.replace(' (overlap)', '') + ' landed' + (overlap ? ' - it touches the same files, pulling it in now' : '');
        }
      };
      var feed = el('div', { cls: 'list feed' }, [el('h4', { text: 'What happened' })]);
      b.pipeline.events.forEach(function (e) {
        var say = words[e.kind] ? words[e.kind](e) : e.kind + ' ' + e.taskId;
        feed.appendChild(el('div', { cls: 'ev ' + e.kind }, [el('span', { cls: 'when', text: ago(e.at) }), el('span', { cls: 'what', text: say })]));
      });
      wrap.appendChild(feed);
    }
    return wrap;
  }

  // ---- code ----------------------------------------------------------------
  function codeView() {
    var c = S.code;
    if (!c) return el('div', { cls: 'empty', text: 'Loading changes...' });
    if (!c.available) return el('div', { cls: 'empty', text: c.reason || 'No changes yet.' });
    var side = el('div', { cls: 'side' });
    side.appendChild(el('div', { cls: 'sp-stats' }, [el('span', {}, [el('b', { text: String(c.totals.files) }), ' files']), el('span', { cls: 'plus', text: '+' + c.totals.added }), el('span', { cls: 'minus', text: '-' + c.totals.removed }), el('span', {}, [el('b', { text: String(c.commits.length) }), ' commits'])]));
    var files = el('div', { cls: 'list' }, [el('h4', { text: 'Files' })]);
    c.files.forEach(function (f) {
      var key = 'f:' + f.path;
      files.appendChild(el('button', { type: 'button', cls: S.diffKey === key ? 'on' : '', title: f.path, onclick: function () { showDiff(key, 'code/file?path=' + encodeURIComponent(f.path)); } }, [el('span', { cls: 'path', text: f.path }), f.binary ? el('span', { cls: 'chip', text: 'binary' }) : el('span', { cls: 'plus', text: '+' + f.added }), f.binary ? null : el('span', { cls: 'minus', text: '-' + f.removed })]));
    });
    if (!c.files.length) files.appendChild(el('div', { cls: 'empty', text: 'No file changes yet.' }));
    side.appendChild(files);
    var commits = el('div', { cls: 'list' }, [el('h4', { text: 'Commits' })]);
    c.commits.forEach(function (m) {
      var key = 'c:' + m.sha;
      commits.appendChild(el('button', { type: 'button', cls: S.diffKey === key ? 'on' : '', onclick: function () { showDiff(key, 'code/commit/' + m.sha); } }, [el('span', { cls: 'mono', text: m.sha.slice(0, 7) }), el('span', { style: 'flex:1', text: m.subject }), el('span', { cls: 'sp-meta', text: ago(m.date) })]));
    });
    if (!c.commits.length) commits.appendChild(el('div', { cls: 'empty', text: 'No commits yet.' }));
    side.appendChild(commits);
    var diff = el('div', { cls: 'diff', id: 'sp-diff' }, [S.diffText ? diffPre(S.diffText) : el('div', { cls: 'ph', text: 'Pick a file or commit to see what changed.' })]);
    return el('div', { cls: 'code-grid' }, [side, diff]);
  }
  function showDiff(key, path) {
    S.diffKey = key; S.diffText = null; render();
    api('sprints/' + encodeURIComponent(S.runId) + '/' + path).then(function (r) {
      if (S.diffKey !== key) return;
      S.diffText = r.diff + (r.truncated ? '\n... (diff truncated)' : '');
      render();
    }).catch(function (e) { toast(e.message); });
  }
  function diffPre(text) {
    var pre = el('pre');
    text.split('\n').forEach(function (line) {
      var c = line.charAt(0), cls = 'ln';
      if (line.indexOf('@@') === 0) cls += ' h';
      else if (line.indexOf('+++') === 0 || line.indexOf('---') === 0 || line.indexOf('diff ') === 0 || line.indexOf('index ') === 0) cls += ' m';
      else if (c === '+') cls += ' a';
      else if (c === '-') cls += ' d';
      pre.appendChild(el('span', { cls: cls, text: line || ' ' }));
    });
    return pre;
  }


  // ---- sprint designs ------------------------------------------------------
  var PLAN_RUN = [['always', 'Every cycle'], ['when-needed', 'Again only when there is new work'], ['first-cycle', 'First cycle only'], ['off', 'Off (one helper takes the whole ask)']];
  var BUILD_MODE = [['pipeline', 'All ready tasks at once (pipeline)'], ['classic', 'Round by round (classic)'], ['off', 'Off (no product code)']];
  var TIERS = [['', 'Whatever the plan says'], ['standard', 'At least standard'], ['premium', 'Premium only']];
  var SPLIT = [['always', 'Split across reviewers'], ['auto', 'Split only when the change is big'], ['never', 'One reviewer']];
  var KINDS = [['check', 'Check (a reviewer with your rule)'], ['work', 'Work (a helper does your instructions)'], ['command', 'Command (run a shell command)']];

  function copyDesign(d) { return JSON.parse(JSON.stringify(d)); }
  function sel(options, value, onchange) {
    var s = el('select', {});
    options.forEach(function (o) { s.appendChild(el('option', { value: o[0], text: o[1] })); });
    s.value = value === undefined || value === null ? options[0][0] : value;
    s.addEventListener('change', function () { onchange(s.value); });
    return s;
  }
  function field(label, input, cls) { return el('label', { cls: cls || null }, [label, input]); }
  function check(label, value, onchange) {
    var c = el('input', { type: 'checkbox' });
    c.checked = !!value;
    c.addEventListener('change', function () { onchange(c.checked); });
    return el('label', { cls: 'inline' }, [c, label]);
  }
  function text(value, placeholder, onchange, multi) {
    var t = el(multi ? 'textarea' : 'input', multi ? { placeholder: placeholder } : { type: 'text', placeholder: placeholder });
    t.value = value || '';
    t.addEventListener('input', function () { onchange(t.value); });
    return t;
  }
  function num(value, min, max, placeholder, onchange) {
    var n = el('input', { type: 'number', min: String(min), max: String(max), placeholder: placeholder });
    n.value = value === undefined || value === null ? '' : String(value);
    n.addEventListener('input', function () { onchange(n.value === '' ? undefined : Number(n.value)); });
    return n;
  }

  function renderDesigns() {
    root.textContent = '';
    root.appendChild(el('button', { cls: 'back', type: 'button', text: '<- All sprints', onclick: function () { go(null); } }));
    root.appendChild(el('div', { cls: 'sp-top' }, [
      el('div', {}, [el('h2', { text: 'Sprint designs' }), el('div', { style: 'color: var(--muted); font-size: 13px; margin-top: 4px', text: 'A design decides which steps a sprint runs and how. Pick one when you start a sprint, or build your own here.' })]),
      el('button', { cls: 'act primary', type: 'button', text: 'New design', onclick: function () {
        S.designId = null;
        S.draft = { id: '', name: 'My design', description: '', build: { mode: 'pipeline' } };
        history.replaceState(null, '', '#sprints/designs');
        render();
      } })
    ]));
    if (!S.designs) { root.appendChild(el('div', { cls: 'empty', text: 'Loading...' })); return; }
    var current = S.draft || (S.designs.filter(function (d) { return d.id === S.designId; })[0]) || S.designs[0];
    var list = el('div', { cls: 'dz-list' });
    S.designs.forEach(function (d) {
      list.appendChild(el('button', { type: 'button', cls: 'dz-item' + (!S.draft && current && d.id === current.id ? ' on' : ''), onclick: function () { goDesigns(d.id); } }, [
        el('div', { style: 'display:flex; justify-content: space-between; gap: 8px' }, [el('b', { text: d.name }), el('span', { cls: 'src', text: d.source === 'built-in' ? 'built in' : d.source === 'project' ? 'this project' : 'yours' })]),
        el('p', { text: d.description })
      ]));
    });
    root.appendChild(el('div', { cls: 'dz' }, [list, current ? (S.draft || current.source === 'mine' ? designEditor(S.draft || copyDesign(current)) : designReadOnly(current)) : el('div')]));
  }

  function designReadOnly(d) {
    return el('div', { cls: 'dz-ed' }, [
      el('h3', { text: d.name }),
      el('div', { style: 'color: var(--muted); font-size: 13.5px', text: d.description }),
      track(d.steps),
      el('div', { style: 'font-size: 13px; color: var(--muted)', text: d.source === 'built-in' ? 'Built-in designs cannot be changed. Copy one to make it your own.' : 'This design comes from the project folder (.lazyfleet/designs). Copy it to change it for yourself.' }),
      el('div', { cls: 'dz-actions' }, [
        el('button', { cls: 'act', type: 'button', text: 'Copy and edit', onclick: function () {
          var c = copyDesign(d); delete c.steps; c.id = ''; c.source = 'mine'; c.name = d.name + ' (copy)';
          S.draft = c; render();
        } }),
        el('button', { cls: 'act primary', type: 'button', text: 'Start a sprint with it', onclick: function () { S.formDesign = d.id; S.formOpen = true; go(null); } })
      ])
    ]);
  }

  function designEditor(d) {
    d.plan = d.plan || {}; d.build = d.build || {}; d.review = d.review || {}; d.test = d.test || {}; d.finish = d.finish || {}; d.blocks = d.blocks || [];
    delete d.steps;
    var preview = el('div', {});
    var msg = el('div', { cls: 'dz-msg' });
    var timer = null;
    function changed() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        api('designs/check', { method: 'POST', body: d }).then(function (r) {
          preview.textContent = ''; preview.appendChild(track(r.steps));
          msg.className = 'dz-msg ' + (r.ok ? 'ok' : 'bad');
          msg.textContent = r.ok ? 'This design can run.' : r.error;
        }).catch(function (e) { msg.className = 'dz-msg bad'; msg.textContent = e.message; });
      }, 250);
    }
    function set(obj, key) { return function (v) { if (v === '' || v === undefined) delete obj[key]; else obj[key] = v; changed(); }; }

    var blocksBox = el('div', { cls: 'dz-sec' });
    function drawBlocks() {
      blocksBox.textContent = '';
      blocksBox.appendChild(el('h4', { text: 'Custom steps' }));
      if (!d.blocks.length) blocksBox.appendChild(el('div', { style: 'grid-column: 1 / -1; font-size: 13px; color: var(--muted)', text: 'None yet. A check is a reviewer with your own rule; work is a helper doing your instructions on the sprint branch; a command runs something like a linter and turns a failure into a task.' }));
      d.blocks.forEach(function (b, i) {
        var box = el('div', { cls: 'dz-blk' });
        box.appendChild(field('Kind', sel(KINDS, b.kind, function (v) { b.kind = v; drawBlocks(); changed(); })));
        box.appendChild(field('Name', text(b.name, 'e.g. Docs match the code', set(b, 'name'))));
        box.appendChild(field('When', sel([['after-build', 'After every build'], ['finish', 'Once, at the end']], b.slot, set(b, 'slot'))));
        if (b.kind === 'command') {
          box.appendChild(field('Command', text(b.command, 'e.g. npm run lint', set(b, 'command')), 'wide'));
        } else {
          box.appendChild(field(b.kind === 'check' ? 'The rule to check' : 'What to do', text(b.instructions, b.kind === 'check' ? 'e.g. Every README example must run and print what it says.' : 'e.g. Write end-to-end tests for the checkout flow. Do not change product code.', set(b, 'instructions'), true), 'wide'));
        }
        if (b.kind === 'work') box.appendChild(field('Model', sel([['standard', 'Standard'], ['premium', 'Premium'], ['cheap', 'Cheap']], b.model, set(b, 'model'))));
        if (b.kind !== 'work') box.appendChild(field('When it fails', sel([['new-task', 'Turn it into tasks to fix'], ['ignore', 'Only report it']], b.onFail, set(b, 'onFail'))));
        box.appendChild(el('div', { cls: 'row' }, [
          i > 0 ? el('button', { cls: 'act', type: 'button', text: 'Up', onclick: function () { d.blocks.splice(i - 1, 0, d.blocks.splice(i, 1)[0]); drawBlocks(); changed(); } }) : null,
          el('button', { cls: 'act danger', type: 'button', text: 'Remove', onclick: function () { d.blocks.splice(i, 1); drawBlocks(); changed(); } })
        ]));
        blocksBox.appendChild(box);
      });
      blocksBox.appendChild(el('div', { style: 'grid-column: 1 / -1; display:flex; gap:8px; flex-wrap: wrap' }, KINDS.map(function (k) {
        return el('button', { cls: 'act', type: 'button', text: '+ ' + k[0][0].toUpperCase() + k[0].slice(1), onclick: function () {
          d.blocks.push(k[0] === 'command' ? { kind: 'command', name: 'Lint', command: 'npm run lint' } : { kind: k[0], name: k[0] === 'check' ? 'My check' : 'My work', instructions: '' });
          drawBlocks(); changed();
        } });
      })));
    }
    drawBlocks();

    var ed = el('div', { cls: 'dz-ed' }, [
      el('div', { cls: 'dz-sec', style: 'border-top: 0; padding-top: 0' }, [
        field('Name', text(d.name, 'Name', set(d, 'name'))),
        field('Cycles at most', num(d.cycles, 1, 10, 'engine default (5)', set(d, 'cycles'))),
        field('What it is for', text(d.description, 'One sentence people will see when they pick it', set(d, 'description')), 'wide')
      ]),
      el('div', {}, [preview, msg]),
      el('div', { cls: 'dz-sec' }, [
        el('h4', { text: 'Plan' }),
        field('Plan the work', sel(PLAN_RUN, d.plan.run, set(d.plan, 'run'))),
        check('A second helper reviews the plan', d.plan.review !== false, function (v) { d.plan.review = v; changed(); })
      ]),
      el('div', { cls: 'dz-sec' }, [
        el('h4', { text: 'Build' }),
        field('How tasks are built', sel(BUILD_MODE, d.build.mode || 'pipeline', set(d.build, 'mode'))),
        field('Model for builders', sel(TIERS, d.build.minModel || '', set(d.build, 'minModel'))),
        field('Check after each landing', text(d.check, 'optional, e.g. npm ci && npm test', set(d, 'check'))),
        field('Helpers (round by round only)', num(d.helpers, 2, 64, '3', set(d, 'helpers'))),
        check('Add an acceptance-test task per feature (pipeline)', d.build.acceptanceTasks !== false, function (v) { d.build.acceptanceTasks = v; changed(); })
      ]),
      blocksBox,
      el('div', { cls: 'dz-sec' }, [
        el('h4', { text: 'Review and test' }),
        field('Review', sel([['on', 'On'], ['off', 'Off']], d.review.run, set(d.review, 'run'))),
        field('Reviewers (pipeline)', sel(SPLIT, d.review.split, set(d.review, 'split'))),
        field('Big means at least this many files', num(d.review.splitMinFiles, 1, 10000, '20', set(d.review, 'splitMinFiles'))),
        check('Run the project deploy and integration tests when it has them', d.test.run !== 'off', function (v) { d.test.run = v ? 'auto' : 'off'; changed(); })
      ]),
      el('div', { cls: 'dz-sec' }, [
        el('h4', { text: 'At the end' }),
        check('Final review (otherwise pass means nothing left open)', d.finish.finalReview !== false, function (v) { d.finish.finalReview = v; changed(); }),
        check('Wrap up: docs and changelog', d.finish.harvest !== false, function (v) { d.finish.harvest = v; changed(); })
      ]),
      el('div', { cls: 'dz-actions' }, [
        d.id && d.source === 'mine' ? el('button', { cls: 'act danger', type: 'button', text: 'Delete', onclick: function () {
          if (!confirm('Delete the design "' + d.name + '"?')) return;
          api('designs/' + encodeURIComponent(d.id), { method: 'DELETE' }).then(function () { toast('Deleted'); S.draft = null; S.designs = null; goDesigns(null); }).catch(function (e) { toast(e.message); });
        } }) : null,
        S.draft ? el('button', { cls: 'act', type: 'button', text: 'Cancel', onclick: function () { S.draft = null; render(); } }) : null,
        el('button', { cls: 'act primary', type: 'button', text: 'Save design', onclick: function () {
          api('designs', { method: 'POST', body: d }).then(function (r) { toast('Saved'); S.draft = null; loadDesigns().then(function () { goDesigns(r.design.id); }); })
            .catch(function (e) { msg.className = 'dz-msg bad'; msg.textContent = e.message; });
        } })
      ])
    ]);
    changed();
    return ed;
  }

  window.addEventListener('lazy:tab', function (e) {
    document.body.classList.toggle('wide', e.detail === 'sprints');
    if (e.detail === 'sprints') { if (!parseHash()) { S.view = 'list'; S.runId = null; } refresh(true); }
  });
  if (parseHash()) setTimeout(function () { refresh(true); }, 0);
  schedule();
})();
`;
