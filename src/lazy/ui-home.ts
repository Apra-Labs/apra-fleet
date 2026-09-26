/**
 * Home, Issues and Schedules: the pages that make sprints the normal way to
 * get work done. String.raw so client-side regexes keep their backslashes;
 * never put a backtick or dollar-brace here.
 */

export const HOME_CSS = String.raw`
.hx { display: flex; flex-direction: column; gap: 18px; }
.hx-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.hx-top h2 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
.hx-sub { color: var(--muted); font-size: 14px; margin-top: 2px; }
.gh-chip { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 4px 12px 4px 4px; font-size: 13px; }
.gh-chip .av { width: 24px; height: 24px; border-radius: 50%; background: var(--ink); color: var(--bg); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 11px; overflow: hidden; }
.gh-chip .av img { width: 100%; height: 100%; }
.composer { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 0 color-mix(in srgb, var(--line) 60%, transparent); }
.composer textarea { width: 100%; min-height: 84px; resize: vertical; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 16px; outline: none; }
.composer .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.composer .row > label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); flex: 1 1 200px; min-width: 0; }
.composer input[type=text], .composer select, .hx select, .hx input[type=text], .hx input[type=number], .hx input[type=time], .hx textarea { background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font: inherit; min-width: 0; }
.composer .go { display: flex; gap: 8px; align-items: flex-end; margin-left: auto; }
.advice { display: flex; gap: 10px; align-items: flex-start; background: var(--chip); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; font-size: 13px; }
.advice b { color: var(--ink); }
.advice.low { background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border-color: color-mix(in srgb, var(--warn) 35%, var(--line)); }
.advice ul { margin: 2px 0 0; padding-left: 18px; color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tile small { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.tile b { font-size: 22px; letter-spacing: -0.02em; }
.tile span { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cols { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.panel h3 { margin: 0; font-size: 14px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.panel h3 a, .linkish { color: var(--accent); font-weight: 500; font-size: 13px; cursor: pointer; background: none; border: 0; padding: 0; font-family: inherit; }
.item { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); cursor: pointer; min-width: 0; }
.item:first-of-type { border-top: 0; }
.item:hover .t { text-decoration: underline; }
.item .t { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .m { color: var(--muted); font-size: 12.5px; display: flex; gap: 8px; flex-wrap: wrap; }
.item .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.step { border: 1px dashed var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.step .n { width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; }
.step.done { border-style: solid; }
.step.done b { color: var(--muted); }
.step.done .n { background: var(--ok); font-size: 0; position: relative; }
.step.done .n::after { content: ''; position: absolute; left: 8px; top: 5px; width: 6px; height: 11px; border: solid var(--accent-ink); border-width: 0 2.5px 2.5px 0; transform: rotate(45deg); }
@media (max-width: 640px) { nav { flex-wrap: wrap; } nav .nav-gap { display: none; } nav button { padding: 8px 10px; } }
.step p { margin: 0; color: var(--muted); font-size: 13px; }
.evidence { margin: 4px 0 0; padding-left: 18px; color: var(--muted); font-size: 12.5px; }
.gh-card { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.gh-opt { border: 1px solid var(--line); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: var(--panel); }
.gh-opt p { margin: 0; color: var(--muted); font-size: 13px; }
.code-big { font-family: var(--mono); font-size: 28px; letter-spacing: .12em; font-weight: 700; background: var(--chip); border-radius: 10px; padding: 8px 14px; text-align: center; }
.iss { display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); gap: 16px; align-items: start; }
.repo-list { display: flex; flex-direction: column; gap: 6px; max-height: 70vh; overflow: auto; }
.repo { text-align: left; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; cursor: pointer; color: var(--ink); font: inherit; display: flex; flex-direction: column; gap: 2px; }
.repo.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.repo small { color: var(--muted); font-size: 12px; }
.issue { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.issue .head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.issue .ttl { font-weight: 600; font-size: 15px; }
.issue .num { color: var(--muted); font-weight: 500; }
.issue .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 12.5px; }
.issue .body { color: var(--muted); font-size: 13px; white-space: pre-wrap; max-height: 3.2em; overflow: hidden; }
.lbl { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; background: var(--chip); color: var(--ink); border: 1px solid var(--line); }
.lbl.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); cursor: pointer; }
.lbl.pick { cursor: pointer; }
.warn-chip { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
.ok-chip { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); }
.drawer-inline { border-top: 1px dashed var(--line); padding-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.drawer-inline label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); flex: 1 1 220px; }
.sched { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.sched.off { opacity: .65; }
.sched .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.sched .name { font-weight: 700; font-size: 15px; }
.sched .sentence { font-size: 14px; }
.sched .next { color: var(--muted); font-size: 13px; }
.switch { position: relative; width: 38px; height: 22px; flex: none; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch span { position: absolute; inset: 0; background: var(--line); border-radius: 999px; transition: .2s; cursor: pointer; }
.switch span::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--panel); border-radius: 50%; transition: .2s; }
.switch input:checked + span { background: var(--ok); }
.switch input:checked + span::before { transform: translateX(16px); }
.switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
.log { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.log li { display: flex; gap: 8px; color: var(--muted); }
.log li .w { flex: none; width: 70px; }
.log li.started { color: var(--ink); }
.log li.error { color: var(--bad); }
.form2 { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.form2 fieldset { border: 0; border-top: 1px solid var(--line); margin: 0; padding: 12px 0 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px 12px; }
.form2 fieldset:first-of-type { border-top: 0; padding-top: 0; }
.form2 legend { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 0 0 6px; grid-column: 1 / -1; }
.form2 label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.form2 label.inline { flex-direction: row; align-items: center; gap: 8px; color: var(--ink); }
.form2 .wide { grid-column: 1 / -1; }
.form2 textarea { min-height: 70px; resize: vertical; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.seg button { background: var(--bg); border: 0; padding: 6px 12px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.days { display: flex; gap: 4px; flex-wrap: nowrap; overflow-x: auto; }
.days button { width: 38px; padding: 5px 0; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.days button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.preview-line { font-size: 14px; background: var(--chip); border-radius: 10px; padding: 10px 12px; }
.preview-line.bad { color: var(--bad); }
@media (max-width: 860px) { .cols, .iss { grid-template-columns: 1fr; } }
.wel-back { position: fixed; inset: 0; background: color-mix(in srgb, var(--ink) 45%, transparent); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 50; }
.wel { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; width: min(620px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 26px 26px 20px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
.wel h2 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
.wel h2 span { color: var(--accent); }
.wel p { margin: 0; color: var(--muted); }
.wel .dots { display: flex; gap: 6px; }
.wel .dots i { width: 22px; height: 4px; border-radius: 2px; background: var(--line); }
.wel .dots i.on { background: var(--accent); }
.wel .feat { display: flex; gap: 12px; align-items: flex-start; }
.wel .feat .ic { flex: none; width: 34px; height: 34px; border-radius: 10px; background: var(--chip); display: flex; align-items: center; justify-content: center; font-weight: 800; color: var(--accent); font-size: 14px; }
.wel .feat b { display: block; }
.wel .feat span { color: var(--muted); font-size: 13.5px; }
.wel .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
.wel .opt { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.wel .opt.best { border-color: var(--accent); }
.wel .row2 { display: flex; gap: 8px; }
.wel .row2 input { flex: 1; }
.wel .how { display: grid; grid-template-columns: 28px 1fr; gap: 10px 12px; align-items: start; }
.wel .how .n { width: 26px; height: 26px; border-radius: 50%; background: var(--chip); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; }
.wel .how code { background: var(--chip); padding: 2px 6px; border-radius: 6px; }
`;

