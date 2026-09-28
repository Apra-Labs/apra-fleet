/**
 * Flows: the review page. Claude writes flows; the person reads them here,
 * approves the exact version that may run, and looks at what each run did.
 * Nothing is edited on this page; changes are asked of Claude. String.raw so
 * client-side regexes keep their backslashes; never put a backtick or
 * dollar-brace here.
 */

export const FLOWS_CSS = String.raw`
.fl-list { display: grid; gap: 12px; }
.fl-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.fl-card:hover { border-color: var(--muted); }
.fl-card .top { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
.fl-card .nm { font-weight: 600; font-size: 16px; }
.fl-card .pp { color: var(--muted); font-size: 14px; }
.fl-meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.fl-chip { display: inline-block; border-radius: 999px; padding: 1px 9px; font-size: 12px; border: 1px solid var(--line); background: var(--chip); color: var(--muted); }
.fl-chip.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
.fl-chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.fl-chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
.fl-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.fl-head h2 { margin: 0; font-size: 22px; }
.fl-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.fl-banner { border-radius: 10px; padding: 10px 14px; font-size: 14px; border: 1px solid var(--line); background: var(--chip); }
.fl-banner.warn { background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
.fl-banner.ok { background: color-mix(in srgb, var(--ok) 8%, var(--panel)); border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.fl-banner ul { margin: 4px 0 0; padding-left: 18px; }
.fl-graph { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
.fl-block { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.fl-block.changed { border-color: var(--warn); box-shadow: 0 0 0 1px var(--warn); }
.fl-block .bt { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.fl-block .n { width: 24px; height: 24px; border-radius: 50%; background: var(--chip); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
.fl-block .bn { font-weight: 600; }
.fl-block .job { white-space: pre-wrap; font-size: 14px; }
.fl-block code { background: var(--chip); padding: 1px 6px; border-radius: 6px; }
.fl-edge { align-self: center; color: var(--muted); font-size: 12px; padding: 4px 0; display: flex; flex-direction: column; align-items: center; }
.fl-edge .ln { width: 2px; height: 14px; background: var(--line); }
.fl-edges { display: flex; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.fl-edges span { border-radius: 6px; padding: 1px 7px; background: var(--chip); color: var(--muted); }
.fl-edges .pass { color: var(--ok); }
.fl-edges .fail { color: var(--bad); }
.fl-runs td { font-size: 14px; }
.fl-runs tr { cursor: pointer; }
.fl-steps { display: flex; flex-direction: column; gap: 10px; }
.fl-step { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; }
.fl-step .st { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 14px; }
.fl-step pre { white-space: pre-wrap; margin: 8px 0 0; font-family: var(--mono); font-size: 12.5px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; max-height: 320px; overflow: auto; }
.fl-step .nt { color: var(--muted); font-size: 13px; margin-top: 4px; }
.fl-2 { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 800px) { .fl-2 { grid-template-columns: 1fr; } }
`;

export const FLOWS_HTML = String.raw`
  <section id="tab-flows" hidden><div id="flows-root" class="hx"></div></section>
`;

