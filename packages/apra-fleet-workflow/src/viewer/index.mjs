import http from 'http';

const HTML_TEMPLATE = (dashboardExtensions) => `<!DOCTYPE html>
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
    
    .main-content { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 220px; border-right: 1px solid var(--border); padding: 20px; background: var(--bg-glass); overflow-y: auto; flex-shrink: 0; }
    .phase-tracker { list-style: none; padding: 0; }
    .phase-item { padding: 6px 10px; font-size: 13px; color: var(--text-muted); border-radius: 4px; margin-bottom: 2px; }
    .phase-item.active { background: rgba(255,255,255,0.05); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
    
    .content-area { flex: 1; padding: 20px; display: flex; flex-direction: column; overflow: hidden; }
    .panel { background: var(--bg-glass); border: 1px solid var(--border); border-radius: 6px; display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    .panel-header { flex-shrink: 0; padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); text-transform: uppercase; letter-spacing: 0.5px; }
    
    .stream-list { flex: 1; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; background: #000; }
    
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
    .tab-content.active { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <h1><span id="workflow-name">Loading...</span></h1>
    <div class="header-actions">
      <div class="stats-banner" id="stats-banner"></div>
      <div id="status-indicator" style="font-size: 12px; font-weight: 600; min-width: 70px; text-align: center;"></div>
      <button class="btn btn-save" onclick="saveState()">Save</button>
      <button class="btn btn-stop" onclick="stopWorkflow()">Stop</button>
    </div>
  </div>
  <div class="main-content">
    <div class="sidebar">
      <div style="font-size: 11px; font-weight: 600; margin-bottom: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Phases</div>
      <ul class="phase-tracker" id="phase-list"></ul>
    </div>
    <div class="content-area">
      <div class="tab-bar" id="tab-bar">
        <button class="tab-btn active" onclick="switchTab('core')">Timeline</button>
        ${dashboardExtensions.map(ext => `<button class="tab-btn" onclick="switchTab('${ext.id}')">${ext.title}</button>`).join('\n')}
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
          <div id="extension-${ext.id}" style="padding: 12px; overflow-y: auto;"></div>
        </div>
      `).join('\n')}
    </div>
  </div>
  ${dashboardExtensions.map(ext => `<script>\n${ext.js}\n</script>`).join('\n')}
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
    
    function escapeHtml(unsafe) {
      return (unsafe || '').toString()
           .replace(/&/g, "&amp;")
           .replace(/</g, "&lt;")
           .replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;")
           .replace(/'/g, "&#039;");
    }
    
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

    let allExpanded = false;
    function toggleAllGlobal() {
      allExpanded = !allExpanded;
      document.querySelectorAll('details.event-activity').forEach(d => {
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

    let renderedEventsCount = 0;

    const source = new EventSource('/events');
    source.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'state') {
            const extEvent = new CustomEvent('workflow:state:' + ev.payload.namespace, { detail: ev.payload.data });
            document.dispatchEvent(extEvent);
        }
        // Update logic same as poller
        poll();
    };

    async function poll() {
      try {
        const res = await fetch('/state?_t=' + Date.now(), { cache: 'no-store' });
        const state = await res.json();
        globalState = state;
        
        document.getElementById('workflow-name').textContent = state.workflowName;
        
        const ind = document.getElementById('status-indicator');
        if (state.status === 'running') { ind.innerHTML = '<div class="status-live-indicator"><div class="led"></div> LIVE</div>'; }
        else if (state.status === 'success') { ind.innerHTML = '<span style="color:var(--success)">DONE</span>'; }
        else { ind.innerHTML = '<span style="color:var(--danger)">FAILED</span>'; }
        
        const dur = state.status === 'running' ? Date.now() - state.stats.startTime : state.stats.durationMs;
        document.getElementById('stats-banner').innerHTML = 
          \`<span><strong>\${state.stats.activitiesCount}</strong> Activities</span>
           <span><strong class="spent">$\${state.stats.totalCost.toFixed(3)}</strong> Spent</span>
           <span><strong>\${state.stats.totalTokens.toLocaleString()}</strong> Tokens</span>
           <span><strong>\${formatUptime(dur)}</strong> Uptime</span>\`;
        
        const phaseHtml = state.phases.map(p => 
          \`<li class="phase-item \${p === state.currentPhase ? 'active' : ''}">\${escapeHtml(p)}</li>\`
        ).join('');
        document.getElementById('phase-list').innerHTML = phaseHtml;
        
        // Update existing activities that have transitioned to complete
        state.events.forEach(ev => {
            if (ev.type === 'activity') {
                const act = ev.data;
                const existing = document.getElementById('activity-' + act.id);
                if (existing) {
                    let badge = '';
                    if (act.isRunning) badge = '<span class="status-badge status-running">Running</span>';
                    else if (act.success) badge = '<span class="status-badge status-success">Success</span>';
                    else badge = '<span class="status-badge status-error">Failed</span>';
                    
                    const metaDiv = document.getElementById('meta-' + act.id);
                    if (metaDiv) {
                        let tokensHtml = act.usage ? \`<span style="color:var(--text-muted)">\${act.usage.total_tokens.toLocaleString()} tkns</span>\` : '';
                        metaDiv.innerHTML = \`\${tokensHtml} \${act.duration ? formatTime(act.duration) : ''} \${badge} <span class="toggle-icon"></span>\`;
                    }
                    
                    if (!act.isRunning && !document.getElementById('body-' + act.id)) {
                        let childrenHtml = '';
                        if (act.error) {
                            childrenHtml = \`<div class="activity-child error">\${escapeHtml(act.error)}\\n\\n\${act.input ? 'Input:\\n' + escapeHtml(act.input) + '\\n\\n' : ''}\${act.output ? 'Output:\\n' + escapeHtml(act.output) : ''}</div>\`;
                        } else if (act.output) {
                            childrenHtml = \`<div class="activity-child output">\${act.input && act.type === 'transform' ? 'Input:\\n' + escapeHtml(act.input) + '\\n\\nOutput:\\n' : ''}\${escapeHtml(act.output)}</div>\`;
                        }
                        if (childrenHtml) {
                            const bodyDiv = document.createElement('div');
                            bodyDiv.id = 'body-' + act.id;
                            bodyDiv.className = 'activity-body';
                            bodyDiv.innerHTML = childrenHtml;
                            existing.appendChild(bodyDiv);
                        }
                    }
                }
            }
        });
        
        // Append new events
        for (let i = renderedEventsCount; i < state.events.length; i++) {
          const ev = state.events[i];
          const div = document.createElement('div');
          
          if (ev.type === 'log') {
            const dateObj = new Date(ev.time || Date.now());
            const t = isNaN(dateObj.getTime()) ? '-' : dateObj.toLocaleTimeString([], { hour12: false });
            
            const hasNewlines = ev.msg && ev.msg.includes('\\n');
            if (hasNewlines) {
              const lines = ev.msg.split('\\n');
              const firstLine = lines[0];
              const rest = lines.slice(1).join('\\n');
              div.innerHTML = \`<details class="event-activity log-multiline">
                <summary class="activity-header">
                  <span class="log-time">\${t}</span>
                  <span class="activity-title" style="font-family:monospace; font-size:12px; color:#d4d4d8;">
                    [\${escapeHtml(ev.phase)}] \${escapeHtml(firstLine)} <em style="color:#a1a1aa">...</em>
                  </span>
                  <div class="activity-meta">
                    <span class="toggle-icon"></span>
                  </div>
                </summary>
                <div class="activity-body">
                  <div class="activity-child" style="color:#d4d4d8;">\${escapeHtml(rest)}</div>
                </div>
              </details>\`;
            } else {
              div.innerHTML = \`<div class="event-log"><span class="log-time">\${t}</span><span class="log-msg">[\${escapeHtml(ev.phase)}] \${escapeHtml(ev.msg)}</span></div>\`;
            }
          } else if (ev.type === 'activity') {
            const act = ev.data;
            const dateObj = new Date(act.startTime || Date.now());
            const t = isNaN(dateObj.getTime()) ? '-' : dateObj.toLocaleTimeString([], { hour12: false });
            
            let badge = '';
            if (act.isRunning) badge = '<span class="status-badge status-running">Running</span>';
            else if (act.success) badge = '<span class="status-badge status-success">Success</span>';
            else badge = '<span class="status-badge status-error">Failed</span>';
            
            let childrenHtml = '';
            if (!act.isRunning) {
              if (act.error) {
                childrenHtml = \`<div class="activity-child error">\${escapeHtml(act.error)}\\n\\n\${act.input ? 'Input:\\n' + escapeHtml(act.input) + '\\n\\n' : ''}\${act.output ? 'Output:\\n' + escapeHtml(act.output) : ''}</div>\`;
              } else if (act.output) {
                childrenHtml = \`<div class="activity-child output">\${act.input && act.type === 'transform' ? 'Input:\\n' + escapeHtml(act.input) + '\\n\\nOutput:\\n' : ''}\${escapeHtml(act.output)}</div>\`;
              }
            }
            
            let tokensHtml = act.usage ? \`<span style="color:var(--text-muted)">\${act.usage.total_tokens.toLocaleString()} tkns</span>\` : '';
            const memberDisplay = act.member ? escapeHtml(act.member) : (act.type === 'transform' ? 'js' : '');
            const memberHtml = memberDisplay ? \`<span class="muted">(\${memberDisplay})</span>\` : '';
            
            div.innerHTML = \`<details class="event-activity" id="activity-\${act.id}">
              <summary class="activity-header">
                <span class="log-time">\${t}</span>
                <span class="activity-title"><strong>\${escapeHtml(act.type.toUpperCase())}</strong>: \${escapeHtml(act.label)} \${memberHtml}</span>
                <div class="activity-meta" id="meta-\${act.id}">
                  \${tokensHtml}
                  \${act.duration ? formatTime(act.duration) : ''} \${badge}
                  <span class="toggle-icon"></span>
                </div>
              </summary>
              \${childrenHtml ? \`<div class="activity-body" id="body-\${act.id}">\${childrenHtml}</div>\` : ''}
            </details>\`;
          } else if (ev.type === 'state') {
            // Dispatch historical state events for extensions loading late
            const extEvent = new CustomEvent('workflow:state:' + ev.payload.namespace, { detail: ev.payload.data });
            document.dispatchEvent(extEvent);
          }
          
          if (div.firstElementChild) {
              streamEl.appendChild(div.firstElementChild);
          }
        }
        
        renderedEventsCount = state.events.length;
        
        if (isAutoScrolling) {
          streamEl.scrollTop = streamEl.scrollHeight;
        }
      } catch(e) {
          console.error("Poll Error:", e);
          if (globalState && (globalState.status === 'success' || globalState.status === 'failed')) {
              // already done, ignore
          } else {
              document.getElementById('status-indicator').innerHTML = '<span class="status-badge status-offline">OFFLINE</span>';
          }
      }
    }
    
    poll();
  </script>
</body>
</html>`;

export function createDashboardViewer(workflow, opts = {}) {
    const port = opts.port || 8080;
    const dashboardExtensions = opts.dashboardExtensions || [];
    
    const state = {
        workflowName: opts.name || 'Apra Fleet Workflow',
        phases: opts.phases || ['init'],
        currentPhase: 'init',
        events: [],
        status: 'running',
        stats: {
            activitiesCount: 0,
            totalTokens: 0,
            totalCost: 0,
            startTime: Date.now(),
            durationMs: 0
        }
    };

    const clients = new Set();
    const broadcast = (data) => {
        const msg = `data: ${JSON.stringify(data)}\n\n`;
        clients.forEach(c => c.write(msg));
    };

    workflow.on('phase', (title) => {
        state.currentPhase = title;
        if (!state.phases.includes(title)) state.phases.push(title);
        broadcast({ type: 'update' });
    });

    workflow.on('activity:start', (meta) => {
        state.stats.activitiesCount++;
        state.events.push({ type: 'activity', id: meta.id, data: { ...meta, isRunning: true } });
        broadcast({ type: 'update' });
    });

    workflow.on('activity:end', (meta) => {
        const idx = state.events.findIndex(e => e.type === 'activity' && e.id === meta.id);
        if (idx >= 0) state.events[idx].data = { ...state.events[idx].data, ...meta, isRunning: false };
        if (meta.usage?.total_tokens) state.stats.totalTokens += meta.usage.total_tokens;
        if (meta.cost) state.stats.totalCost += meta.cost;
        broadcast({ type: 'update' });
    });

    workflow.on('log', (entry) => {
        state.events.push({ type: 'log', time: entry.time || Date.now(), phase: entry.phase, msg: entry.msg });
        broadcast({ type: 'update' });
    });

    workflow.on('state', (stateData) => {
        state.events.push({ type: 'state', payload: stateData, timestamp: Date.now() });
        broadcast({ type: 'state', payload: stateData });
    });

    workflow.on('end', (res) => {
        state.status = res.status;
        state.stats.durationMs = Date.now() - state.stats.startTime;
        broadcast({ type: 'update' });
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
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' });
            res.end(JSON.stringify(state));
        } else if (req.url === '/stop' && req.method === 'POST') {
            console.log('[Viewer] Stop signal received.');
            res.writeHead(200);
            res.end();
            process.exit(1);
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        console.log(`[Viewer] Workflow Dashboard live at http://localhost:${port}`);
    });

    workflow.on('end', () => {
        setTimeout(() => {
            try { server.close(); } catch(e) {}
        }, 5000);
    });

    return server;
}