export const HOME_HTML = String.raw`
  <section id="tab-home" hidden><div id="home-root" class="hx"></div></section>
  <section id="tab-issues" hidden><div id="issues-root" class="hx"></div></section>
  <section id="tab-schedules" hidden><div id="sched-root" class="hx"></div></section>
`;

export const HOME_JS = String.raw`
(function () {
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
  function toast(m) { var t = document.getElementById('toast'); t.textContent = m; t.classList.add('on'); setTimeout(function () { t.classList.remove('on'); }, 2400); }
  function money(n) { return '$' + (n || 0).toFixed(2); }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function until(iso) {
    if (!iso) return 'off';
    var s = (Date.parse(iso) - Date.now()) / 1000;
    if (s <= 30) return 'now';
    if (s < 3600) return 'in ' + Math.ceil(s / 60) + 'm';
    if (s < 86400) return 'in ' + Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return 'in ' + Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }
  function clock(iso) { var d = new Date(iso); return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }); }
  function pill(status, verdict) {
    var labels = { running: 'Running', starting: 'Starting', success: 'Done', failed: 'Failed', stopped: 'Stopped', aborted: 'Stopped', paused: 'Paused' };
    var live = status === 'running' || status === 'starting';
    var out = [el('span', { cls: 'pill ' + status }, [live ? el('span', { cls: 'pulse' }) : null, labels[status] || status])];
    if (verdict) out.push(verdictPill(verdict));
    return out;
  }
  function verdictPill(v) {
    var text = { PASS: 'Passed review', FAIL: 'Review found problems', DONE: 'All tasks done', OPEN: 'Open tasks left' }[v] || 'Review: ' + v;
    var tip = { PASS: 'The final reviewer passed the work', FAIL: 'The final reviewer found problems; see the board', DONE: 'This design has no final review; every task was closed', OPEN: 'This design has no final review; some tasks are still open (for a test-only design, these are the problems it found)' }[v];
    return el('span', { cls: 'pill ' + (v === 'PASS' || v === 'DONE' ? 'verdict-pass' : 'verdict-fail'), title: tip || '' }, [text]);
  }
  function openSprint(runId) {
    history.replaceState(null, '', '#sprints/' + runId);
    if (window.lazyShowTab) window.lazyShowTab('sprints');
  }
  function goTab(name, sub) {
    history.replaceState(null, '', '#' + name + (sub ? '/' + sub : ''));
    if (window.lazyShowTab) window.lazyShowTab(name);
  }
  function greeting() { var h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function initials(s) { return (s || '?').slice(0, 2).toUpperCase(); }
  function ghChip(g) {
    if (!g || !g.signedIn) return el('button', { cls: 'act', type: 'button', text: 'Connect GitHub', onclick: function () { goTab('issues'); } });
    return el('span', { cls: 'gh-chip', title: 'Signed in to GitHub' + (g.source === 'gh' ? ' through the GitHub CLI' : '') }, [
      el('span', { cls: 'av' }, [g.avatarUrl ? el('img', { src: g.avatarUrl, alt: '' }) : initials(g.login)]), g.login
    ]);
  }
  var FOLDER_KEY = 'lazy.lastFolder';
  function lastFolder() { try { return localStorage.getItem(FOLDER_KEY) || ''; } catch (e) { return ''; } }
  function rememberFolder(f) { try { localStorage.setItem(FOLDER_KEY, f); } catch (e) {} }
  var designsCache = null;
  function designs() {
    if (designsCache) return Promise.resolve(designsCache);
    return api('designs').then(function (r) { designsCache = r.designs; return designsCache; });
  }
  function designSelect(value, withAuto) {
    var s = el('select', {});
    if (withAuto) s.appendChild(el('option', { value: 'auto', text: 'Let lazyfleet pick (recommended)' }));
    designs().then(function (list) {
      list.forEach(function (d) { s.appendChild(el('option', { value: d.id, text: d.name + (d.auto ? ' (learned)' : '') })); });
      s.value = value || (withAuto ? 'auto' : list[0].id);
    });
    return s;
  }

  // =========================================================================
  // Home
  // =========================================================================
  var H = { data: null, adviceTimer: null, advice: null, draft: '' };
  var homeRoot = document.getElementById('home-root');

  function loadHome() {
    return api('home').then(function (r) { H.data = r; renderHome(); }).catch(function (e) { homeRoot.textContent = 'Could not load: ' + e.message; });
  }

  function composer() {
    var ask = el('textarea', { placeholder: 'What should get done? For example: "Add a CSV export to the reports page, with tests" or "Fix the crash when the cart is empty".', 'aria-label': 'What should get done' });
    ask.value = H.draft;
    var folders = (H.data.folders || []);
    var list = el('datalist', { id: 'hx-folders' }, folders.map(function (f) { return el('option', { value: f }); }));
    var folder = el('input', { type: 'text', list: 'hx-folders', placeholder: '/home/you/code/project', value: lastFolder() || folders[0] || '', 'aria-label': 'Project folder' });
    var folderName = el('b', { style: 'color: var(--ink)' });
    function showFolder() { var n = folder.value.trim().split('/').filter(Boolean).pop() || ''; folderName.textContent = n ? ' - ' + n : ''; folder.title = folder.value; }
    folder.addEventListener('input', showFolder); showFolder();
    var design = designSelect('auto', true);
    var adviceBox = el('div', {});
    var start = el('button', { cls: 'act primary', type: 'button', text: 'Start sprint' });
    var later = el('button', { cls: 'act', type: 'button', text: 'Schedule it', title: 'Run this on a schedule instead' });
    function showAdvice() {
      adviceBox.textContent = '';
      var autoOpt = design.querySelector('option[value="auto"]');
      if (autoOpt) autoOpt.textContent = H.advice && ask.value.trim() ? 'Let lazyfleet pick (' + H.advice.designName + ')' : 'Let lazyfleet pick (recommended)';
      if (!H.advice || !ask.value.trim()) return;
      var a = H.advice;
      adviceBox.appendChild(el('div', { cls: 'advice' + (a.profile.confidence === 'low' ? ' low' : '') }, [
        el('div', {}, [
          el('div', {}, ['Suggested design: ', el('b', { text: a.designName }), design.value !== 'auto' ? el('span', { style: 'color: var(--muted)', text: ' (you picked another)' }) : null]),
          el('ul', {}, a.reasons.map(function (r) { return el('li', { text: r }); }))
        ])
      ]));
    }
    ask.addEventListener('input', function () {
      H.draft = ask.value;
      clearTimeout(H.adviceTimer);
      H.adviceTimer = setTimeout(function () {
        if (ask.value.trim().length < 8) { H.advice = null; showAdvice(); return; }
        api('advisor/recommend', { method: 'POST', body: { ask: ask.value, repo: folder.value.trim() || undefined } }).then(function (r) { H.advice = r; showAdvice(); });
      }, 350);
    });
    design.addEventListener('change', showAdvice);
    start.addEventListener('click', function () {
      if (ask.value.trim().length < 8) { toast('Say what should get done in a sentence'); ask.focus(); return; }
      if (!folder.value.trim()) { toast('Pick the project folder'); folder.focus(); return; }
      var d = design.value === 'auto' ? (H.advice ? H.advice.designId : undefined) : design.value;
      start.disabled = true; start.textContent = 'Starting...';
      rememberFolder(folder.value.trim());
      api('sprints', { method: 'POST', body: { repo: folder.value.trim(), ask: ask.value, design: d } }).then(function (r) {
        H.draft = ''; H.advice = null;
        var c = homeRoot.querySelector('.composer'); if (c) c.remove();
        toast('Sprint started'); openSprint(r.runId);
      }).catch(function (e) { toast(e.message); start.disabled = false; start.textContent = 'Start sprint'; });
    });
    later.addEventListener('click', function () {
      S2.prefill = { name: ask.value.split('\n')[0].slice(0, 60) || 'My schedule', repo: folder.value.trim(), source: { type: 'ask', ask: ask.value }, design: design.value };
      goTab('schedules', 'new');
    });
    return el('div', { cls: 'composer' }, [ask, adviceBox, el('div', { cls: 'row' }, [
      el('label', {}, [el('span', {}, ['Project folder', folderName]), folder, list]),
      el('label', {}, ['Sprint design', design]),
      el('div', { cls: 'go' }, [later, start])
    ])]);
  }

  function renderHome() {
    var d = H.data;
    var keep = homeRoot.querySelector('.composer');
    homeRoot.textContent = '';
    homeRoot.appendChild(el('div', { cls: 'hx-top' }, [
      el('div', {}, [el('h2', { text: greeting() + (d.github.login ? ', ' + d.github.login : '') }), el('div', { cls: 'hx-sub', text: d.running.length ? d.running.length + ' sprint' + (d.running.length === 1 ? ' is' : 's are') + ' running. You can keep working; they use private copies of your projects.' : 'Say what should get done, and helpers plan it, build it and review it.' })]),
      ghChip(d.github)
    ]));
    homeRoot.appendChild(keep || composer());

    var next = d.next[0];
    homeRoot.appendChild(el('div', { cls: 'tiles' }, [
      el('div', { cls: 'tile' }, [el('small', { text: 'Running now' }), el('b', { text: String(d.running.length) }), el('span', { text: d.running.length ? d.running.map(function (x) { return x.title; }).join(', ') : 'Nothing running' })]),
      el('div', { cls: 'tile' }, [el('small', { text: 'Next scheduled' }), el('b', { text: next ? until(next.nextAt) : '-' }), el('span', { text: next ? next.name + ' - ' + next.whenText : 'No schedules yet' })]),
      el('div', { cls: 'tile' }, [el('small', { text: 'This week' }), el('b', { text: d.week.sprints + ' sprint' + (d.week.sprints === 1 ? '' : 's') }), el('span', { text: d.week.sprints ? d.week.passed + ' passed' : 'None finished yet' })]),
      el('div', { cls: 'tile', title: 'An estimate from token prices. With a Claude subscription this is plan usage, not money.' }, [el('small', { text: 'Usage this week' }), el('b', { text: money(d.week.cost) }), el('span', { text: 'estimated' })])
    ]));

    // First-run guide, until each step is done.
    var hasSprint = d.running.length || d.recent.length;
    if (!hasSprint || !d.github.signedIn || !d.schedulesTotal) {
      homeRoot.appendChild(el('div', { cls: 'steps' }, [
        el('div', { cls: 'step' + (hasSprint ? ' done' : '') }, [el('span', { cls: 'n', text: hasSprint ? 'done' : '1' }), el('b', { text: 'Start a sprint' }), el('p', { text: 'Describe a job above and pick the project folder. lazyfleet suggests a design and you can watch it on the board.' })]),
        el('div', { cls: 'step' + (d.github.signedIn ? ' done' : '') }, [el('span', { cls: 'n', text: d.github.signedIn ? 'done' : '2' }), el('b', { text: 'Connect GitHub' }), el('p', { text: 'See your issues and turn any of them into a sprint with one click.' }), d.github.signedIn ? null : el('button', { cls: 'linkish', type: 'button', text: 'Connect ->', onclick: function () { goTab('issues'); } })]),
        el('div', { cls: 'step' + (d.schedulesTotal ? ' done' : '') }, [el('span', { cls: 'n', text: d.schedulesTotal ? 'done' : '3' }), el('b', { text: 'Let it run on its own' }), el('p', { text: 'A schedule picks up labeled issues at night, within limits you set, and reports back on each issue.' }), d.schedulesTotal ? null : el('button', { cls: 'linkish', type: 'button', text: 'New schedule ->', onclick: function () { goTab('schedules', 'new'); } })])
      ]));
    }

    var left = el('div', { cls: 'panel' }, [el('h3', {}, ['Sprints', el('button', { cls: 'linkish', type: 'button', text: 'All sprints ->', onclick: function () { goTab('sprints'); } })])]);
    var rows = d.running.concat(d.recent);
    if (!rows.length) left.appendChild(el('div', { cls: 'note', style: 'margin:0', text: 'No sprints yet.' }));
    rows.forEach(function (x) {
      left.appendChild(el('div', { cls: 'item', onclick: function () { openSprint(x.runId); } }, [
        el('div', { cls: 'grow' }, [
          el('span', { cls: 't', text: x.title }),
          el('span', { cls: 'm' }, [x.design ? el('span', { text: x.design }) : null, x.issue ? el('span', { text: x.issue.repo + '#' + x.issue.number }) : null, x.scheduleId ? el('span', { text: 'scheduled' }) : null, el('span', { text: x.live ? (x.progress.total ? x.progress.done + '/' + x.progress.total + ' done' : 'planning') : ago(x.endedAt || x.startedAt) }), x.cost ? el('span', { text: money(x.cost) }) : null])
        ])
      ].concat(pill(x.status, x.verdict))));
    });

    var right = el('div', { style: 'display:flex; flex-direction:column; gap:16px; min-width:0' });
    var up = el('div', { cls: 'panel' }, [el('h3', {}, ['Coming up', el('button', { cls: 'linkish', type: 'button', text: 'Schedules ->', onclick: function () { goTab('schedules'); } })])]);
    if (!d.next.length) up.appendChild(el('div', { cls: 'note', style: 'margin:0', text: 'Nothing scheduled.' }));
    d.next.forEach(function (s) {
      up.appendChild(el('div', { cls: 'item', onclick: function () { goTab('schedules'); } }, [el('div', { cls: 'grow' }, [el('span', { cls: 't', text: s.name }), el('span', { cls: 'm' }, [el('span', { text: s.whenText }), el('span', { text: clock(s.nextAt) })])]), el('span', { cls: 'chip', text: until(s.nextAt) })]));
    });
    right.appendChild(up);
    var learned = el('div', { cls: 'panel' }, [el('h3', {}, ['Learned designs', el('button', { cls: 'linkish', type: 'button', text: 'Designs ->', onclick: function () { goTab('sprints', 'designs'); } })])]);
    if (!d.learned.designs.length) {
      learned.appendChild(el('div', { cls: 'note', style: 'margin:0', text: d.learned.finished ? 'lazyfleet writes a tuned design once it has seen 3 finished sprints of one kind. ' + d.learned.finished + ' finished so far.' : 'As sprints finish, lazyfleet learns which design suits which kind of work and writes tuned designs here.' }));
    }
    d.learned.designs.forEach(function (x) {
      learned.appendChild(el('details', {}, [el('summary', { style: 'cursor:pointer' }, [el('b', { text: x.name }), el('span', { style: 'color:var(--muted); font-size:12.5px', text: ' - from ' + x.runs + ' sprints, ' + ago(x.updatedAt) })]), el('ul', { cls: 'evidence' }, x.evidence.map(function (e) { return el('li', { text: e }); }))]));
    });
    right.appendChild(learned);
    homeRoot.appendChild(el('div', { cls: 'cols' }, [left, right]));
  }

  // =========================================================================
  // Issues
  // =========================================================================
  var I = { gh: null, repos: null, repo: null, issues: null, folder: null, labels: [], open: null, filter: '', device: null };
  var issuesRoot = document.getElementById('issues-root');
  function loadIssues() {
    return api('github').then(function (g) {
      I.gh = g;
      if (!g.signedIn) return renderIssues();
      var p = I.repos ? Promise.resolve() : api('github/repos').then(function (r) { I.repos = r.repos; if (!I.repo && r.repos.length) I.repo = (r.repos.filter(function (x) { return x.openIssues; })[0] || r.repos[0]).fullName; });
      return p.then(function () { return I.repo ? loadRepoIssues() : null; }).then(renderIssues);
    }).catch(function (e) { issuesRoot.textContent = ''; issuesRoot.appendChild(el('div', { cls: 'panel' }, [el('b', { text: 'Could not reach GitHub' }), el('div', { cls: 'note', style: 'margin:0', text: e.message })])); });
  }
  function loadRepoIssues() {
    return api('github/issues?repo=' + encodeURIComponent(I.repo) + (I.labels.length ? '&labels=' + encodeURIComponent(I.labels.join(',')) : '')).then(function (r) { I.issues = r.issues; I.folder = r.folder; });
  }

  function signInCard() {
    var tokenIn = el('input', { type: 'password', placeholder: 'ghp_... or github_pat_...', 'aria-label': 'GitHub token', style: 'width:100%' });
    var clientIn = el('input', { type: 'text', placeholder: 'OAuth app client id (Iv1....)', value: '', style: 'width:100%' });
    var device = el('div', {});
    function startDevice() {
      api('github/device/start', { method: 'POST', body: {} }).then(function (d) {
        I.device = d;
        device.textContent = '';
        device.appendChild(el('div', { style: 'display:flex; flex-direction:column; gap:8px' }, [
          el('p', { text: 'Open GitHub and enter this code:' }), el('div', { cls: 'code-big', text: d.userCode }),
          el('a', { href: d.verificationUri, target: '_blank', rel: 'noopener', cls: 'linkish', text: d.verificationUri }),
          el('p', { text: 'Waiting for you to approve...' })
        ]));
        var wait = Math.max(1, d.interval) * 1000;
        (function poll() {
          setTimeout(function () {
            api('github/device/poll', { method: 'POST', body: { deviceCode: d.deviceCode } }).then(function (r) {
              if (r.ok) { toast('Signed in as ' + r.login); I.repos = null; loadIssues(); }
              else { if (r.slowDown) wait += 5000; poll(); }
            }).catch(function (e) { device.textContent = ''; device.appendChild(el('p', { cls: 'error', text: e.message })); });
          }, wait);
        })();
      }).catch(function (e) { toast(e.message); });
    }
    var browserOpt = el('div', { cls: 'gh-opt' }, [el('b', { text: 'Sign in with GitHub' }), el('p', { text: I.gh && I.gh.clientIdSet ? 'Shows a code, you enter it on GitHub, and you are signed in.' : 'Browser sign-in needs a GitHub OAuth app (its client id, once). Most people use one of the other two ways.' })]);
    if (I.gh && I.gh.clientIdSet) browserOpt.appendChild(el('button', { cls: 'act primary', type: 'button', text: 'Sign in with GitHub', onclick: startDevice }));
    else browserOpt.appendChild(el('div', { style: 'display:flex; gap:6px' }, [clientIn, el('button', { cls: 'act', type: 'button', text: 'Save', onclick: function () {
      api('github/settings', { method: 'POST', body: { clientId: clientIn.value.trim() } }).then(function (g) { I.gh = g; renderIssues(); toast('Saved'); }).catch(function (e) { toast(e.message); });
    } })]));
    browserOpt.appendChild(device);
    return el('div', { cls: 'hx' }, [
      el('div', { cls: 'hx-top' }, [el('div', {}, [el('h2', { text: 'Connect GitHub' }), el('div', { cls: 'hx-sub', text: 'See your issues here and turn any of them into a sprint. The sign-in is stored encrypted on this machine and is never shown to Claude.' })])]),
      el('div', { cls: 'gh-card' }, [
        browserOpt,
        el('div', { cls: 'gh-opt' }, [el('b', { text: 'Use the GitHub CLI login' }), el('p', { text: 'If you already ran gh auth login on this machine, lazyfleet can use that. Nothing is copied.' }), el('button', { cls: 'act', type: 'button', text: 'Use gh login', onclick: function () {
          api('github/use-cli', { method: 'POST', body: {} }).then(function (r) { toast('Signed in as ' + r.login); I.repos = null; loadIssues(); }).catch(function (e) { toast(e.message); });
        } })]),
        el('div', { cls: 'gh-opt' }, [el('b', { text: 'Paste a token' }), el('p', { text: 'A fine-grained token with Issues read and write on the repos you want is enough.' }), tokenIn, el('button', { cls: 'act', type: 'button', text: 'Sign in', onclick: function () {
          api('github/token', { method: 'POST', body: { token: tokenIn.value.trim() } }).then(function (r) { tokenIn.value = ''; toast('Signed in as ' + r.login); I.repos = null; loadIssues(); }).catch(function (e) { toast(e.message); });
        } })])
      ])
    ]);
  }

  function issueCard(i) {
    var card = el('div', { cls: 'issue' });
    var labels = i.labels.map(function (l) { return el('span', { cls: 'lbl pick', title: 'Show only issues labeled ' + l, text: l, onclick: function (e) { e.stopPropagation(); if (I.labels.indexOf(l) === -1) I.labels.push(l); loadRepoIssues().then(renderIssues); } }); });
    card.appendChild(el('div', { cls: 'head' }, [
      el('div', { cls: 'ttl' }, [el('span', { cls: 'num', text: '#' + i.number + ' ' }), i.title]),
      el('div', { cls: 'meta' }, labels)
    ]));
    card.appendChild(el('div', { cls: 'meta' }, [
      el('span', { text: 'by ' + i.author + ' - ' + ago(i.createdAt) }),
      i.trusted ? null : el('span', { cls: 'warn-chip', title: 'Opened by someone outside the repo. Read it before you sprint it: its text goes to the helpers as the job description.', text: 'outside contributor' }),
      el('span', { cls: 'chip', title: i.suggested.why || 'The design lazyfleet would pick for this issue', text: 'suggests ' + i.suggested.designName }),
      i.sprint ? el('button', { cls: 'linkish', type: 'button', text: 'View sprint (' + (i.sprint.verdict || i.sprint.status) + ')', onclick: function () { openSprint(i.sprint.runId); } }) : null,
      el('a', { href: i.url, target: '_blank', rel: 'noopener', cls: 'linkish', text: 'On GitHub' })
    ]));
    if (i.body) card.appendChild(el('div', { cls: 'body', text: i.body }));
    var act = el('div', { style: 'display:flex; gap:8px; justify-content:flex-end' });
    if (I.open === i.number) {
      var folder = el('input', { type: 'text', placeholder: '/home/you/code/' + I.repo.split('/')[1], value: I.folder || '' });
      var design = designSelect(i.suggested.designId, false);
      var go = el('button', { cls: 'act primary', type: 'button', text: 'Start sprint', onclick: function () {
        if (!folder.value.trim()) { toast('Pick the folder where ' + I.repo + ' is checked out'); folder.focus(); return; }
        go.disabled = true; go.textContent = 'Starting...';
        api('github/sprint', { method: 'POST', body: { repo: I.repo, number: i.number, folder: folder.value.trim(), design: design.value } }).then(function (r) { toast('Sprint started'); I.folder = folder.value.trim(); I.open = null; openSprint(r.runId); })
          .catch(function (e) { toast(e.message); go.disabled = false; go.textContent = 'Start sprint'; });
      } });
      card.appendChild(el('div', { cls: 'drawer-inline' }, [
        el('label', {}, ['Local folder for ' + I.repo, folder]),
        el('label', {}, ['Sprint design', design]),
        el('button', { cls: 'act', type: 'button', text: 'Cancel', onclick: function () { I.open = null; renderIssues(); } }), go
      ]));
    } else {
      act.appendChild(el('button', { cls: 'act', type: 'button', text: 'Schedule issues like this', onclick: function () {
        S2.prefill = { name: I.repo.split('/')[1] + ' issues', repo: I.folder || '', source: { type: 'issues', repo: I.repo, labels: I.labels.length ? I.labels : i.labels.slice(0, 1), trustedOnly: true }, design: 'auto', comment: true };
        goTab('schedules', 'new');
      } }));
      var running = i.sprint && (i.sprint.status === 'running' || i.sprint.status === 'starting');
      if (running) {
        act.appendChild(el('button', { cls: 'act', type: 'button', text: 'Sprint again', onclick: function () { if (confirm('A sprint for #' + i.number + ' is still running. Start another one anyway?')) { I.open = i.number; renderIssues(); } } }));
        act.appendChild(el('button', { cls: 'act primary', type: 'button', text: 'View sprint', onclick: function () { openSprint(i.sprint.runId); } }));
      } else {
        act.appendChild(el('button', { cls: 'act primary', type: 'button', text: i.sprint ? 'Sprint again' : 'Sprint it', onclick: function () {
          if (!i.trusted && !confirm('#' + i.number + ' was opened by ' + i.author + ', who is not an owner, member or collaborator of ' + I.repo + '. Its text becomes the job description for the helpers. Read it first. Sprint it anyway?')) return;
          I.open = i.number; renderIssues();
        } }));
      }
      card.appendChild(act);
    }
    return card;
  }

  function renderIssues() {
    issuesRoot.textContent = '';
    if (!I.gh || !I.gh.signedIn) { issuesRoot.appendChild(signInCard()); return; }
    issuesRoot.appendChild(el('div', { cls: 'hx-top' }, [
      el('div', {}, [el('h2', { text: 'Issues' }), el('div', { cls: 'hx-sub', text: 'Open issues from your GitHub repos. Sprint one now, or let a schedule pick them up.' })]),
      el('div', { style: 'display:flex; gap:8px; align-items:center' }, [ghChip(I.gh), el('button', { cls: 'act', type: 'button', text: 'Sign out', onclick: function () {
        api('schedules').then(function (r) {
          var n = r.schedules.filter(function (x) { return x.enabled && x.source.type === 'issues'; }).length;
          if (!confirm('Sign out of GitHub?' + (n ? '\n\n' + n + ' schedule' + (n === 1 ? ' picks' : 's pick') + ' up GitHub issues and will skip until you sign in again. Results of finished sprints are posted once you are back.' : ''))) return;
          return api('github/logout', { method: 'POST', body: {} }).then(function () { I.repos = null; I.repo = null; I.issues = null; loadIssues(); });
        });
      } })])
    ]));
    var search = el('input', { type: 'text', placeholder: 'Find a repo', value: I.filter, 'aria-label': 'Find a repo' });
    var list = el('div', { cls: 'repo-list' });
    function drawRepos() {
      list.textContent = '';
      (I.repos || []).filter(function (r) { return !I.filter || r.fullName.toLowerCase().indexOf(I.filter.toLowerCase()) !== -1; }).forEach(function (r) {
        list.appendChild(el('button', { type: 'button', cls: 'repo' + (r.fullName === I.repo ? ' on' : ''), onclick: function () { I.repo = r.fullName; I.labels = []; I.open = null; loadRepoIssues().then(renderIssues); } }, [
          el('b', { text: r.fullName }), el('small', { title: 'GitHub counts open pull requests too', text: r.openIssues + ' open items' + (r.private ? ' - private' : '') + (r.folder ? ' - linked to a folder' : '') })
        ]));
      });
      if (!list.childNodes.length) list.appendChild(el('div', { cls: 'note', text: 'No repos match.' }));
    }
    search.addEventListener('input', function () { I.filter = search.value; drawRepos(); });
    drawRepos();
    var main = el('div', { style: 'display:flex; flex-direction:column; gap:10px; min-width:0' });
    if (I.repo) {
      var head = el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap' }, [el('b', { text: I.repo })]);
      I.labels.forEach(function (l) { head.appendChild(el('span', { cls: 'lbl on', title: 'Remove this filter', text: l + '  x', onclick: function () { I.labels = I.labels.filter(function (x) { return x !== l; }); loadRepoIssues().then(renderIssues); } })); });
      if (!I.labels.length) head.appendChild(el('span', { style: 'color:var(--muted); font-size:12.5px', text: 'Click a label to filter' }));
      main.appendChild(head);
      if (!I.issues || !I.issues.length) main.appendChild(el('div', { cls: 'panel' }, [el('div', { cls: 'note', style: 'margin:0', text: I.labels.length ? 'No open issues with these labels.' : 'No open issues in this repo.' })]));
      (I.issues || []).forEach(function (i) { main.appendChild(issueCard(i)); });
    }
    issuesRoot.appendChild(el('div', { cls: 'iss' }, [el('div', { style: 'display:flex; flex-direction:column; gap:8px' }, [search, list]), main]));
  }

  // =========================================================================
  // Schedules
  // =========================================================================
  var S2 = { list: null, editing: null, prefill: null, previewTimer: null, openLogs: {} };
  var schedRoot = document.getElementById('sched-root');
  var DAYNAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function loadSchedules() {
    return api('schedules').then(function (r) { S2.list = r.schedules; renderSchedules(); }).catch(function (e) { schedRoot.textContent = 'Could not load: ' + e.message; });
  }
  function sentence(s) {
    var what = s.source.type === 'issues' ? 'takes the oldest open issue labeled ' + s.source.labels.join(', ') + ' from ' + s.source.repo + (s.source.trustedOnly ? ' (repo members only)' : '') : 'runs "' + s.source.ask.split('\n')[0].slice(0, 70) + '"';
    var limits = 'up to ' + s.limits.perDay + ' sprint' + (s.limits.perDay === 1 ? '' : 's') + (s.limits.usagePerDay ? ' and ' + money(s.limits.usagePerDay) : '') + ' a day';
    return s.whenText + ', ' + what + ', with ' + (s.design === 'auto' ? 'the suggested design' : 'the ' + s.design + ' design') + ', ' + limits + (s.requireClean ? ', only when the folder has no uncommitted changes' : '') + '.';
  }
  function schedCard(s) {
    var sw = el('input', { type: 'checkbox', 'aria-label': 'Schedule on' });
    sw.checked = s.enabled;
    sw.addEventListener('change', function () { api('schedules/' + s.id + '/enable', { method: 'POST', body: { enabled: sw.checked } }).then(loadSchedules).catch(function (e) { toast(e.message); }); });
    var logList = el('ul', { cls: 'log' }, s.log.map(function (e) {
      var links = [];
      if (e.runId && e.action === 'started') links.push(el('button', { cls: 'linkish', type: 'button', text: 'open the board', onclick: function () { openSprint(e.runId); } }));
      if (e.issue) links.push(el('a', { cls: 'linkish', href: e.issue.url, target: '_blank', rel: 'noopener', text: e.action === 'commented' ? 'see the comment' : 'see the issue' }));
      var tail = [];
      links.forEach(function (l, i) { tail.push(i ? ' - ' : '  '); tail.push(l); });
      return el('li', { cls: e.action }, [el('span', { cls: 'w', text: ago(e.at) }), el('span', {}, [e.text].concat(tail))]);
    }));
    return el('div', { cls: 'sched' + (s.enabled ? '' : ' off') }, [
      el('div', { cls: 'head' }, [
        el('div', { style: 'display:flex; gap:10px; align-items:center' }, [el('label', { cls: 'switch', title: s.enabled ? 'On' : 'Off' }, [sw, el('span')]), el('span', { cls: 'name', text: s.name })]),
        el('div', { style: 'display:flex; gap:6px' }, [
          el('button', { cls: 'act', type: 'button', text: 'Run now', onclick: function (ev) {
            var b = ev.target; b.disabled = true; b.textContent = 'Starting...';
            var done = function (r) {
              toast(r.runId ? 'Sprint started' : (r.last ? r.last.text : 'Not started'));
              if (r.runId) openSprint(r.runId); else loadSchedules();
            };
            api('schedules/' + s.id + '/run', { method: 'POST', body: {} }).then(function (r) {
              if (!r.needsConfirm) return done(r);
              if (!confirm('This would normally not start now:\n\n- ' + r.warnings.join('\n- ') + '\n\nStart it anyway?')) { b.disabled = false; b.textContent = 'Run now'; return; }
              return api('schedules/' + s.id + '/run', { method: 'POST', body: { override: true } }).then(done);
            }).catch(function (e) { toast(e.message); loadSchedules(); });
          } }),
          el('button', { cls: 'act', type: 'button', text: 'Edit', onclick: function () { S2.editing = JSON.parse(JSON.stringify(s)); renderSchedules(); } }),
          el('button', { cls: 'act danger', type: 'button', text: 'Delete', onclick: function () { if (!confirm('Delete the schedule "' + s.name + '"? Sprints it started stay.')) return; api('schedules/' + s.id + '/delete', { method: 'POST', body: {} }).then(loadSchedules); } })
        ])
      ]),
      el('div', { cls: 'sentence', text: sentence(s) }),
      el('div', { cls: 'next' }, ['In ', el('code', { title: s.repo, text: s.repo }), ' ', s.folder === 'ready' ? el('span', { cls: 'ok-chip', text: 'folder ready' }) : el('span', { cls: 'warn-chip', text: { dirty: 'uncommitted changes' + (s.requireClean ? ': runs wait' : ''), missing: 'folder missing', 'not-git': 'not a git checkout' }[s.folder] || s.folder })]),
      el('div', { cls: 'next', text: s.enabled ? (s.nextAt ? (s.retryAt ? 'Trying again every 10 minutes while ' + (s.retryReason || 'the last skip reason holds') + '. Next try ' + clock(s.nextAt) + '.' : 'Next: ' + clock(s.nextAt) + ' (' + until(s.nextAt) + ')') : '') : 'Off' }),
      s.log.length ? (function () {
        var det = el('details', S2.openLogs[s.id] ? { open: true } : {}, [el('summary', { style: 'cursor:pointer; color:var(--muted); font-size:13px', text: 'What it did (' + s.log.length + ')' }), el('div', { style: 'max-height: 240px; overflow: auto' }, [logList])]);
        det.addEventListener('toggle', function () { S2.openLogs[s.id] = det.open; });
        return det;
      })() : el('div', { cls: 'next', text: 'Has not run yet.' })
    ]);
  }

  function scheduleForm(s) {
    s = s || {};
    var d = {
      id: s.id, name: s.name || '', repo: s.repo || lastFolder(),
      source: s.source || { type: 'ask', ask: '' }, design: s.design || 'auto',
      when: s.when || { type: 'daily', time: '02:00', days: [1, 2, 3, 4, 5] }, window: s.window || '',
      limits: s.limits || { perDay: 1 }, requireClean: s.requireClean !== false, comment: s.comment !== false, enabled: s.enabled !== false
    };
    if (d.source.type === 'issues' && Array.isArray(d.source.labels)) d.source.labels = d.source.labels.join(', ');
    var preview = el('div', { cls: 'preview-line', text: 'Fill in the steps below; a summary of when it runs appears here.' });
    var touched = !!s.id;
    function changed(fromUser) {
      if (fromUser !== false) touched = true;
      clearTimeout(S2.previewTimer);
      S2.previewTimer = setTimeout(function () {
        api('schedules/preview', { method: 'POST', body: d }).then(function (r) {
          if (!r.ok && !touched) return;
          preview.className = 'preview-line' + (r.ok ? '' : ' bad');
          preview.textContent = r.ok ? (r.schedule ? sentence(Object.assign({}, r.schedule, { whenText: r.whenText })) + ' ' : r.whenText + '. ') + (d.id ? 'Next run ' : 'First run ') + clock(r.nextAt) + ' (' + until(r.nextAt) + ').' + (r.schedule && r.schedule.comment ? ' It comments the result on each issue.' : '') : r.error;
        });
      }, 250);
    }
    function text(obj, key, ph, multi) { var t = el(multi ? 'textarea' : 'input', multi ? { placeholder: ph } : { type: 'text', placeholder: ph }); t.value = obj[key] || ''; t.addEventListener('input', function () { obj[key] = t.value; changed(); }); return t; }
    function num(obj, key, min, max, ph) { var n = el('input', { type: 'number', min: String(min), max: String(max), placeholder: ph || '' }); n.value = obj[key] === undefined ? '' : String(obj[key]); n.addEventListener('input', function () { obj[key] = n.value === '' ? undefined : Number(n.value); changed(); }); return n; }
    function check(label, obj, key) { var c = el('input', { type: 'checkbox' }); c.checked = obj[key] !== false; c.addEventListener('change', function () { obj[key] = c.checked; changed(); }); return el('label', { cls: 'inline' }, [c, label]); }
    function seg(options, get, set) {
      var s = el('div', { cls: 'seg', role: 'group' });
      options.forEach(function (o) { var b = el('button', { type: 'button', 'aria-pressed': get() === o[0] ? 'true' : 'false', text: o[1], onclick: function () { set(o[0]); draw(); changed(); } }); s.appendChild(b); });
      return s;
    }
    var box = el('div', { cls: 'form2' });
    function draw() {
      box.textContent = '';
      box.appendChild(el('div', { cls: 'hx-top' }, [el('h2', { text: d.id ? 'Edit schedule' : 'New schedule' })]));
      var what = el('fieldset', {}, [el('legend', { text: '1. What' }),
        el('label', { cls: 'wide' }, ['Name', text(d, 'name', 'e.g. Nightly issues')]),
        el('div', { cls: 'wide' }, [seg([['ask', 'A job I describe'], ['issues', 'GitHub issues']], function () { return d.source.type; }, function (v) { d.source = v === 'issues' ? { type: 'issues', repo: '', labels: 'lazyfleet', trustedOnly: true } : { type: 'ask', ask: '' }; })])
      ]);
      if (d.source.type === 'issues') {
        var repoIn = text(d.source, 'repo', 'owner/name');
        repoIn.setAttribute('list', 'sched-repos');
        var repoList = el('datalist', { id: 'sched-repos' });
        api('github/repos').then(function (r) {
          r.repos.forEach(function (x) { repoList.appendChild(el('option', { value: x.fullName })); });
          S2.repoFolders = {}; r.repos.forEach(function (x) { if (x.folder) S2.repoFolders[x.fullName] = x.folder; });
        }).catch(function () {});
        repoIn.addEventListener('change', function () {
          var f = S2.repoFolders && S2.repoFolders[repoIn.value.trim()];
          if (f && !d.repo) { d.repo = f; draw(); changed(); }
        });
        what.appendChild(el('label', {}, ['GitHub repo', repoIn, repoList]));
        what.appendChild(el('label', {}, ['Labels (all must match)', text(d.source, 'labels', 'lazyfleet')]));
        var trust = check('Only issues from the repo\'s owners, members and collaborators', d.source, 'trustedOnly');
        trust.querySelector('input').addEventListener('change', function () { draw(); changed(); });
        what.appendChild(trust);
        if (d.source.trustedOnly === false) what.appendChild(el('div', { cls: 'wide warn-chip', style: 'border-radius:8px; padding:8px 10px; font-size:13px', text: 'Anyone who can open an issue with these labels can now start a sprint, and the issue text becomes the helpers\' job description. Keep this on unless only your team can add these labels.' }));
        what.appendChild(check('Comment on the issue when the sprint finishes', d, 'comment'));
        what.appendChild(el('div', { cls: 'wide note', style: 'margin:0', text: 'Each issue is picked up once, oldest first. If its sprint does not pass, the issue stays open with a comment saying so; sprint it again from the Issues tab when you are ready.' }));
      } else {
        what.appendChild(el('label', { cls: 'wide' }, ['The job', text(d.source, 'ask', 'e.g. Update dependencies, fix anything that breaks, and keep the tests green.', true)]));
      }
      box.appendChild(what);
      box.appendChild(el('fieldset', {}, [el('legend', { text: '2. Where' }), el('label', { cls: 'wide' }, ['Project folder on this machine', text(d, 'repo', '/home/you/code/project')])]));
      var when = el('fieldset', {}, [el('legend', { text: '3. When' }), el('div', { cls: 'wide' }, [seg([['daily', 'At a time'], ['interval', 'Every few hours']], function () { return d.when.type; }, function (v) { d.when = v === 'interval' ? { type: 'interval', hours: 6 } : { type: 'daily', time: '02:00', days: [1, 2, 3, 4, 5] }; })])]);
      if (d.when.type === 'daily') {
        var t = el('input', { type: 'time', value: d.when.time || '02:00' });
        t.addEventListener('input', function () { d.when.time = t.value; changed(); });
        when.appendChild(el('label', {}, ['Time', t]));
        var days = el('div', { cls: 'days' });
        DAYNAMES.forEach(function (n, i) {
          days.appendChild(el('button', { type: 'button', 'aria-pressed': (d.when.days || []).indexOf(i) !== -1 ? 'true' : 'false', text: n, onclick: function () {
            var set = d.when.days || []; var k = set.indexOf(i); if (k === -1) set.push(i); else set.splice(k, 1); d.when.days = set; draw(); changed();
          } }));
        });
        when.appendChild(el('label', {}, ['Days (none means every day)', days]));
      } else {
        when.appendChild(el('label', {}, ['Every how many hours', num(d.when, 'hours', 1, 168, '6')]));
      }
      when.appendChild(el('label', {}, ['Only between (optional)', text(d, 'window', 'optional, e.g. 22:00-07:00')]));
      when.appendChild(el('div', { cls: 'wide note', style: 'margin:0', text: d.when.type === 'daily' ? 'It starts once at that time. If it has to wait (a sprint already running, uncommitted changes), it tries again every 10 minutes. The daily limit counts those and Run now too. 02:00 on Mon-Fri means early Monday to Friday mornings.' : 'It starts once per interval, counted from the last start.' }));
      box.appendChild(when);
      var design = designSelect(d.design, true);
      design.addEventListener('change', function () { d.design = design.value; changed(); });
      box.appendChild(el('fieldset', {}, [el('legend', { text: '4. How' }), el('label', {}, ['Sprint design', design]), el('div', { cls: 'note', style: 'margin:0; align-self:center', text: 'With "Let lazyfleet pick", each run gets the design that fits it best, and gets better as your history grows.' })]));
      box.appendChild(el('fieldset', {}, [el('legend', { text: '5. Limits' }),
        el('label', {}, ['Sprints per day at most', num(d.limits, 'perDay', 1, 20, '1')]),
        el('label', { title: 'An estimate from token prices; on a subscription this is plan usage' }, ['Usage per day at most (estimated $)', num(d.limits, 'usagePerDay', 0, 1000, 'no limit')]),
        check('Skip when the folder has uncommitted changes', d, 'requireClean')
      ]));
      box.appendChild(preview);
      box.appendChild(el('div', { style: 'display:flex; gap:8px; justify-content:flex-end' }, [
        el('button', { cls: 'act', type: 'button', text: 'Cancel', onclick: function () { S2.editing = null; S2.prefill = null; history.replaceState(null, '', '#schedules'); renderSchedules(); } }),
        el('button', { cls: 'act primary', type: 'button', text: d.id ? 'Save changes' : 'Create schedule', onclick: function () {
          api('schedules', { method: 'POST', body: d }).then(function (r) { toast('Saved - next run ' + until(r.schedule.nextAt)); if (d.repo) rememberFolder(d.repo); S2.editing = null; S2.prefill = null; history.replaceState(null, '', '#schedules'); loadSchedules(); })
            .catch(function (e) { preview.className = 'preview-line bad'; preview.textContent = e.message; });
        } })
      ]));
    }
    draw();
    changed(false);
    return box;
  }

  function renderSchedules() {
    schedRoot.textContent = '';
    var creating = S2.editing || S2.prefill || /^#schedules\/new/.test(location.hash);
    schedRoot.appendChild(el('div', { cls: 'hx-top' }, [
      el('div', {}, [el('h2', { text: 'Schedules' }), el('div', { cls: 'hx-sub', text: 'Sprints that start themselves, within limits you set. Each run and each skip is logged with its reason.' })]),
      creating ? null : el('button', { cls: 'act primary', type: 'button', text: 'New schedule', onclick: function () { S2.editing = null; S2.prefill = {}; renderSchedules(); } })
    ]));
    if (creating) { schedRoot.appendChild(scheduleForm(S2.editing || S2.prefill)); return; }
    if (!S2.list || !S2.list.length) {
      schedRoot.appendChild(el('div', { cls: 'steps' }, [
        el('div', { cls: 'step' }, [el('b', { text: 'Nightly issues' }), el('p', { text: 'Weekdays at 02:00, take the oldest issue labeled lazyfleet, sprint it with the suggested design, and comment the result on the issue.' }), el('button', { cls: 'linkish', type: 'button', text: 'Use this ->', onclick: function () { S2.prefill = { name: 'Nightly issues', source: { type: 'issues', repo: '', labels: ['lazyfleet'], trustedOnly: true }, when: { type: 'daily', time: '02:00', days: [1, 2, 3, 4, 5] }, window: '', limits: { perDay: 2, usagePerDay: 5 } }; renderSchedules(); } })]),
        el('div', { cls: 'step' }, [el('b', { text: 'Weekly upkeep' }), el('p', { text: 'Every Monday morning, update dependencies, fix what breaks and keep the tests green.' }), el('button', { cls: 'linkish', type: 'button', text: 'Use this ->', onclick: function () { S2.prefill = { name: 'Weekly upkeep', source: { type: 'ask', ask: 'Update the dependencies to their latest compatible versions, fix anything that breaks, and keep the tests passing.' }, when: { type: 'daily', time: '07:00', days: [1] }, limits: { perDay: 1, usagePerDay: 3 } }; renderSchedules(); } })]),
        el('div', { cls: 'step' }, [el('b', { text: 'Test sweep' }), el('p', { text: 'Every night, write and run end-to-end tests of the main flows and turn failures into tasks, without changing product code.' }), el('button', { cls: 'linkish', type: 'button', text: 'Use this ->', onclick: function () { S2.prefill = { name: 'Nightly test sweep', source: { type: 'ask', ask: 'Write and run end-to-end tests of the main user flows and report every behaviour that does not work.' }, design: 'e2e-only', when: { type: 'daily', time: '03:00', days: [] }, limits: { perDay: 1, usagePerDay: 2 } }; renderSchedules(); } })])
      ]));
      return;
    }
    S2.list.forEach(function (s) { schedRoot.appendChild(schedCard(s)); });
  }

  // =========================================================================
  // First-run welcome
  // =========================================================================
  var W = { step: 0, data: null };
  function closeWelcome(done) {
    var b = document.querySelector('.wel-back'); if (b) b.remove();
    if (done) api('welcome/done', { method: 'POST', body: {} }).catch(function () {});
  }
  function welcome() {
    var back = document.querySelector('.wel-back');
    if (!back) { back = el('div', { cls: 'wel-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to lazyfleet' }); document.body.appendChild(back); }
    back.textContent = '';
    var box = el('div', { cls: 'wel' });
    back.appendChild(box);
    box.appendChild(el('div', { cls: 'dots' }, [0, 1, 2].map(function (i) { return el('i', { cls: i <= W.step ? 'on' : '' }); })));
    var d = W.data;
    if (W.step === 0) {
      box.appendChild(el('h2', {}, ['Welcome to lazy', el('span', { text: 'fleet' })]));
      box.appendChild(el('p', { text: 'It is already running, and Claude Code already goes through it. Nothing to configure. Here is what it does for you:' }));
      [['*', 'Secrets stay secret', 'Paste keys and passwords straight into Claude. It only ever sees a stand-in; the real value is used when a command runs.'],
       ['>', 'Whole jobs, handed off', 'Describe a job and helpers plan it, build it in private copies of your project, and review it while you keep working.'],
       ['#', 'Your GitHub issues, on autopilot', 'Turn any issue into a sprint with one click, or let a schedule pick up labeled issues overnight and report back.']
      ].forEach(function (f) { box.appendChild(el('div', { cls: 'feat' }, [el('div', { cls: 'ic', text: f[0] }), el('div', {}, [el('b', { text: f[1] }), el('span', { text: f[2] })])])); });
      box.appendChild(el('div', { cls: 'foot' }, [
        el('button', { cls: 'linkish', type: 'button', text: 'Skip setup', onclick: function () { closeWelcome(true); } }),
        el('button', { cls: 'act primary', type: 'button', text: 'Quick setup (1 minute)', onclick: function () { W.step = 1; welcome(); } })
      ]));
    } else if (W.step === 1) {
      box.appendChild(el('h2', { text: 'Connect GitHub' }));
      box.appendChild(el('p', { text: 'Optional. It lets lazyfleet show your issues and turn them into sprints. The sign-in is stored encrypted on this machine and is never shown to Claude.' }));
      var next = function () { W.step = 2; welcome(); };
      if (d.github.signedIn) {
        box.appendChild(el('div', { cls: 'opt best' }, [el('b', { text: 'Connected as ' + d.github.login }), el('p', { text: 'Your issues are on the Issues tab.' })]));
      } else {
        if (d.ghCli) box.appendChild(el('div', { cls: 'opt best' }, [
          el('b', { text: 'Use your GitHub CLI login' }), el('p', { text: 'Found a signed-in GitHub CLI (gh) on this machine. One click, nothing copied.' }),
          el('div', {}, [el('button', { cls: 'act primary', type: 'button', text: 'Use gh login', onclick: function (e) {
            e.target.disabled = true;
            api('github/use-cli', { method: 'POST', body: {} }).then(function (r) { toast('Connected as ' + r.login); d.github.signedIn = true; d.github.login = r.login; next(); }).catch(function (err) { toast(err.message); e.target.disabled = false; });
          } })])
        ]));
        var tok = el('input', { type: 'password', placeholder: 'ghp_... or github_pat_...', 'aria-label': 'GitHub token' });
        box.appendChild(el('div', { cls: 'opt' + (d.ghCli ? '' : ' best') }, [
          el('b', { text: 'Paste a token' }), el('p', { text: 'A fine-grained token with Issues read and write on your repos. Create one at github.com/settings/tokens.' }),
          el('div', { cls: 'row2' }, [tok, el('button', { cls: 'act' + (d.ghCli ? '' : ' primary'), type: 'button', text: 'Connect', onclick: function () {
            api('github/token', { method: 'POST', body: { token: tok.value.trim() } }).then(function (r) { toast('Connected as ' + r.login); d.github.signedIn = true; d.github.login = r.login; next(); }).catch(function (err) { toast(err.message); });
          } })])
        ]));
        if (!d.ghCli) box.appendChild(el('p', { style: 'font-size:13px', text: 'Use the GitHub CLI? Run gh auth login in a terminal, then open this step again: lazyfleet will offer to use it.' }));
        if (d.github.clientIdSet) box.appendChild(el('div', {}, [el('button', { cls: 'linkish', type: 'button', text: 'Or sign in with GitHub in the browser ->', onclick: function () { closeWelcome(false); goTab('issues'); } })]));
      }
      box.appendChild(el('div', { cls: 'foot' }, [
        el('button', { cls: 'linkish', type: 'button', text: d.github.signedIn ? 'Back' : 'Skip for now', onclick: function () { if (d.github.signedIn) { W.step = 0; welcome(); } else next(); } }),
        el('button', { cls: 'act primary', type: 'button', text: 'Next', onclick: next })
      ]));
    } else {
      box.appendChild(el('h2', { text: 'You are set' }));
      box.appendChild(el('p', { text: d.autostart ? 'lazyfleet keeps running in the background and starts again when you log in. Three ways back to this page:' : 'lazyfleet is running now. This machine cannot start it on its own after a reboot, so run lazyfleet on when you log in. Three ways back to this page:' }));
      var url = d.pageUrl;
      box.appendChild(el('div', { cls: 'how' }, [
        el('span', { cls: 'n', text: '1' }), el('div', {}, [el('b', { text: 'Bookmark it' }), el('div', {}, [el('code', { text: url }), ' ', el('button', { cls: 'linkish', type: 'button', text: 'Copy', onclick: function () { navigator.clipboard.writeText(url).then(function () { toast('Copied'); }); } })])]),
        el('span', { cls: 'n', text: '2' }), el('div', {}, [el('b', { text: 'From any terminal' }), el('div', {}, [el('code', { text: 'lazyfleet ui' }), ' opens it; ', el('code', { text: 'lazyfleet status' }), ' checks everything is on.'])]),
        el('span', { cls: 'n', text: '3' }), el('div', {}, [el('b', { text: 'From Claude' }), el('div', { text: 'Ask for a bigger job as usual. Claude offers to hand it to a sprint and gives you the link.' })])
      ]));
      box.appendChild(el('div', { cls: 'foot' }, [
        el('button', { cls: 'linkish', type: 'button', text: 'Back', onclick: function () { W.step = 1; welcome(); } }),
        el('button', { cls: 'act primary', type: 'button', text: 'Start my first sprint', onclick: function () {
          closeWelcome(true); goTab('home');
          setTimeout(function () { var t = document.querySelector('.composer textarea'); if (t) t.focus(); }, 400);
        } })
      ]));
    }
    var first = box.querySelector('button.primary'); if (first) first.focus();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.querySelector('.wel-back')) closeWelcome(true); });
  api('welcome').then(function (r) { W.data = r; if (!r.done) welcome(); }).catch(function () {});

  // =========================================================================
  // Wiring
  // =========================================================================
  var current = null;
  function refresh() {
    if (current === 'home') loadHome();
    else if (current === 'issues') loadIssues();
    else if (current === 'schedules') loadSchedules();
  }
  window.addEventListener('lazy:tab', function (e) {
    current = e.detail;
    designsCache = null;
    if (current === 'schedules' && /^#schedules\/new/.test(location.hash) && !S2.prefill) S2.prefill = {};
    refresh();
  });
  // This script loads after the page picked its first tab, so read it here.
  var shown = document.querySelector('main > section:not([hidden])');
  if (shown) { current = shown.id.replace('tab-', ''); if (current === 'schedules' && /^#schedules\/new/.test(location.hash)) S2.prefill = {}; refresh(); }
  // Keep numbers fresh, but never redraw under someone who is typing.
  setInterval(function () {
    var a = document.activeElement;
    var typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT');
    if (typing) return;
    if (current === 'home') loadHome();
    if (current === 'schedules' && !S2.editing && !S2.prefill) loadSchedules();
  }, 8000);
})();
`;
