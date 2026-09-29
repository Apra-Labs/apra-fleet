// =============================================================================
// Supervisor Shell Theme Tokens and Base Rules (apra-fleet-i9ag.20.1)
// =============================================================================
//
// Single source of truth for the supervisor and console theme tokens.
// Used by both the main supervisor dashboard and the console /ui/projects page
// so theme tokens and base styles never drift.
//
// apra-fleet supervisor-viewer-parity: the SAME CSS custom-property names and
// header/tab/panel vocabulary as apra-fleet-workflow's per-sprint dashboard
// (packages/apra-fleet-workflow/src/viewer/index.mjs's HTML_TEMPLATE) -- one
// operator moving between "a single sprint's live view" and "the cross-sprint
// supervisor" should not have to re-learn a second visual language. fleet-
// sprint's own beads-tree extension (viewer-extensions.mjs's renderBeadsHtml,
// reused verbatim for the Backlog tab below) already styles its badges via
// `var(--accent)` / `var(--danger)` etc, so defining the SAME tokens here is
// what makes that reuse actually look right, not just share markup shape.
// =============================================================================

export const THEME_CSS = `
    :root {
      --bg: #09090b; --bg-glass: rgba(24, 24, 27, 0.6); --border: rgba(255, 255, 255, 0.1);
      --text: #e4e4e7; --text-muted: #a1a1aa; --accent: #3b82f6; --accent-glow: rgba(59, 130, 246, 0.2);
      --success: #10b981; --warning: #f59e0b; --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { background: var(--bg); color: var(--text); font-family: sans-serif; height: 100vh; height: 100dvh; overflow: hidden; display: flex; flex-direction: column; }
    a { color: var(--accent); }
    .header { flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: var(--bg-glass); border-bottom: 1px solid var(--border); }
    .header h1 { font-size: 16px; font-weight: 600; margin: 0; }
    .header-actions { display: flex; gap: 12px; align-items: center; }
    .stats-banner { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); background: rgba(0,0,0,0.3); padding: 4px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); }
    .stats-banner span strong { color: var(--text); font-weight: 600; }

    .btn { padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.8; }
    .btn-secondary { background: rgba(255,255,255,0.1); color: var(--text); }

    .main-content { display: flex; flex: 1; overflow: hidden; min-height: 0; }
    .content-area { flex: 1; padding: 20px; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .panel { background: var(--bg-glass); border: 1px solid var(--border); border-radius: 6px; display: flex; flex-direction: column; flex: 1; overflow: hidden; min-height: 0; }
    .panel-header { flex-shrink: 0; padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); text-transform: uppercase; letter-spacing: 0.5px; }
    .panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; }

    .tab-bar { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; flex-shrink: 0; }
    .tab-btn { background: transparent; color: var(--text-muted); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 13px; }
    .tab-btn:hover { background: rgba(255,255,255,0.05); }
    .tab-btn.active { color: #fff; background: rgba(255,255,255,0.1); }
    .tab-content { display: none; }
    .tab-content.active { display: flex; min-height: 0; }

    .bead-row-selected { outline: 2px solid var(--accent); background: var(--accent-glow) !important; }
    table tr:hover { background: rgba(255,255,255,0.03); }
`;

export const DASHBOARD_CSS = THEME_CSS;