export const FLOWS_JS = String.raw`
(function () {
  var root = document.getElementById('flows-root');
  var F = { timer: null, view: null };
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
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function toast(m) { var t = document.getElementById('toast'); t.textContent = m; t.classList.add('on'); setTimeout(function () { t.classList.remove('on'); }, 2400); }
  function money(n) { return '$' + (n || 0).toFixed(n && n < 0.1 ? 3 : 2); }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function took(a, b) {
    if (!a || !b) return '';
    var s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  function go(hash) { history.replaceState(null, '', '#' + hash); render(); }
  function route() { var p = location.hash.slice(1).split('/'); return { id: p[1] || null, run: p[2] || null }; }

  function approvalChip(a) {
    if (a.state === 'approved') return el('span', { cls: 'fl-chip ok', text: 'Approved ' + ago(a.at) });
    if (a.state === 'changed') return el('span', { cls: 'fl-chip warn', text: 'Changed since you approved' });
    return el('span', { cls: 'fl-chip warn', text: 'Needs your approval' });
  }
  var RUN_LABEL = { running: 'Running', passed: 'Passed', failed: 'Failed', error: 'Error', stopped: 'Stopped' };
  function runChip(r) {
    var cls = r.status === 'passed' ? 'ok' : r.status === 'running' ? '' : 'bad';
    return el('span', { cls: 'fl-chip ' + cls, text: (r.trial ? 'Trial: ' : '') + (RUN_LABEL[r.status] || r.status) });
  }
  var STEP_LABEL = { pass: 'passed', fail: 'failed', skipped: 'skipped', running: 'running' };

  // ---- list ----------------------------------------------------------------
  function renderList() {
    api('flows').then(function (r) {
      root.textContent = '';
      root.appendChild(el('div', { cls: 'hx-top' }, [el('div', {}, [
        el('h2', { text: 'Flows' }),
        el('div', { cls: 'hx-sub', text: 'Fixed jobs made of blocks, each with its own job, model and tools. Claude designs them when you ask; you review and approve them here. Only an approved version runs for real.' })
      ])]));
      if (!r.flows.length) {
        root.appendChild(el('div', { cls: 'fl-banner' }, [
          el('b', { text: 'No flows yet. ' }),
          'Ask Claude for a job you want done the same way every time, for example: "every weekday at 6pm, fill my timesheet from what I did today". It designs the flow, tries it without changing anything, and sends you here to approve it.'
        ]));
        return;
      }
      var list = el('div', { cls: 'fl-list' });
      r.flows.forEach(function (v) {
        var f = v.flow;
        list.appendChild(el('div', { cls: 'fl-card', role: 'button', tabindex: '0', onclick: function () { go('flows/' + f.id); } }, [
          el('div', { cls: 'top' }, [el('span', { cls: 'nm', text: f.name }), approvalChip(v.approval)]),
          el('div', { cls: 'pp', text: f.purpose }),
          el('div', { cls: 'fl-meta' }, [
            el('span', { text: f.blocks.length + ' block' + (f.blocks.length === 1 ? '' : 's') }),
            v.schedules.length ? el('span', { text: v.schedules.map(function (s) { return s.whenText + (s.enabled ? '' : ' (off)'); }).join('; ') }) : el('span', { text: 'not scheduled' }),
            v.running ? el('span', { cls: 'fl-chip', text: 'Running now' }) : v.lastRun ? el('span', {}, [runChip(v.lastRun), ' ' + ago(v.lastRun.startedAt)]) : el('span', { text: 'never run' }),
            v.problems.length ? el('span', { cls: 'fl-chip bad', text: 'Cannot run: ' + v.problems[0] }) : null
          ])
        ]));
      });
      root.appendChild(list);
    }).catch(function (e) { root.textContent = 'Could not load: ' + e.message; });
  }

  // ---- one flow ------------------------------------------------------------
  function toolText(b, t) {
    var trial = (b.trialTools || []).indexOf(t) !== -1;
    return el('code', { title: trial ? 'Also used in trial runs' : '', text: t + (trial ? ' (trial ok)' : '') });
  }
  function spaced(list) { return list.reduce(function (a, x) { if (a.length) a.push(' '); a.push(x); return a; }, []); }
  function edgeText(v) { return v === 'end' ? 'finish (passed)' : v === 'stop' ? 'stop (failed)' : v; }
  function blockCard(b, i, changed) {
    var tier = b.kind === 'command' ? 'shell command' : b.modelLabel;
    var kids = [
      el('div', { cls: 'bt' }, [
        el('span', { cls: 'n', text: String(i + 1) }),
        el('span', { cls: 'bn', text: b.name || b.id }),
        el('span', { cls: 'fl-chip', text: tier }),
        b.name ? el('span', { cls: 'fl-chip', text: b.id }) : null,
        changed ? el('span', { cls: 'fl-chip warn', text: 'changed' }) : null
      ]),
      el('div', { cls: 'job', text: b.purpose })
    ];
    if (b.kind === 'command') kids.push(el('div', {}, ['Runs ', el('code', { text: b.command }), b.runInTrial ? ' (also in trial runs)' : ' (skipped in trial runs)']));
    else {
      kids.push(el('div', { cls: 'fl-meta' }, [(b.tools && b.tools.length) ? el('span', {}, ['Tools: '].concat(spaced(b.tools.map(function (t) { return toolText(b, t); })))) : el('span', { text: 'No tools: it only thinks and writes its answer' })]));
      var trialOnly = (b.trialTools || []).filter(function (t) { return (b.tools || []).indexOf(t) === -1; });
      if (trialOnly.length) kids.push(el('div', { cls: 'fl-meta' }, [el('span', {}, ['In trial runs only: '].concat(spaced(trialOnly.map(function (t) { return el('code', { text: t }); }))))]));
    }
    var edges = [el('span', { cls: 'pass', text: 'pass -> ' + edgeText(b.edges.pass) }), el('span', { cls: 'fail', text: 'fail -> ' + (b.retries ? 'try again ' + b.retries + 'x, then ' : '') + edgeText(b.edges.fail) })];
    if (b.input && b.input.length) edges.push(el('span', { text: 'reads the output of ' + b.input.join(', ') }));
    if (b.timeoutMinutes) edges.push(el('span', { text: 'time limit ' + b.timeoutMinutes + 'm' }));
    kids.push(el('div', { cls: 'fl-edges' }, edges));
    return el('div', { cls: 'fl-block' + (changed ? ' changed' : '') }, kids);
  }
  function graph(v) {
    var g = el('div', { cls: 'fl-graph' });
    var changed = (v.approval.changed || []);
    var blocks = v.graph.blocks;
    blocks.forEach(function (b, i) {
      if (i) {
        var prev = blocks[i - 1];
        var straight = prev.edges.pass === b.id;
        g.appendChild(el('div', { cls: 'fl-edge' }, [el('span', { cls: 'ln' }), straight ? 'on pass' : '', el('span', { cls: 'ln' })]));
      }
      g.appendChild(blockCard(b, i, v.approval.state === 'changed' && changed.indexOf(b.id) !== -1));
    });
    return g;
  }
  function runsTable(v) {
    if (!v.runs.length) return el('div', { cls: 'note', style: 'margin:0', text: 'No runs yet.' });
    var body = el('tbody');
    v.runs.forEach(function (r) {
      body.appendChild(el('tr', { onclick: function () { go('flows/' + v.flow.id + '/' + r.runId); } }, [
        el('td', { text: ago(r.startedAt) }),
        el('td', {}, [runChip(r)]),
        el('td', { text: r.trigger === 'schedule' ? 'scheduled' : r.trigger === 'trial' ? 'trial' : 'by hand' }),
        el('td', { text: money(r.cost) }),
        el('td', { cls: 'hide-sm', text: r.stepCount + ' step' + (r.stepCount === 1 ? '' : 's') })
      ]));
    });
    return el('div', { cls: 'card' }, [el('table', { cls: 'fl-runs' }, [el('thead', {}, [el('tr', {}, [el('th', { text: 'When' }), el('th', { text: 'Result' }), el('th', { text: 'Started' }), el('th', { text: 'Usage' }), el('th', { cls: 'hide-sm', text: 'Steps' })])]), body])]);
  }
  function runButtons(v) {
    var f = v.flow;
    var out = [];
    function start(trial) {
      return function () {
        api('flows/' + f.id + '/run', { method: 'POST', body: { trial: trial } }).then(function (r) { toast(trial ? 'Trial started' : 'Started'); go('flows/' + f.id + '/' + r.runId); }).catch(function (e) { toast(e.message); });
      };
    }
    if (v.running) out.push(el('button', { cls: 'act', type: 'button', text: 'Watch the run', onclick: function () { go('flows/' + f.id + '/' + v.running); } }));
    else {
      out.push(el('button', { cls: 'act', type: 'button', text: 'Trial run', title: 'Read-only tools, nothing is changed', onclick: start(true) }));
      if (v.approval.state === 'approved') out.push(el('button', { cls: 'act', type: 'button', text: 'Run now', onclick: start(false) }));
    }
    return out;
  }
  function renderFlow(id) {
    api('flows/' + id).then(function (v) {
      F.view = v;
      var f = v.flow;
      root.textContent = '';
      var actions = runButtons(v);
      if (v.approval.state === 'approved') actions.push(el('button', { cls: 'act danger', type: 'button', text: 'Withdraw approval', onclick: function () {
        if (!confirm('Withdraw your approval? Its schedules skip until you approve it again.')) return;
        api('flows/' + f.id + '/revoke', { method: 'POST', body: {} }).then(function () { renderFlow(id); });
      } }));
      else if (!v.problems.length) actions.push(el('button', { cls: 'act primary', type: 'button', text: v.approval.state === 'changed' ? 'Approve this version' : 'Approve', onclick: function () {
        api('flows/' + f.id + '/approve', { method: 'POST', body: { hash: v.approval.hash } }).then(function () { toast('Approved'); renderFlow(id); }).catch(function (e) { toast(e.message); renderFlow(id); });
      } }));
      actions.push(el('button', { cls: 'act danger', type: 'button', text: 'Delete', onclick: function () {
        if (!confirm('Delete the flow "' + f.name + '"? Its schedules stop starting it.')) return;
        api('flows/' + f.id, { method: 'DELETE' }).then(function () { go('flows'); }).catch(function (e) { toast(e.message); });
      } }));
      root.appendChild(el('div', {}, [el('button', { cls: 'linkish', type: 'button', text: '<- All flows', onclick: function () { go('flows'); } })]));
      root.appendChild(el('div', { cls: 'fl-head' }, [
        el('div', {}, [el('h2', { text: f.name }), el('div', { cls: 'hx-sub', text: f.purpose })]),
        el('div', { cls: 'fl-actions' }, actions)
      ]));
      if (v.problems.length) root.appendChild(el('div', { cls: 'fl-banner warn' }, [el('b', { text: 'This flow cannot run. Ask Claude to fix it:' }), el('ul', {}, v.problems.map(function (p) { return el('li', { text: p }); }))]));
      else if (v.approval.state === 'never') root.appendChild(el('div', { cls: 'fl-banner warn', text: 'Claude designed this flow. Read the blocks below: what each one does, the model it uses and the tools it may touch. It runs for real, and on its schedules, only once you approve it. A trial run changes nothing and needs no approval.' }));
      else if (v.approval.state === 'changed') root.appendChild(el('div', { cls: 'fl-banner warn', text: 'This flow changed since you approved it (' + v.approval.changed.join(', ') + '). The changed blocks are outlined. It will not run for real until you approve this version.' }));
      else root.appendChild(el('div', { cls: 'fl-banner ok', text: 'Approved ' + ago(v.approval.at) + '. To change it, ask Claude; a changed flow waits for your approval again.' }));
      if (v.warnings.length) root.appendChild(el('div', { cls: 'fl-banner' }, [el('b', { text: 'Worth knowing' }), el('ul', {}, v.warnings.map(function (w) { return el('li', { text: w }); }))]));
      var side = el('div', { style: 'display:flex; flex-direction:column; gap:12px' }, [
        el('h3', { style: 'margin:0', text: 'Runs' }), runsTable(v),
        el('h3', { style: 'margin:8px 0 0', text: 'When it runs' }),
        v.schedules.length ? el('ul', { style: 'margin:0; padding-left:18px' }, v.schedules.map(function (s) { return el('li', { text: s.name + ': ' + s.whenText + (s.enabled ? '' : ' (off)') }); })) : el('div', { cls: 'note', style: 'margin:0', text: 'Only when started. Ask Claude to schedule it.' }),
        el('h3', { style: 'margin:8px 0 0', text: 'Where it works' }),
        el('div', {}, [el('code', { text: f.folder || '(a scratch folder of its own)' })]),
        (f.context && f.context.length) ? el('div', { cls: 'note', style: 'margin:0', text: 'Every block also reads: ' + f.context.join(', ') }) : null,
        f.limits && f.limits.usd ? el('div', { cls: 'note', style: 'margin:0', text: 'Stops a run after about ' + money(f.limits.usd) + ' of usage.' }) : null
      ]);
      root.appendChild(el('div', { cls: 'fl-2' }, [el('div', {}, [el('h3', { style: 'margin:0 0 10px', text: 'Blocks' }), graph(v)]), side]));
      if (v.running) poll(function () { renderFlow(id); });
    }).catch(function (e) { root.textContent = 'Could not load: ' + e.message; });
  }

  // ---- one run -------------------------------------------------------------
  function renderRun(id, runId) {
    api('flow-runs/' + runId).then(function (r) {
      root.textContent = '';
      root.appendChild(el('div', {}, [el('button', { cls: 'linkish', type: 'button', text: '<- ' + r.flowName, onclick: function () { go('flows/' + id); } })]));
      var actions = [];
      if (r.status === 'running') actions.push(el('button', { cls: 'act danger', type: 'button', text: 'Stop', onclick: function () { api('flow-runs/' + runId + '/stop', { method: 'POST', body: {} }).then(function () { toast('Stopping'); }); } }));
      root.appendChild(el('div', { cls: 'fl-head' }, [
        el('div', {}, [el('h2', {}, [(r.trial ? 'Trial run' : 'Run') + ' ', runChip(r)]), el('div', { cls: 'hx-sub', text: new Date(r.startedAt).toLocaleString() + (r.endedAt ? ', took ' + took(r.startedAt, r.endedAt) : '') + ', ' + money(r.cost) + ' usage' + (r.trigger === 'schedule' ? ', started by its schedule' : '') })]),
        el('div', { cls: 'fl-actions' }, actions)
      ]));
      if (r.error) root.appendChild(el('div', { cls: 'fl-banner warn', text: 'Stopped because it ' + r.error + '.' }));
      if (r.trial) root.appendChild(el('div', { cls: 'fl-banner', text: 'A trial run changes nothing: blocks had only read-only tools and say what they would have done.' }));
      if (r.input) root.appendChild(el('div', { cls: 'fl-step' }, [el('b', { text: 'Input' }), el('pre', { text: r.input })]));
      var steps = el('div', { cls: 'fl-steps' });
      r.steps.forEach(function (s) {
        var cls = s.status === 'pass' ? 'ok' : s.status === 'fail' ? 'bad' : '';
        steps.appendChild(el('div', { cls: 'fl-step' }, [
          el('div', { cls: 'st' }, [
            el('b', { text: s.block }),
            s.attempt > 1 ? el('span', { cls: 'fl-chip', text: 'try ' + s.attempt }) : null,
            el('span', { cls: 'fl-chip ' + cls, text: STEP_LABEL[s.status] || s.status }),
            s.model ? el('span', { cls: 'fl-chip', text: s.model }) : null,
            s.cost ? el('span', { cls: 'fl-chip', text: money(s.cost) }) : null,
            s.endedAt ? el('span', { cls: 'fl-chip', text: took(s.startedAt, s.endedAt) }) : null,
            s.next ? el('span', { cls: 'fl-chip', text: '-> ' + edgeText(s.next) }) : null
          ]),
          s.error ? el('div', { cls: 'nt', style: 'color:var(--bad)', text: s.error }) : null,
          s.notes ? el('div', { cls: 'nt', text: s.notes }) : null,
          s.output ? el('pre', { text: s.output }) : null
        ]));
      });
      root.appendChild(steps);
      if (r.status === 'running') poll(function () { renderRun(id, runId); });
    }).catch(function (e) { root.textContent = 'Could not load: ' + e.message; });
  }

  function poll(fn) {
    clearTimeout(F.timer);
    F.timer = setTimeout(function () { if (/^#flows/.test(location.hash)) fn(); }, 2500);
  }
  function render() {
    clearTimeout(F.timer);
    var r = route();
    if (r.id && r.run) renderRun(r.id, r.run);
    else if (r.id) renderFlow(r.id);
    else renderList();
  }
  window.addEventListener('lazy:tab', function (e) { if (e.detail === 'flows') render(); });
  if (/^#flows/.test(location.hash)) render();
})();
`;
