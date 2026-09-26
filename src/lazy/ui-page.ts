/**
 * The settings page, served by the background process at /_lazy/.
 * Self-contained (no external requests) so it works offline and the CSP
 * can stay tight. Every dynamic value goes through textContent.
 */
export function renderUi(): string {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lazyfleet</title>
<style>
:root {
  --bg: #f6f4ef; --panel: #ffffff; --ink: #1d1b16; --muted: #6b665c; --line: #e4dfd4;
  --accent: #c2410c; --accent-ink: #ffffff; --ok: #15803d; --warn: #b45309; --bad: #b91c1c;
  --chip: #f1ece2; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15130f; --panel: #1e1b16; --ink: #f1ece2; --muted: #a39d90; --line: #332e26;
    --accent: #fb923c; --accent-ink: #1d1b16; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; --chip: #2a261f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 28px 20px 8px; max-width: 980px; margin: 0 auto; display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
h1 span { color: var(--accent); }
.status { color: var(--muted); font-size: 14px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); margin-right: 6px; vertical-align: 1px; }
main { max-width: 980px; margin: 0 auto; padding: 8px 20px 60px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0 20px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.stat b { display: block; font-size: 26px; letter-spacing: -0.02em; }
.stat small { color: var(--muted); }
nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 16px; overflow-x: auto; }
nav button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 14px; color: var(--muted); font: inherit; cursor: pointer; }
nav button[aria-selected="true"] { color: var(--ink); border-color: var(--accent); }
section[hidden] { display: none; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
code, .mono { font-family: var(--mono); font-size: 13px; }
.chip { display: inline-block; background: var(--chip); border-radius: 999px; padding: 1px 9px; font-size: 12px; color: var(--muted); }
.empty { padding: 28px; text-align: center; color: var(--muted); }
button.act { background: var(--chip); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 13px; cursor: pointer; }
button.act:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.danger:hover { color: var(--bad); border-color: var(--bad); }
.row-actions { display: flex; gap: 6px; justify-content: flex-end; }
form.add { display: flex; gap: 8px; padding: 14px; border-top: 1px solid var(--line); flex-wrap: wrap; }
input[type=text], input[type=password], input[type=number] { background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font: inherit; min-width: 0; }
form.add input { flex: 1 1 180px; }
.setting { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.setting:last-child { border-bottom: 0; }
.setting p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.setting input[type=number] { width: 90px; }
.note { color: var(--muted); font-size: 13px; margin: 10px 2px; }
.caught { color: var(--accent); } .hidden-ev { color: var(--muted); } .error { color: var(--bad); }
.presets-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 16px; }
.presets-form .wide { grid-column: 1 / -1; }
.presets-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.presets-form label.inline { flex-direction: row; align-items: center; gap: 8px; color: var(--ink); }
.presets-form .actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
input.desc { width: 100%; }
pre.preview { margin: 0; padding: 14px 16px; white-space: pre-wrap; font-family: var(--mono); font-size: 12.5px; color: var(--muted); }
h2 { font-size: 15px; margin: 22px 2px 8px; }
@media (max-width: 640px) { .presets-form { grid-template-columns: 1fr; } }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 16px; border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.on { opacity: 1; }
@media (max-width: 640px) { .hide-sm { display: none; } th, td { padding: 10px; } }
</style>
</head>
<body>
<header>
  <h1>lazy<span>fleet</span></h1>
  <div class="status"><span class="dot"></span><span id="up">running</span></div>
</header>
<main>
  <div class="stats">
    <div class="stat"><b id="s-vault">-</b><small>secrets in the vault</small></div>
    <div class="stat"><b id="s-caught">-</b><small>caught since start</small></div>
    <div class="stat"><b id="s-hidden">-</b><small>times hidden from the model</small></div>
    <div class="stat"><b id="s-helpers">-</b><small>helpers right now</small></div>
  </div>
  <nav role="tablist">
    <button role="tab" data-tab="vault" aria-selected="true">Vault</button>
    <button role="tab" data-tab="presets">Presets</button>
    <button role="tab" data-tab="activity">Activity</button>
    <button role="tab" data-tab="helpers">Helpers</button>
    <button role="tab" data-tab="settings">Settings</button>
  </nav>

  <section id="tab-vault">
    <div class="card">
      <table><thead><tr><th>Name</th><th>Value</th><th class="hide-sm">Caught in</th><th class="hide-sm">Last seen</th><th></th></tr></thead>
      <tbody id="vault-rows"></tbody></table>
    </div>
    <p class="note">Claude only ever sees <code>{{secure.name}}</code>. The real value is put back when a command or file edit runs on this machine.
    Removing a secret means it stops being hidden - including in older conversations that already used it.
    To set one up ahead of time, use <b>Presets</b>.</p>
  </section>

  <section id="tab-presets" hidden>
    <div class="card">
      <form class="presets-form" id="add-form">
        <label>Name<input type="text" id="add-name" placeholder="staging_db_password" pattern="[a-zA-Z0-9_-]{1,64}" required></label>
        <label>Value<input type="password" id="add-value" placeholder="6+ characters" minlength="6" required autocomplete="off"></label>
        <label class="wide">What is it for?<input type="text" id="add-desc" maxlength="200" placeholder="Postgres password for staging, used by migrations and seed scripts"></label>
        <label class="inline wide"><input type="checkbox" id="add-announce" checked> Tell Claude about it (name and description only, never the value)</label>
        <div class="actions"><button class="act primary" type="submit">Save preset</button></div>
      </form>
    </div>
    <h2>Saved presets</h2>
    <div class="card">
      <table><thead><tr><th>Name</th><th>Description</th><th class="hide-sm">Tell Claude</th><th></th></tr></thead>
      <tbody id="preset-rows"></tbody></table>
    </div>
    <h2>What Claude is told</h2>
    <div class="card"><pre class="preview" id="preset-note"></pre></div>
    <p class="note">With a preset in place you never paste the value: Claude sees the list above and uses the token when a task needs it.
    Descriptions are sent to the model as written, so keep secrets out of them.</p>
  </section>

  <section id="tab-activity" hidden>
    <div class="card"><table><thead><tr><th>When</th><th>What</th><th>Secret</th></tr></thead><tbody id="activity-rows"></tbody></table></div>
  </section>

  <section id="tab-helpers" hidden>
    <div class="card"><table><thead><tr><th>Helper</th><th>Where</th><th class="hide-sm">Started by</th><th>Last active</th></tr></thead><tbody id="helper-rows"></tbody></table></div>
    <p class="note">Claude starts helpers on its own for parallel work and cleans up idle ones. Nothing to manage here.</p>
  </section>

  <section id="tab-settings" hidden>
    <div class="card">
      <div class="setting"><div><b>Catch passwords in context</b><p>Things like <code>DB_PASSWORD=...</code>, <code>user:pass@host</code>, "my password is ..."</p></div><input type="checkbox" id="c-context"></div>
      <div class="setting"><div><b>Catch random-looking strings</b><p>Long mixed-case keys you paste in chat, even in unknown formats.</p></div><input type="checkbox" id="c-entropy"></div>
      <div class="setting"><div><b>Parallel helpers</b><p>Most helpers Claude may run at once without asking.</p></div><input type="number" id="c-max" min="1" max="16"></div>
      <div class="setting"><div><b>Clean up idle helpers after (minutes)</b><p>Only helpers Claude started itself.</p></div><input type="number" id="c-idle" min="5"></div>
      <div class="setting"><div><b>Ask before remote or paid work</b><p>Anything that runs off this machine or costs money.</p></div><input type="checkbox" id="c-ask"></div>
    </div>
    <p class="note">Anything you paste as <code>secret: VALUE</code> is always caught, whatever these say. Changes apply immediately.</p>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = null;

  function api(method, path, body) {
    return fetch('/_lazy/api/' + path, {
      method: method,
      headers: { 'content-type': 'application/json', 'x-lazy': '1' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('on'); setTimeout(function () { t.classList.remove('on'); }, 1800); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'cls') e.className = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function ago(iso) {
    if (!iso) return '-';
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  var ORIGIN = { chat: 'chat', 'tool-output': 'tool output', manual: 'added here' };
  function emptyRow(cols, text) { return el('tr', {}, [el('td', { colspan: cols, cls: 'empty', text: text })]); }

  function renderVault() {
    var body = $('vault-rows'); body.textContent = '';
    if (!state.vault.length) { body.appendChild(emptyRow(5, 'Nothing yet. Paste a key in chat and it lands here.')); return; }
    state.vault.forEach(function (s) {
      var val = el('span', { cls: 'mono', text: s.preview });
      var reveal = el('button', { cls: 'act', type: 'button', text: 'Show', onclick: function () {
        if (reveal.textContent === 'Hide') { val.textContent = s.preview; reveal.textContent = 'Show'; return; }
        api('POST', 'vault/' + s.name + '/reveal').then(function (r) { val.textContent = r.value; reveal.textContent = 'Hide'; });
      } });
      var copy = el('button', { cls: 'act', type: 'button', text: 'Copy token', onclick: function () {
        navigator.clipboard.writeText('{{secure.' + s.name + '}}').then(function () { toast('Copied {{secure.' + s.name + '}}'); });
      } });
      var del = el('button', { cls: 'act danger', type: 'button', text: 'Remove', onclick: function () {
        if (!confirm('Stop hiding "' + s.name + '"? It will be sent to the model as-is if it appears again.')) return;
        api('DELETE', 'vault/' + s.name).then(function () { toast('Removed'); load(); });
      } });
      body.appendChild(el('tr', {}, [
        el('td', {}, [el('code', { text: s.name })]),
        el('td', {}, [val]),
        el('td', { cls: 'hide-sm' }, [el('span', { cls: 'chip', text: ORIGIN[s.origin] || 'earlier' })]),
        el('td', { cls: 'hide-sm', text: ago(s.lastSeen) }),
        el('td', {}, [el('div', { cls: 'row-actions' }, [reveal, copy, del])])
      ]));
    });
  }

  function renderPresets() {
    var body = $('preset-rows');
    $('preset-note').textContent = state.presetNote;
    // Do not rebuild under the cursor: the page refreshes while someone types.
    if (document.activeElement && body.contains(document.activeElement)) return;
    body.textContent = '';
    var rows = state.vault.filter(function (s) { return s.origin === 'manual' || s.description; });
    if (!rows.length) { body.appendChild(emptyRow(4, 'No presets yet. Save one above and Claude can use it without you pasting anything.')); }
    rows.forEach(function (s) {
      var desc = el('input', { type: 'text', cls: 'desc', maxlength: '200', placeholder: 'Add a description so Claude knows when to use it' });
      desc.value = s.description || '';
      desc.addEventListener('change', function () {
        api('PATCH', 'vault/' + s.name, { description: desc.value }).then(function () { toast('Saved'); load(); });
      });
      var tell = el('input', { type: 'checkbox' });
      tell.checked = !!s.announce;
      tell.disabled = !s.description;
      tell.title = s.description ? '' : 'Add a description first';
      tell.addEventListener('change', function () {
        api('PATCH', 'vault/' + s.name, { announce: tell.checked }).then(function () { toast(tell.checked ? 'Claude will be told' : 'Hidden from Claude'); load(); });
      });
      var del = el('button', { cls: 'act danger', type: 'button', text: 'Remove', onclick: function () {
        if (!confirm('Remove "' + s.name + '"? It stops being hidden if it appears again.')) return;
        api('DELETE', 'vault/' + s.name).then(function () { toast('Removed'); load(); });
      } });
      body.appendChild(el('tr', {}, [
        el('td', {}, [el('code', { text: s.name })]),
        el('td', {}, [desc]),
        el('td', { cls: 'hide-sm' }, [tell]),
        el('td', {}, [el('div', { cls: 'row-actions' }, [del])])
      ]));
    });
  }

  function renderActivity() {
    var body = $('activity-rows'); body.textContent = '';
    if (!state.activity.length) { body.appendChild(emptyRow(3, 'Quiet so far.')); return; }
    state.activity.forEach(function (a) {
      var what = a.type === 'caught' ? el('span', { cls: 'caught', text: 'Caught new secret in ' + (ORIGIN[a.origin] || a.origin) })
        : a.type === 'hidden' ? el('span', { cls: 'hidden-ev', text: 'Hidden again' })
        : el('span', { cls: 'error', text: a.message });
      body.appendChild(el('tr', {}, [el('td', { text: ago(a.at) }), el('td', {}, [what]), el('td', {}, [a.name ? el('code', { text: a.name }) : null])]));
    });
  }

  function renderHelpers() {
    var body = $('helper-rows'); body.textContent = '';
    if (!state.helpers.length) { body.appendChild(emptyRow(4, 'No helpers running. Claude starts them when work can run in parallel.')); return; }
    state.helpers.forEach(function (h) {
      body.appendChild(el('tr', {}, [el('td', { text: h.name }), el('td', { text: h.where }), el('td', { cls: 'hide-sm', text: h.automatic ? 'Claude' : 'you' }), el('td', { text: ago(h.lastUsed) })]));
    });
  }

  var settingsBound = false;
  function renderSettings() {
    var c = state.config;
    $('c-context').checked = c.detection.context;
    $('c-entropy').checked = c.detection.entropy;
    $('c-max').value = c.helpers.maxParallel;
    $('c-idle').value = c.helpers.idleMinutes;
    $('c-ask').checked = c.helpers.askBeforeRemote;
    if (settingsBound) return;
    settingsBound = true;
    function save(patch) { api('POST', 'config', patch).then(function () { toast('Saved'); load(); }).catch(function (e) { toast(e.message); }); }
    $('c-context').onchange = function (e) { save({ detection: { context: e.target.checked } }); };
    $('c-entropy').onchange = function (e) { save({ detection: { entropy: e.target.checked } }); };
    $('c-ask').onchange = function (e) { save({ helpers: { askBeforeRemote: e.target.checked } }); };
    $('c-max').onchange = function (e) { save({ helpers: { maxParallel: parseInt(e.target.value, 10) } }); };
    $('c-idle').onchange = function (e) { save({ helpers: { idleMinutes: parseInt(e.target.value, 10) } }); };
  }

  function load() {
    return api('GET', 'state').then(function (s) {
      state = s;
      $('s-vault').textContent = s.vault.length;
      $('s-caught').textContent = s.totals.caught;
      $('s-hidden').textContent = s.totals.hidden;
      $('s-helpers').textContent = s.helpers.length;
      $('up').textContent = 'running since ' + ago(s.startedAt).replace(' ago', '') + (s.startedAt && ago(s.startedAt) !== 'just now' ? ' ago' : '');
      renderVault(); renderPresets(); renderActivity(); renderHelpers(); renderSettings();
    }).catch(function () { $('up').textContent = 'not reachable'; });
  }

  function showTab(name) {
    var found = false;
    document.querySelectorAll('nav button').forEach(function (x) {
      var on = x.dataset.tab === name;
      found = found || on;
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!found) return;
    document.querySelectorAll('main > section').forEach(function (s) { s.hidden = s.id !== 'tab-' + name; });
  }
  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); history.replaceState(null, '', '#' + b.dataset.tab); });
  });
  // Tabs are linkable: /_lazy/#presets
  if (location.hash) showTab(location.hash.slice(1));
  $('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    api('POST', 'vault', { name: $('add-name').value.trim(), value: $('add-value').value, description: $('add-desc').value, announce: $('add-announce').checked })
      .then(function () { $('add-name').value = ''; $('add-value').value = ''; $('add-desc').value = ''; toast('Preset saved'); load(); })
      .catch(function (err) { toast(err.message); });
  });
  load();
  setInterval(load, 4000);
})();
</script>
</body>
</html>
`;
