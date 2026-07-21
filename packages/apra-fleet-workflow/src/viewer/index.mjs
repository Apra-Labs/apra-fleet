import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { escapeHtml } from './html-utils.mjs';
import { DebouncedStateWriter, DEFAULT_DEBOUNCE_MS, writeJsonFileAtomic } from './debounced-writer.mjs';
import { getRunningSprintStatePath, getOldSprintStatePath } from './sprint-state-paths.mjs';
import { buildListStatePayload, resolveStringRefs } from './lean-state.mjs';
import { capCommandActivityMeta, getFullOutput } from './command-output-cap.mjs';

// apra-fleet-eft.6.5: the SAME template serves both the live view and the
// process-free History view -- `opts.history` (true) feeds a FROZEN state
// object directly into the page instead of the live view's
// fetch('/state') + EventSource('/events') polling loop, and hides the Save
// / Stop controls (there is no live workflow left to save/stop, and nothing
// to stream: a finished sprint's child process, and therefore those
// endpoints, no longer exists). `opts.state` is embedded as a JSON literal;
// any literal `</script>`-like sequence inside it is escaped so it can never
// terminate the embedding <script> tag early.
const HTML_TEMPLATE = (dashboardExtensions, opts = {}) => {
    const isHistory = !!opts.history;
    const frozenStateLiteral = isHistory
        ? JSON.stringify(opts.state ?? null).replace(/</g, '\\u003c')
        : 'null';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Workflow Dashboard</title>
  <style>
    :root {
      --bg: #09090b; --bg-glass: rgba(24, 24, 27, 0.6); --border: rgba(255, 255, 255, 0.1);
      --text: #e4e4e7; --text-muted: #a1a1aa; --accent: #3b82f6; --accent-glow: rgba(59, 130, 246, 0.2);
      --success: #10b981; --warning: #f59e0b; --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: sans-serif; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    .header { flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: var(--bg-glass); border-bottom: 1px solid var(--border); }
    .header h1 { font-size: 16px; font-weight: 600; margin: 0; }
    .header-actions { display: flex; gap: 12px; align-items: center; }
    
    .stats-banner { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); background: rgba(0,0,0,0.3); padding: 4px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); }
    .stats-banner span strong { color: var(--text); font-weight: 600; }
    .stats-banner span strong.spent { color: var(--success); }
    
    .btn { padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.8; }
    .btn-save { background: var(--accent); color: #fff; }
    .btn-stop { background: var(--danger); color: #fff; }
    .btn-secondary { background: rgba(255,255,255,0.1); color: var(--text); }
    
    /* min-height: 0 on every rung of the flex chain: a flex item's default
       min-height is content-sized, which lets a tall Activity list push the
       panel past its parent instead of the inner .stream-list scrolling.
       overflow: hidden alone is not reliable across the nested flex levels
       here -- without the explicit 0, large sprints ended up with a clipped,
       unscrollable activity widget. */
    .main-content { display: flex; flex: 1; overflow: hidden; min-height: 0; }

    .content-area { flex: 1; padding: 20px; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .panel { background: var(--bg-glass); border: 1px solid var(--border); border-radius: 6px; display: flex; flex-direction: column; flex: 1; overflow: hidden; min-height: 0; }
    .panel-header { flex-shrink: 0; padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); text-transform: uppercase; letter-spacing: 0.5px; }
    
    .stream-list { flex: 1; min-height: 0; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; background: #000; }
    
    /* Tree Group */
    .tree-group { background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .group-header { padding: 12px 16px; background: rgba(0,0,0,0.4); cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; outline: none; list-style: none; }
    .group-header h3 { font-size: 14px; font-weight: 700; color: var(--accent); margin: 0; }
    .group-header:hover { background: rgba(0,0,0,0.6); }
    .group-header::-webkit-details-marker { display: none; }
    .group-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }

    /* Tree Phase */
    .tree-phase { background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; overflow: hidden; }
    .phase-header { padding: 8px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; border-bottom: 1px solid rgba(255,255,255,0.02); outline: none; list-style: none; }
    .phase-header h4 { font-size: 13px; font-weight: 600; color: #e4e4e7; margin: 0; }
    .phase-header:hover { background: rgba(255,255,255,0.05); }
    .phase-header::-webkit-details-marker { display: none; }
    .phase-body { padding: 8px; display: flex; flex-direction: column; gap: 4px; }
    
    .event-log { display: flex; gap: 8px; font-family: monospace; font-size: 12px; color: #d4d4d8; padding: 2px 4px; border-radius: 4px; }
    .event-log:hover { background: rgba(255,255,255,0.05); }
    .log-time { color: #52525b; width: 60px; flex-shrink: 0; user-select: none; }
    .log-msg { white-space: pre-wrap; word-break: break-word; }
    
    details.event-activity { border: 1px solid rgba(255,255,255,0.05); border-radius: 4px; background: rgba(255,255,255,0.02); font-family: monospace; margin: 2px 0; }
    details.event-activity.log-multiline { border-color: rgba(255,255,255,0.02); background: transparent; }
    details.event-activity.log-multiline summary { padding: 4px 8px; }
    
    summary.activity-header { display: flex; align-items: center; padding: 6px 8px; font-size: 12px; gap: 8px; cursor: pointer; user-select: none; list-style: none; outline: none; }
    summary.activity-header::-webkit-details-marker { display: none; }
    summary.activity-header:hover { background: rgba(255,255,255,0.04); }
    
    .activity-title { flex: 1; color: #e4e4e7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .activity-title .muted { color: #a1a1aa; font-weight: normal; font-size: 11px; margin-left: 6px; }
    .activity-meta { display: flex; gap: 12px; align-items: center; font-size: 11px; color: #a1a1aa; flex-shrink: 0; }
    
    .toggle-icon { margin-left: 8px; font-family: monospace; font-size: 14px; color: var(--text-muted); width: 14px; text-align: center; }
    details:not([open]) > summary .toggle-icon::after { content: "+"; }
    details[open] > summary .toggle-icon::after { content: "-"; }
    
    .activity-body { padding: 0; background: #050505; border-top: 1px solid rgba(255,255,255,0.05); }
    .activity-child { padding: 12px; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; }
    .activity-child.output { color: #a1a1aa; border-left: 2px solid var(--accent); }
    .activity-child.error { background: rgba(239, 68, 68, 0.05); color: var(--danger); border-left: 2px solid var(--danger); }

    /* apra-fleet-eft.38: on-demand full-output button for a capped command
       activity (GET /activities/:id/output, wired up in eft.27.4 but never
       surfaced client-side until now). Deliberately its own small element,
       never the activity's summary/header -- headers/titles stay a plain
       expand/collapse toggle only. */
    .more-btn { margin-left: 8px; padding: 1px 8px; font-size: 11px; font-family: sans-serif; border-radius: 4px; border: 1px solid var(--border); background: rgba(255,255,255,0.06); color: var(--accent); cursor: pointer; }
    .more-btn:hover { background: rgba(255,255,255,0.12); }
    .more-btn:disabled { cursor: default; opacity: 0.6; }

    .status-badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .status-running { background: var(--accent-glow); color: var(--accent); animation: pulse 2s infinite; }
    .status-success { background: rgba(16, 185, 129, 0.1); color: var(--success); }
    .status-error { background: rgba(239, 68, 68, 0.1); color: var(--danger); }
    .status-offline { background: rgba(239, 68, 68, 0.1); color: var(--danger); }
    
    .status-live-indicator { display: inline-flex; align-items: center; gap: 6px; color: var(--success); font-weight: 700; letter-spacing: 0.5px; }
    .led { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 8px var(--success); animation: pulse 2s infinite; }
    
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.6; } 100% { opacity: 1; } }
    
    .tab-bar { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; }
    .tab-btn { background: transparent; color: #a1a1aa; border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 13px; }
    .tab-btn:hover { background: rgba(255,255,255,0.05); }
    .tab-btn.active { color: #fff; background: rgba(255,255,255,0.1); }
    .tab-content { display: none; }
    /* apra-fleet-m0c: both #tab-core and #tab-beads also carry .panel
       (flex column, flex:1, overflow:hidden), which is what lets
       .stream-list's flex:1 + overflow-y:auto bound its height and scroll
       on its own. A plain block display here had higher specificity
       (.tab-content.active = 2 classes vs .panel = 1) and silently
       overrode that to a plain block, so the whole page grew to fit every
       activity instead of the inner list scrolling -- collapsing items was
       the only way to shrink total height. Flex here still wins on
       specificity but no longer conflicts with .panel's own flex layout. */
    .tab-content.active { display: flex; min-height: 0; }
  </style>
</head>
<body data-view="${isHistory ? 'history' : 'live'}">
  <div class="header">
    <h1><span id="workflow-name">Loading...</span></h1>
    <div class="header-actions">
      <div class="stats-banner" id="stats-banner"></div>
      <div id="status-indicator" style="font-size: 12px; font-weight: 600; min-width: 70px; text-align: center;"></div>
      ${isHistory ? '' : '<button class="btn btn-save" onclick="saveState()">Save</button>'}
      ${isHistory ? '' : '<button class="btn btn-stop" onclick="stopWorkflow()">Stop</button>'}
    </div>
  </div>
  <div class="main-content">
    <div class="content-area">
      <div class="tab-bar" id="tab-bar">
        <button class="tab-btn active" onclick="switchTab('core')">Activity Tree</button>
        ${dashboardExtensions.map(ext => `<button class="tab-btn" onclick="switchTab('${ext.id}')">${ext.title}</button>`).join('\\n')}
      </div>
      <div id="tab-core" class="tab-content active panel">
        <div class="panel-header" style="display: flex; justify-content: space-between; align-items: center;">
          <span>Activity</span>
          <button id="btn-toggle-all" onclick="toggleAllGlobal()" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-family: monospace; font-size: 14px; font-weight: bold; transition: color 0.2s;">[+]</button>
        </div>
        <div class="stream-list" id="stream-list"></div>
      </div>
      ${dashboardExtensions.map(ext => `
        <div id="tab-${ext.id}" class="tab-content panel">
          <div class="panel-header">${ext.title}</div>
          <div id="extension-${ext.id}" style="flex: 1; min-height: 0; padding: 12px; overflow-y: auto;"></div>
        </div>
      `).join('\\n')}
    </div>
  </div>
  ${dashboardExtensions.map(ext => `<script>\n${ext.js}\n</script>`).join('\\n')}
  <script>
    let globalState = null;
    function switchTab(id) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      event.currentTarget.classList.add('active');
      document.getElementById('tab-' + id).classList.add('active');
    }
    
    function formatTime(ms) {
      if (!ms) return '-';
      return (ms / 1000).toFixed(1) + 's';
    }
    
    function formatUptime(ms) {
      if (!ms || ms < 0) return '0s';
      let secs = Math.floor(ms / 1000);
      let mins = Math.floor(secs / 60);
      let hrs = Math.floor(mins / 60);
      secs = secs % 60;
      mins = mins % 60;
      
      let out = [];
      if (hrs > 0) out.push(hrs + 'hr');
      if (mins > 0) out.push(mins + 'm');
      out.push(secs + 's');
      return out.join(' ');
    }
    
    // Shared with dashboard extensions -- see src/viewer/html-utils.mjs for
    // why this is embedded via escapeHtml.toString() instead of duplicated.
    ${escapeHtml.toString()}

    // apra-fleet-eft.27.1: GET /state's lean list-state payload dedupes
    // repeated strings into a shared \`_strings\` table (see
    // src/viewer/lean-state.mjs) -- this is that module's resolveStringRefs()
    // embedded verbatim (same .toString() pattern as escapeHtml above) so the
    // browser can undo the same transform before rendering. Safe to run on
    // ANY state object, including a History view's frozen literal that never
    // went through dedupeStrings(): with no \`{ $ref }\` markers present it's a
    // no-op pass-through.
    ${resolveStringRefs.toString()}

    function saveState() {
      if (!globalState) return;
      const blob = new Blob([JSON.stringify(globalState, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'workflow-state.json';
      a.click();
    }
    
    async function stopWorkflow() {
      if (confirm('Are you sure you want to forcibly stop the workflow?')) {
        await fetch('/stop', { method: 'POST' });
        alert('Stop signal sent.');
      }
    }

    let allExpanded = true;
    function toggleAllGlobal() {
      allExpanded = !allExpanded;
      document.querySelectorAll('details').forEach(d => {
        if (allExpanded) d.setAttribute('open', '');
        else d.removeAttribute('open');
      });
      const btn = document.getElementById('btn-toggle-all');
      btn.textContent = allExpanded ? '[-]' : '[+]';
      btn.style.color = allExpanded ? 'var(--text)' : 'var(--text-muted)';
    }

    let isAutoScrolling = true;
    const streamEl = document.getElementById('stream-list');
    
    streamEl.addEventListener('scroll', () => {
      isAutoScrolling = (streamEl.scrollTop + streamEl.clientHeight >= streamEl.scrollHeight - 30);
    });

    // apra-fleet-eft.38: on-demand full-output fetch for a capped command
    // activity's 'more...' button (see fieldBlock() above). Delegated on
    // streamEl (not one listener per button) since renderTreeIncremental()
    // keeps appending new activity elements as the sprint progresses.
    // Deliberately scoped to .more-btn clicks only -- never the activity's
    // own <summary> header, which keeps its native <details> expand/collapse
    // behavior untouched.
    let expandedMoreBtn = null;
    function collapseMoreBtn(btn) {
        if (!btn) return;
        const span = btn.previousElementSibling;
        if (span && span.dataset.truncatedText !== undefined) {
            span.textContent = span.dataset.truncatedText;
        }
        btn.dataset.state = '';
        btn.disabled = false;
        btn.textContent = btn.dataset.label || 'more...';
        if (expandedMoreBtn === btn) expandedMoreBtn = null;
    }
    streamEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('.more-btn');
        if (!btn) return;
        const span = btn.previousElementSibling;
        if (!span) return;

        if (btn.dataset.state === 'expanded') {
            // Toggle back to the capped preview -- no re-fetch needed.
            collapseMoreBtn(btn);
            return;
        }
        if (btn.dataset.state === 'loading') return;

        // apra-fleet-eft.38: only ONE activity's full output is ever held
        // expanded in the DOM at a time. Fetched command output can run to
        // many MB, and keeping several fully expanded simultaneously is
        // exactly the kind of unbounded-DOM growth apra-fleet-eft.27/27.4
        // already fixed for the initial render -- a new 'more...' click
        // collapses whichever block was previously expanded back to its
        // capped preview first.
        if (expandedMoreBtn && expandedMoreBtn !== btn) {
            collapseMoreBtn(expandedMoreBtn);
        }

        if (span.dataset.truncatedText === undefined) {
            span.dataset.truncatedText = span.textContent;
        }
        const activityId = btn.dataset.activityId;
        const field = btn.dataset.field;
        btn.dataset.state = 'loading';
        btn.disabled = true;
        btn.textContent = 'loading...';
        try {
            const res = await fetch('/activities/' + encodeURIComponent(activityId) + '/output');
            if (!res.ok) throw new Error('request failed: ' + res.status);
            const data = await res.json();
            const full = data[field];
            if (typeof full !== 'string') throw new Error('missing ' + field + ' in response');
            span.textContent = full;
            btn.dataset.state = 'expanded';
            btn.disabled = false;
            btn.textContent = 'less';
            expandedMoreBtn = btn;
        } catch (err) {
            btn.dataset.state = '';
            btn.disabled = false;
            btn.textContent = 'failed to load (retry?)';
        }
    });

    ${isHistory ? '' : `
    // Coalesce SSE-triggered refreshes: a busy sprint broadcasts one event
    // per log line / activity tick, and refetching + re-rendering the full
    // (potentially multi-MB) /state payload for each of them is what made
    // large sprints sluggish. One trailing refresh per window is enough --
    // renderState() always paints the latest snapshot, not a delta.
    const POLL_COALESCE_MS = 400;
    let pollTimer = null;
    function schedulePoll() {
        if (pollTimer) return;
        pollTimer = setTimeout(() => { pollTimer = null; poll(); }, POLL_COALESCE_MS);
    }
    const source = new EventSource('/events');
    source.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'state') {
            const extEvent = new CustomEvent('workflow:state:' + ev.payload.namespace, { detail: ev.payload.data });
            document.dispatchEvent(extEvent);
        }
        schedulePoll();
    };
    `}

    function renderTreeIncremental(tree) {
        tree.forEach((group, gIdx) => {
            let groupEl = document.getElementById('group-' + gIdx);
            if (!groupEl) {
                groupEl = document.createElement('details');
                groupEl.id = 'group-' + gIdx;
                groupEl.className = 'tree-group';
                groupEl.open = true;
                groupEl.innerHTML = \`<summary class="group-header"><h3>\${escapeHtml(group.title)}</h3><span class="toggle-icon"></span></summary><div class="group-body"></div>\`;
                streamEl.appendChild(groupEl);
            }
            const groupBody = groupEl.querySelector('.group-body');
            
            group.phases.forEach((phase, pIdx) => {
                const phaseId = \`phase-\${gIdx}-\${pIdx}\`;
                let phaseEl = document.getElementById(phaseId);
                if (!phaseEl) {
                    phaseEl = document.createElement('details');
                    phaseEl.id = phaseId;
                    phaseEl.className = 'tree-phase';
                    phaseEl.open = true;
                    phaseEl.innerHTML = \`<summary class="phase-header"><h4>\${escapeHtml(phase.title)}</h4><span class="toggle-icon"></span></summary><div class="phase-body"></div>\`;
                    groupBody.appendChild(phaseEl);
                }
                const phaseBody = phaseEl.querySelector('.phase-body');
                
                phase.events.forEach((ev, eIdx) => {
                    const evId = \`ev-\${gIdx}-\${pIdx}-\${eIdx}\`;
                    let evEl = document.getElementById(evId);
                    
                    if (ev.type === 'log') {
                        if (!evEl) {
                            evEl = document.createElement('div');
                            evEl.id = evId;
                            const dateObj = new Date(ev.time || Date.now());
                            const t = isNaN(dateObj.getTime()) ? '-' : dateObj.toLocaleTimeString([], { hour12: false });
                            
                            // apra-fleet-aqq: a log message needs truncation
                            // + drill-down whenever it would run past one row
                            // -- not just multiline ones. A single-line
                            // JSON.stringify'd verdict (e.g. the Plan
                            // Reviewer's) has no '\\n' at all but can easily
                            // run past a thousand characters, and used to
                            // render via the plain .log-msg path below, which
                            // has no length cap and just wraps across many
                            // rows with the full text always visible inline
                            // (no truncation, but also nothing to "drill
                            // into" -- it was simply always fully expanded).
                            // Both cases now share the same truncate-with-
                            // ellipsis + expandable-details treatment; only
                            // how the preview/full-text split is computed
                            // differs (by line vs. by character count).
                            const LOG_PREVIEW_CHARS = 200;
                            const isMultiline = ev.msg && ev.msg.includes('\\n');
                            const isLongSingleLine = ev.msg && !isMultiline && ev.msg.length > LOG_PREVIEW_CHARS;
                            if (isMultiline || isLongSingleLine) {
                                let firstLine, rest;
                                if (isMultiline) {
                                    const lines = ev.msg.split('\\n');
                                    firstLine = lines[0];
                                    rest = lines.slice(1).join('\\n');
                                } else {
                                    firstLine = ev.msg.slice(0, LOG_PREVIEW_CHARS);
                                    rest = ev.msg.slice(LOG_PREVIEW_CHARS);
                                }
                                evEl.innerHTML = \`<details class="event-activity log-multiline">
                                  <summary class="activity-header">
                                    <span class="log-time">\${t}</span>
                                    <span class="activity-title" style="font-family:monospace; font-size:12px; color:#d4d4d8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                      \${escapeHtml(firstLine)} <em style="color:#a1a1aa">...</em>
                                    </span>
                                    <div class="activity-meta"><span class="toggle-icon"></span></div>
                                  </summary>
                                  <div class="activity-body">
                                    <div class="activity-child" style="color:#d4d4d8;">\${escapeHtml(isMultiline ? rest : ev.msg)}</div>
                                  </div>
                                </details>\`;
                            } else {
                                evEl.className = 'event-log';
                                evEl.innerHTML = \`<span class="log-time">\${t}</span><span class="log-msg">\${escapeHtml(ev.msg)}</span>\`;
                            }
                            phaseBody.appendChild(evEl);
                        }
                    } else if (ev.type === 'activity') {
                        const act = ev.data;
                        if (!evEl) {
                            evEl = document.createElement('details');
                            evEl.id = evId;
                            evEl.className = 'event-activity';
                            if (act.isRunning) {
                                evEl.open = true;
                            }
                            phaseBody.appendChild(evEl);
                        }

                        // A finished activity's data never changes again
                        // (activity:end merges its meta exactly once), so
                        // re-render it exactly once. Rewriting every
                        // activity's innerHTML on every tick -- thousands of
                        // DOM subtrees, some holding megabyte agent outputs
                        // -- is the other half of what made large sprints
                        // sluggish, and the constant churn also fought the
                        // user's own scrolling and text selection.
                        if (evEl.dataset.rendered === 'done') return;

                        // Update contents every tick to catch status changes
                        const dateObj = new Date(act.startTime || Date.now());
                        const t = isNaN(dateObj.getTime()) ? '-' : dateObj.toLocaleTimeString([], { hour12: false });
                        
                        let badge = '';
                        if (act.isRunning) badge = '<span class="status-badge status-running">Running</span>';
                        else if (act.success) badge = '<span class="status-badge status-success">Success</span>';
                        else badge = '<span class="status-badge status-error">Failed</span>';
                        
                        let childrenHtml = '';
                        if (!act.isRunning) {
                            // apra-fleet-eft.38: a \`command\` activity's stored
                            // output/error may only be a head+tail excerpt --
                            // command-output-cap.mjs (eft.27.4) capped it
                            // before it ever reached state.tree, marking which
                            // field via \${field}Truncated + the TRUE original
                            // \${field}ByteLength. fieldBlock() wraps that
                            // field's escaped text in a span the click handler
                            // below can find and swap for the full text (GET
                            // /activities/:id/output), and appends a dedicated
                            // 'more...' button right next to it -- never on
                            // the activity's own summary/header, which stays a
                            // plain expand/collapse toggle only.
                            const fieldBlock = (prefix, text, field) => {
                                const truncated = act[field + 'Truncated'];
                                const bytes = act[field + 'ByteLength'];
                                const label = truncated
                                    ? \`more... (\${(bytes || 0).toLocaleString()} bytes total)\`
                                    : '';
                                const btn = truncated
                                    ? \` <button type="button" class="more-btn" data-activity-id="\${escapeHtml(String(act.id))}" data-field="\${field}" data-label="\${escapeHtml(label)}">\${escapeHtml(label)}</button>\`
                                    : '';
                                return \`\${prefix}<span class="output-text" data-field="\${field}">\${escapeHtml(text)}</span>\${btn}\`;
                            };
                            if (act.error) {
                                childrenHtml = \`<div class="activity-child error">\${fieldBlock('', act.error, 'error')}\\n\\n\${act.input ? 'Input:\\n' + escapeHtml(act.input) + '\\n\\n' : ''}\${act.output ? fieldBlock('Output:\\n', act.output, 'output') : ''}</div>\`;
                            } else if (act.output) {
                                childrenHtml = \`<div class="activity-child output">\${act.input && act.type === 'transform' ? 'Input:\\n' + escapeHtml(act.input) + '\\n\\nOutput:\\n' : ''}\${fieldBlock('', act.output, 'output')}</div>\`;
                            }
                        }
                        
                        // Token count and model tier are two DISTINCT pieces of
                        // information -- previously only tokensHtml existed,
                        // so a finished agent activity with no usage data (see
                        // apra-fleet-13o) rendered a bare "n/a" that was easy
                        // to misread as a missing model tier, when the model
                        // tier was never displayed at all. modelHtml surfaces
                        // act.model (e.g. "premium"/"standard", already
                        // present on every agent activity) explicitly.
                        let tokensHtml = act.usage ? \`<span style="color:var(--text-muted)">\${act.usage.total_tokens.toLocaleString()} tkns</span>\` : (act.type === 'agent' && !act.isRunning ? \`<span style="color:var(--text-muted)">n/a</span>\` : '');
                        const modelHtml = (act.type === 'agent' && act.model) ? \`<span style="color:var(--text-muted)">[\${escapeHtml(act.model)}]</span>\` : '';
                        const memberDisplay = act.member ? escapeHtml(act.member) : (act.type === 'transform' ? 'js' : '');
                        const memberHtml = memberDisplay ? \`<span class="muted">(\${memberDisplay})</span>\` : '';

                        evEl.innerHTML = \`
                          <summary class="activity-header">
                            <span class="log-time">\${t}</span>
                            <span class="activity-title"><strong>\${escapeHtml(act.type.toUpperCase())}</strong>: \${escapeHtml(act.label)} \${memberHtml}</span>
                            <div class="activity-meta">
                              \${modelHtml}
                              \${tokensHtml}
                              \${act.duration ? formatTime(act.duration) : ''} \${badge}
                              <span class="toggle-icon"></span>
                            </div>
                          </summary>
                          \${childrenHtml ? \`<div class="activity-body">\${childrenHtml}</div>\` : ''}
                        \`;
                        if (!act.isRunning) evEl.dataset.rendered = 'done';
                    }
                });
            });
        });
    }

    // apra-fleet-eft.6.5: the DOM-update half of what used to be poll()'s try
    // block, factored out so the History view can feed it a FROZEN state
    // object directly (see the bottom of this script) without ever calling
    // fetch('/state') itself -- poll() (live view only) still drives it from
    // the network.
    function renderState(state) {
        globalState = state;

        document.getElementById('workflow-name').textContent = state.workflowName;

        const ind = document.getElementById('status-indicator');
        if (state.status === 'running') { ind.innerHTML = '<div class="status-live-indicator"><div class="led"></div> LIVE</div>'; }
        else if (state.status === 'success') { ind.innerHTML = '<span style="color:var(--success)">DONE</span>'; }
        else if (state.status === 'cancelled') { ind.innerHTML = '<span style="color:var(--warning)">CANCELLED</span>'; }
        else { ind.innerHTML = '<span style="color:var(--danger)">FAILED</span>'; }

        const dur = state.status === 'running' ? Date.now() - state.stats.startTime : state.stats.durationMs;
        const unknownCostSuffix = state.stats.unknownCostCount > 0 ? \` <span style="color:var(--warning)">(+\${state.stats.unknownCostCount} unknown)</span>\` : '';
        document.getElementById('stats-banner').innerHTML =
          \`<span><strong>\${state.stats.activitiesCount}</strong> Activities</span>
           <span><strong class="spent">$\${state.stats.totalCost.toFixed(3)}</strong> Spent\${unknownCostSuffix}</span>
           <span><strong>\${state.stats.totalTokens.toLocaleString()}</strong> Tokens</span>
           <span><strong>\${formatUptime(dur)}</strong> Uptime</span>\`;

        renderTreeIncremental(state.tree);

        if (state.extensions) {
            for (const [ns, data] of Object.entries(state.extensions)) {
                const extEvent = new CustomEvent('workflow:state:' + ns, { detail: data });
                document.dispatchEvent(extEvent);
            }
        }

        if (isAutoScrolling) {
          streamEl.scrollTop = streamEl.scrollHeight;
        }
    }

    async function poll() {
      try {
        const res = await fetch('/state?_t=' + Date.now(), { cache: 'no-store' });
        const raw = await res.json();
        // apra-fleet-eft.27.1: undo the server's string-table dedup before
        // handing the state to renderState()/renderTreeIncremental(), which
        // both expect plain, already-resolved strings.
        const state = resolveStringRefs(raw, raw._strings || []);
        renderState(state);
      } catch(e) {
          console.error("Poll Error:", e);
          if (globalState && (globalState.status === 'success' || globalState.status === 'failed' || globalState.status === 'cancelled')) {
              // already done, ignore
          } else {
              document.getElementById('status-indicator').innerHTML = '<span class="status-badge status-offline">OFFLINE</span>';
          }
      }
    }

    ${isHistory
        ? `// History view: render the frozen state ONCE, directly -- no
    // fetch('/state') and no EventSource('/events') (asserted: zero polling
    // requests for a finished sprint with zero running processes).
    renderState(${frozenStateLiteral});`
        : 'poll();'}
  </script>
</body>
</html>`;
};

// apra-fleet-eft.27.2: on-demand bead-description lookup for GET
// /beads/:id/description (see the route below). GET /state's lean list-state
// payload (apra-fleet-eft.27.1, src/viewer/lean-state.mjs) strips every
// bead's full `description` down to a short `summary` so the recurring poll
// payload stays small -- this is the client's ONLY way to recover the full
// text, and it must read it from the LIVE, full-fidelity `state.extensions`
// object (never leaned), not from any /state response. Deliberately the one
// place in this file that knows the 'beads' extension's shape (sprintTasks/
// backlogTasks, both arrays of { id, description, updated_at, ... }) --
// everything else here (and all of lean-state.mjs) stays extension-agnostic.
function findBeadById(state, id) {
    const beadsExt = state.extensions && state.extensions.beads;
    if (!beadsExt) return null;
    const pools = [beadsExt.sprintTasks, beadsExt.backlogTasks];
    for (const pool of pools) {
        if (!Array.isArray(pool)) continue;
        const match = pool.find((t) => t && String(t.id) === String(id));
        if (match) return match;
    }
    return null;
}

// apra-fleet-eft.6.5: exported so the supervisor's process-free History view
// (packages/apra-fleet-se/src/supervisor/history-view.mjs) can render a
// finished sprint's persisted terminal state through the SAME template the
// live viewer serves, fed a frozen state object (opts.history / opts.state)
// instead of standing up a whole createDashboardViewer() (which owns a live
// http.createServer + workflow event wiring this read-only view has no use
// for).
export { HTML_TEMPLATE };

export function createDashboardViewer(workflow, opts = {}) {
    const port = (typeof opts.port === 'number') ? opts.port : 8080;
    const dashboardExtensions = opts.dashboardExtensions || [];

    // apra-fleet-eft.2.3: stable per-sprint id, NOT an HHMMSS-style clock
    // key (see sprint-state-paths.mjs) -- this is what running/<id>.json /
    // old_sprints/<id>.json are keyed by, so two sprints started in the same
    // second on different days never collide. Callers that already know a
    // meaningful id (e.g. the auto-sprint runner's own runId) can pass
    // opts.sprintId; otherwise one is generated here.
    const env = opts.env || process.env;
    const sprintId = opts.sprintId || randomUUID();

    // apra-fleet-eft.2.3: the debounced writer's target defaults to
    // <serviceDataDir>/running/<sprintId>.json (outside the repo checkout --
    // see getFleetDataDir()/APRA_FLEET_DATA_DIR), NOT sprint-logs/. Only when
    // a caller passes an explicit opts.debouncedStatePath (tests, or a
    // future caller with its own layout) do we skip the running/->
    // old_sprints/ move-on-completion below, since we can no longer assume
    // that path lives under a running/ directory we're allowed to rename out
    // of.
    const usingDefaultStatePath = !opts.debouncedStatePath;
    const runningStatePath = opts.debouncedStatePath || getRunningSprintStatePath(sprintId, env);

    const nowIso = () => new Date().toISOString();
    const startedAtIso = nowIso();

    const state = {
        workflowName: opts.name || 'Apra Fleet Workflow',
        status: 'running',
        // apra-fleet-eft.2.2: fields enriching the persisted state file
        // beyond the terminal-only sprint-logs/ snapshot -- populated (where
        // known) from construction, and updated as the sprint progresses so
        // a mid-sprint read of the file shows in-progress state, not just
        // the terminal shape.
        sprintId,
        args: opts.launchArgs ?? null,
        verdict: null,
        prUrl: null,
        terminalReason: null,
        startedAt: startedAtIso,
        updatedAt: startedAtIso,
        endedAt: null,
        stats: {
            activitiesCount: 0,
            totalTokens: 0,
            totalCost: 0,
            // apra-fleet-unw.4: count of completed activities whose usage/
            // cost could not be determined (fleet result lacked usage, or
            // calculateCost() couldn't price the model). These are excluded
            // from totalCost/totalTokens rather than fabricated.
            unknownCostCount: 0,
            startTime: Date.now(),
            durationMs: 0
        },
        tree: [],
        extensions: {}
    };

    // Note: group/phase tracking is single-run by design (single-tenant usage).
    let currentGroup = { title: 'Workflow', phases: [] };
    let currentPhase = { title: 'Initialization', events: [] };
    currentGroup.phases.push(currentPhase);
    state.tree.push(currentGroup);

    const clients = new Set();
    const broadcast = (data) => {
        const msg = `data: ${JSON.stringify(data)}\n\n`;
        clients.forEach(c => c.write(msg));
        // apra-fleet-eft.2.2: every event that already drives the SSE
        // broadcast (group:start, phase, activity:start/end, log, state)
        // also schedules a debounced state write and bumps updatedAt, so a
        // mid-sprint read of the persisted file reflects in-progress state
        // rather than only the terminal snapshot.
        state.updatedAt = nowIso();
        debouncedWriter.schedule();
    };

    // apra-fleet-eft.2.1/2.3: debounced writer, additive to persistState()
    // above -- that write-once-on-end path (sprint-logs/sprint_HHMMSS.json)
    // stays exactly as-is as the child crash-safety net. This one coalesces
    // bursts of rapid state changes into a single write per debounce window
    // (default DEFAULT_DEBOUNCE_MS, configurable via
    // opts.debounceMs, must be within 200-500ms), is flushed synchronously
    // on every exit path below, and (apra-fleet-eft.2.3) targets
    // running/<sprintId>.json under the service data directory by default --
    // never the repo checkout.
    const debouncedWriter = new DebouncedStateWriter({
        getState: () => state,
        filePath: runningStatePath,
        debounceMs: opts.debounceMs || DEFAULT_DEBOUNCE_MS
    });

    // apra-fleet-eft.27.4: configurable head/tail cap applied to a `command`
    // activity's captured output/error BEFORE it's ever stored into
    // state.tree (command-output-cap.mjs) -- undefined fields fall back to
    // that module's own defaults.
    const commandOutputCapOpts = {
        headChars: opts.commandOutputHeadChars,
        tailChars: opts.commandOutputTailChars
    };

    // apra-fleet-eft.2.3: on terminal completion, move (not copy) the live
    // running/<sprintId>.json to old_sprints/<sprintId>.json so "is this
    // sprint live" is a directory-membership check, never a stale field on
    // the state object itself. Only applies to the default path layout --
    // see usingDefaultStatePath above.
    function moveStateToOldSprints() {
        if (!usingDefaultStatePath) return;
        try {
            if (!fs.existsSync(runningStatePath)) return;
            const oldPath = getOldSprintStatePath(sprintId, env);
            fs.mkdirSync(path.dirname(oldPath), { recursive: true });
            fs.renameSync(runningStatePath, oldPath);
        } catch (e) {
            // Must never crash or block the sprint's own normal exit
            // behavior -- log and move on, same contract as persistState()
            // and the debounced writer itself.
            console.warn(`[Viewer] Warning: failed to move sprint state to old_sprints/: ${e.message}`);
        }
    }

    // Server-side persistence of the dashboard `state` object to
    // sprint-logs/sprint_<HHMMSS>.json on every run-ending event (normal
    // finish, cooperative /stop-triggered cancellation, or the CLI process
    // itself being interrupted). This is the server-side equivalent of the
    // client-side saveState() button (HTML_TEMPLATE above) -- that one only
    // works if a human has the dashboard open in a browser; this one runs
    // unconditionally so a sprint's final state is never lost just because
    // nobody was watching. `saved` guards against writing twice for the same
    // run (e.g. 'end' fires, then a SIGINT arrives moments later during the
    // bin/cli.mjs failure grace-period wait).
    let saved = false;
    function persistState() {
        if (saved) return;
        saved = true;
        try {
            const dir = path.join(process.cwd(), 'sprint-logs');
            const now = new Date();
            const pad2 = (n) => String(n).padStart(2, '0');
            const hhmmss = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
            const filePath = path.join(dir, `sprint_${hhmmss}.json`);
            // apra-fleet-eft.20.1: route through the same single-pass
            // JSON.stringify + atomic temp-file-then-rename primitive the
            // debounced writer uses (writeJsonFileAtomic, debounced-writer.mjs)
            // instead of a direct writeFileSync, so this terminal snapshot can
            // never be observed half-written and its bytes always round-trip
            // through JSON.parse().
            writeJsonFileAtomic(filePath, state);
            console.log(`[Viewer] Sprint state saved to ${filePath}`);
        } catch (e) {
            // A failed save must never crash or block the sprint's own
            // normal exit behavior -- log and move on.
            console.warn(`[Viewer] Warning: failed to save sprint state: ${e.message}`);
        }
    }

    // Covers reason 3 (CLI process interrupted): SIGINT/SIGTERM had NO
    // handler at all today for a still-running or successfully-finished
    // sprint (bin/cli.mjs only registers a SIGINT handler inside its
    // failure-grace-window Promise). Registering a listener here removes
    // Node's default immediate-exit behavior for the signal, so the handler
    // must explicitly call process.exit() itself after the best-effort save
    // to preserve that same "the process ultimately terminates" contract --
    // it does not swallow the signal or turn it into a no-op.
    // NOTE: signal listeners registered via process.on('SIGINT'/'SIGTERM', fn)
    // do NOT receive the signal name as an argument (unlike a manually
    // dispatched process.emit(name, ...args)), so a single shared handler
    // can't tell them apart -- hence two small wrappers instead of one
    // handler branching on an argument that would never actually arrive.
    const handleSigint = () => {
        state.endedAt = nowIso();
        state.terminalReason = state.terminalReason || 'SIGINT';
        persistState();
        // apra-fleet-eft.2.1: flush any coalesced-but-not-yet-written
        // debounced state synchronously before the process actually exits,
        // so at most one debounce window of progress is ever lost.
        debouncedWriter.flushSync();
        // apra-fleet-eft.2.3: SIGINT/SIGTERM are a graceful (not hard-kill)
        // shutdown path, so the file is still moved to old_sprints/ here --
        // it's only an unhandled SIGKILL/OOM that leaves it behind in
        // running/ (that gap is what apra-fleet-eft.2.4's hard-kill test
        // covers).
        moveStateToOldSprints();
        process.exit(130);
    };
    const handleSigterm = () => {
        state.endedAt = nowIso();
        state.terminalReason = state.terminalReason || 'SIGTERM';
        persistState();
        debouncedWriter.flushSync();
        moveStateToOldSprints();
        process.exit(143);
    };
    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);

    workflow.on('group:start', (data) => {
        currentGroup = { title: data.title, phases: [] };
        state.tree.push(currentGroup);
        broadcast({ type: 'update' });
    });

    workflow.on('phase', (title) => {
        currentPhase = { title, events: [] };
        if (!currentGroup) {
            currentGroup = { title: 'Workflow', phases: [] };
            state.tree.push(currentGroup);
        }
        currentGroup.phases.push(currentPhase);
        broadcast({ type: 'update' });
    });

    workflow.on('activity:start', (meta) => {
        state.stats.activitiesCount++;
        currentPhase.events.push({ type: 'activity', id: meta.id, data: { ...meta, isRunning: true } });
        broadcast({ type: 'update' });
    });

    workflow.on('activity:end', (meta) => {
        // apra-fleet-eft.27.4: cap a `command` activity's output/error to a
        // head+tail excerpt + byte count BEFORE it lands in state.tree --
        // this is the object persisted (debounced running/<sprintId>.json,
        // terminal sprint-logs/ snapshot) and read by GET /state's
        // buildListStatePayload() transform, so an uncapped multi-MB command
        // dump written here bloats all three regardless of that transform.
        // Returns the SAME `meta` reference unchanged when there's nothing
        // to cap (non-command activities, or output already under the cap),
        // and never mutates the original `meta` object -- other
        // `activity:end` listeners (e.g. journal.mjs's replay cache) still
        // need the complete, uncapped text.
        const storedMeta = capCommandActivityMeta(meta, commandOutputCapOpts);
        for (const g of state.tree) {
            for (const p of g.phases) {
                const ev = p.events.find(e => e.type === 'activity' && e.id === meta.id);
                if (ev) {
                    ev.data = { ...ev.data, ...storedMeta, isRunning: false };
                }
            }
        }
        if (meta.usage?.total_tokens) state.stats.totalTokens += meta.usage.total_tokens;
        // apra-fleet-unw.4: `cost` is only added to the running total when
        // it's a known number. When agent() explicitly reported cost: null
        // (fleet result had no usage, or the model wasn't in the pricing
        // table), tally it separately instead of fabricating a total.
        if (typeof meta.cost === 'number') {
            state.stats.totalCost += meta.cost;
        } else if (meta.type === 'agent' && Object.prototype.hasOwnProperty.call(meta, 'cost') && meta.cost === null) {
            state.stats.unknownCostCount++;
        }
        broadcast({ type: 'update' });
    });

    workflow.on('log', (entry) => {
        currentPhase.events.push({ type: 'log', time: entry.time || Date.now(), msg: entry.msg });
        broadcast({ type: 'update' });
    });

    workflow.on('state', (stateData) => {
        state.extensions[stateData.namespace] = stateData.data;
        broadcast({ type: 'state', payload: stateData });
    });

    workflow.on('end', (res) => {
        state.status = res.status;
        state.stats.durationMs = Date.now() - state.stats.startTime;
        // apra-fleet-eft.2.2: enrich the terminal state with whatever the
        // workflow script's own return value (res.result, e.g. the
        // auto-sprint runner's { verdict, notes, ... }) or thrown error
        // surfaced -- both are best-effort/optional since not every
        // workflow script returns a verdict/prUrl.
        state.verdict = res.result && res.result.verdict !== undefined ? res.result.verdict : state.verdict;
        state.prUrl = res.result && res.result.prUrl !== undefined ? res.result.prUrl : state.prUrl;
        state.endedAt = nowIso();
        state.terminalReason = res.error
            ? (res.error.message || res.error.name || res.status)
            : res.status;
        broadcast({ type: 'update' });
        persistState();
        // apra-fleet-eft.2.1: synchronous flush-on-exit -- a run ending is
        // one of the process-exit-adjacent paths this writer must never
        // lose more than one debounce window against.
        debouncedWriter.flushSync();
        // apra-fleet-eft.2.3: terminal completion -- move running/<id>.json
        // to old_sprints/<id>.json (directory membership, not a stale field,
        // is what makes "is this sprint live" authoritative).
        moveStateToOldSprints();
    });

    const server = http.createServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(HTML_TEMPLATE(dashboardExtensions));
        } else if (req.url === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-cache' });
            clients.add(res);
            req.on('close', () => clients.delete(res));
        } else if (req.url.startsWith('/state')) {
            // apra-fleet-eft.27.1: GET /state is the RECURRING poll endpoint
            // (every ~250ms-400ms while a sprint is live) -- it must never
            // serve the full in-memory `state` object as-is. That object
            // accumulates one entry per activity for the sprint's entire
            // history, and each entry can embed multi-KB command/agent
            // output; on a real 449-activity sprint this endpoint measured a
            // 116 MB payload per poll (apra-fleet-eft.27). buildListStatePayload()
            // (src/viewer/lean-state.mjs) strips descriptions/transcripts
            // down to short summaries and dedupes any remaining repeated
            // strings -- `state` itself (the source of truth persisted to
            // sprint-logs/ and running/<sprintId>.json, and what the
            // process-free History view embeds) is never mutated by this.
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' });
            res.end(JSON.stringify(buildListStatePayload(state)));
        } else if (req.method === 'GET' && /^\/beads\/[^/]+\/description$/.test(req.url)) {
            // apra-fleet-eft.27.2: on-demand full-description endpoint. This
            // is fetched ONLY when a user expands a bead row in the
            // dashboard's beads extension (packages/apra-fleet-se/auto-sprint
            // /viewer-extensions.mjs) -- never during normal polling -- and
            // the browser caches the result in localStorage, keyed by bead
            // id and validated against `updatedAt` (bd's `updated_at`),
            // re-fetching only once that timestamp changes in a later /state
            // poll.
            const id = decodeURIComponent(req.url.slice('/beads/'.length, req.url.length - '/description'.length));
            const bead = findBeadById(state, id);
            if (!bead) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'bead not found', id }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({
                id: bead.id,
                description: bead.description || '',
                updatedAt: bead.updated_at || bead.updatedAt || null
            }));
        } else if (req.method === 'GET' && /^\/activities\/[^/]+\/output$/.test(req.url)) {
            // apra-fleet-eft.27.4: on-demand full-output endpoint for a
            // `command` activity whose stdout/error was capped to a
            // head+tail excerpt before being stored in state.tree (see the
            // activity:end handler above / command-output-cap.mjs). Fetched
            // only when a user expands a truncated command activity in the
            // dashboard -- never during normal polling. 404s (not a crash)
            // for an unknown id, or one that was never actually capped
            // (nothing to fetch beyond what's already inline).
            const id = decodeURIComponent(req.url.slice('/activities/'.length, req.url.length - '/output'.length));
            const full = getFullOutput(id);
            if (!full) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'activity output not found', id }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ id, ...full }));
        } else if (req.url === '/stop' && req.method === 'POST') {
            // (apra-fleet-unw.10) Cooperative stop -- no process.exit(). The
            // old handler killed the whole Node process immediately, with no
            // state flush and any mid-dispatch agent() /command() call left
            // orphaned (its promise simply never settles because the process
            // is gone). Instead, ask the workflow to cancel itself: this
            // aborts the active run's AbortController (FleetWorkflow
            // .requestStop(), src/workflow/index.mjs), which rejects every
            // in-flight and future agent()/command() dispatch for that run
            // via the apra-fleet-unw.5 client-side signal plumbing with a
            // typed CancelledError. The run then unwinds normally and
            // WorkflowEngine.executeFile() emits 'end' with status
            // 'cancelled' from its own finally block, same as any other
            // failure path -- the viewer transitions to CANCELLED/FAILED and
            // closes after the usual grace period, and the Node process
            // stays alive throughout.
            //
            // NOTE: this is local/client-side cancellation only. A remote
            // fleet member that already accepted a job may keep running to
            // completion even after this run unwinds as cancelled --
            // true server-side cancellation would require changes to the
            // external apra-fleet MCP server (apra-fleet.exe) and is out of
            // scope here.
            console.log('[Viewer] Stop signal received -- requesting cooperative cancellation.');
            if (typeof workflow.requestStop === 'function') {
                workflow.requestStop('Stop requested via dashboard /stop endpoint');
            }
            // apra-fleet-eft.2.1: /stop is one of the required flush-on-exit
            // paths -- the workflow itself unwinds asynchronously afterward
            // (and its own 'end' handler above will flush again once it
            // fires), but flush eagerly here too so the debounced state
            // file reflects the stop request itself without waiting on that
            // unwind.
            debouncedWriter.flushSync();
            res.writeHead(200);
            res.end();
        } else if (req.url === '/save_logs' && req.method === 'POST') {
            // Manual/scriptable trigger for the same server-side save that
            // 'end' and SIGINT/SIGTERM already perform (persistState() above)
            // -- e.g. a future dashboard button, curl, or another tool. Shares
            // the same idempotency guard (`saved`), so this is a no-op if the
            // run has already been persisted (by 'end', a signal, or a prior
            // call to this endpoint).
            console.log('[Viewer] /save_logs requested -- persisting current dashboard state.');
            persistState();
            res.writeHead(200);
            res.end();
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        console.log(`[Viewer] Workflow Dashboard live at http://localhost:${server.address().port}`);
    });

    workflow.on('end', () => {
        setTimeout(() => {
            try { server.close(); } catch(e) {}
        }, 5000);
    });

    // Avoid leaking process-level signal listeners: each createDashboardViewer()
    // call (one per test, one per real sprint run) adds its own SIGINT/SIGTERM
    // handler above; remove it once this viewer's server is done.
    server.on('close', () => {
        process.removeListener('SIGINT', handleSigint);
        process.removeListener('SIGTERM', handleSigterm);
    });

    return server;
}
