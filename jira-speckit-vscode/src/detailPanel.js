// detailPanel.js — Webview panel for resolved ticket resolution details (beautiful dark UI)
'use strict';

const vscode = require('vscode');

// ─── DetailPanel ──────────────────────────────────────────────────────────────

class DetailPanel {
    static viewType = 'jiraSpeckit.detail';

    /** @type {DetailPanel|undefined} */
    static currentPanel;

    /**
     * @param {vscode.Uri}   extensionUri
     * @param {object}       ticket
     */
    static show(extensionUri, ticket) {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (DetailPanel.currentPanel) {
            DetailPanel.currentPanel._panel.reveal(column);
            DetailPanel.currentPanel._update(ticket);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            DetailPanel.viewType,
            `SpecKit: ${ticket.key}`,
            column,
            {
                enableScripts:          false,  // static HTML only — no JS needed
                retainContextWhenHidden: false,
            }
        );

        DetailPanel.currentPanel = new DetailPanel(panel, ticket);
    }

    constructor(panel, ticket) {
        this._panel = panel;
        this._update(ticket);

        panel.onDidDispose(() => {
            DetailPanel.currentPanel = undefined;
        });
    }

    _update(ticket) {
        this._panel.title             = `SpecKit: ${ticket.key}`;
        this._panel.webview.html      = this._buildHtml(ticket);
    }

    _buildHtml(t) {
        const esc = (s) => String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        const resolvedAt = t.resolved_at
            ? new Date(t.resolved_at).toLocaleString(undefined, {
                  dateStyle: 'medium', timeStyle: 'short'
              })
            : 'this session';

        const files = Array.isArray(t.files_changed) && t.files_changed.length
            ? t.files_changed : [];

        const fileExtColor = (f) => {
            const ext = (f.split('.').pop() ?? '').toLowerCase();
            const m = { py:'#3572a5', js:'#f1e05a', ts:'#3178c6', css:'#563d7c',
                        html:'#e34c26', json:'#cbcb41', jsx:'#61dafb', tsx:'#61dafb' };
            return m[ext] ?? '#58a6ff';
        };

        const fileChipsHtml = files.length
            ? files.map(f => `<span class="file-chip" style="--chip-clr:${fileExtColor(f)}">${esc(f)}</span>`).join('')
            : `<span class="no-files">No file changes recorded</span>`;

        const steps = [
            { num: '1', icon: '📋', label: 'Specify',   color: '#58a6ff', glow: 'rgba(88,166,255,0.35)',    content: t.spec },
            { num: '2', icon: '🗺️', label: 'Plan',      color: '#a371f7', glow: 'rgba(163,113,247,0.35)',   content: t.plan },
            { num: '3', icon: '✅', label: 'Tasks',      color: '#3fb950', glow: 'rgba(63,185,80,0.35)',     content: t.tasks },
            { num: '4', icon: '🚀', label: 'Implement',  color: '#f78166', glow: 'rgba(247,129,102,0.35)',   content: t.solution },
        ];

        const connectors = [
            ['#58a6ff','#a371f7'], ['#a371f7','#3fb950'], ['#3fb950','#f78166'], ['#f78166','#3fb950']
        ];

        const pipelineHtml = steps.map((s, i) => `
            <div class="pip-step" style="--c:${s.color};--g:${s.glow}">
                <div class="pip-dot">${s.num}</div>
                <span class="pip-label">${s.label}</span>
            </div>
            ${i < connectors.length ? `<div class="pip-line" style="background:linear-gradient(90deg,${connectors[i][0]},${connectors[i][1]})"></div>` : ''}
        `).join('') + `
            <div class="pip-step" style="--c:#3fb950;--g:rgba(63,185,80,0.35)">
                <div class="pip-dot">✓</div>
                <span class="pip-label">Done</span>
            </div>`;

        const sectionsHtml = steps.map(s => `
            <div class="s-card" style="--accent:${s.color}">
                <div class="s-header">
                    <div class="s-num" style="background:${s.color}">${s.num}</div>
                    <span class="s-icon">${s.icon}</span>
                    <span class="s-label">${s.label}</span>
                    <div class="s-line" style="background:${s.color}20;border-left:3px solid ${s.color}"></div>
                </div>
                <div class="s-body">
                    ${s.content
                        ? `<pre>${esc(s.content)}</pre>`
                        : `<span class="empty-text">Not available for this ticket</span>`}
                </div>
            </div>`).join('');

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${esc(t.key)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}

:root{
    --saffron:#E85535;
    --saffron-dk:#c93d22;
    --saffron-lt:#fef2ef;
    --saffron-md:#fad7cf;
    --bg:#f5f6fa;
    --card:#ffffff;
    --border:#e8eaed;
    --text:#1f2937;
    --muted:#6b7280;
    --success:#16a34a;
    --radius:10px;
    --shadow:0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06);
    --shadow-sm:0 1px 2px rgba(0,0,0,.06);
}

body{
    background:var(--bg);
    color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    font-size:14px;line-height:1.6;min-height:100vh;padding-bottom:40px;
}

/* ── HEADER ── */
.header{
    background:linear-gradient(135deg,var(--saffron) 0%,var(--saffron-dk) 100%);
    color:#fff;padding:28px 32px 24px;position:relative;overflow:hidden;
}
.header::before{
    content:'';position:absolute;top:-50px;right:-30px;
    width:240px;height:240px;border-radius:50%;
    background:rgba(255,255,255,.06);
}
.header::after{
    content:'';position:absolute;bottom:-70px;right:60px;
    width:180px;height:180px;border-radius:50%;
    background:rgba(255,255,255,.04);
}
.header-top{display:flex;align-items:center;gap:12px;margin-bottom:8px;position:relative;z-index:1}
.ticket-key{font-size:1.8em;font-weight:800;letter-spacing:-.02em;color:#fff}
.resolved-badge{
    background:rgba(255,255,255,.2);border:1.5px solid rgba(255,255,255,.55);
    color:#fff;font-size:.68em;font-weight:700;
    padding:3px 12px;border-radius:100px;text-transform:uppercase;letter-spacing:.07em;
}
.summary{font-size:1.05em;font-weight:500;color:rgba(255,255,255,.9);margin-bottom:10px;max-width:700px;line-height:1.5;position:relative;z-index:1}
.meta{display:flex;gap:18px;flex-wrap:wrap;font-size:.8em;color:rgba(255,255,255,.75);position:relative;z-index:1}
.meta span{display:flex;align-items:center;gap:5px}

/* ── BODY ── */
.body{padding:24px 32px;display:flex;flex-direction:column;gap:18px;max-width:960px}

/* ── CARDS ── */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-sm);overflow:hidden}
.card-title{font-size:.72em;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding:16px 20px 0}

/* ── PIPELINE ── */
.pipeline{display:flex;align-items:center;padding:16px 20px 18px;overflow-x:auto;gap:0}
.pip-step{display:flex;align-items:center;gap:7px;flex-shrink:0}
.pip-dot{
    width:32px;height:32px;border-radius:50%;
    background:var(--saffron);color:#fff;
    font-size:.75em;font-weight:800;
    display:flex;align-items:center;justify-content:center;flex-shrink:0;
    box-shadow:0 2px 8px rgba(232,85,53,.3);
}
.pip-dot.done{background:var(--success);box-shadow:0 2px 8px rgba(22,163,74,.3)}
.pip-label{font-size:.78em;font-weight:600;color:var(--text);white-space:nowrap}
.pip-line{flex:1;height:2px;min-width:20px;margin:0 6px;background:var(--saffron-md)}

/* ── FILES ── */
.files-inner{padding:0 20px 18px}
.files-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.file-chip{
    display:inline-flex;align-items:center;
    background:var(--saffron-lt);
    border:1px solid var(--saffron-md);
    border-left:3px solid var(--chip-clr,var(--saffron));
    border-radius:6px;padding:5px 12px;
    font-family:'Consolas','Courier New',monospace;
    font-size:.81em;color:var(--text);
}
.no-files{color:var(--muted);font-style:italic;font-size:.88em}

/* ── SECTION CARDS ── */
.s-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-sm);overflow:hidden;transition:box-shadow .2s,border-color .2s}
.s-card:hover{box-shadow:var(--shadow);border-color:var(--saffron-md)}
.s-header{display:flex;align-items:center;gap:10px;padding:13px 20px;background:var(--saffron-lt);border-bottom:1px solid var(--saffron-md)}
.s-num{width:24px;height:24px;border-radius:50%;background:var(--saffron);color:#fff;font-size:.7em;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.s-icon{font-size:1em;line-height:1}
.s-label{font-weight:700;font-size:.88em;color:var(--saffron)}
.s-divider{flex:1;height:1px;background:var(--saffron-md);margin-left:4px}
.s-body{padding:18px 20px;background:#fff}
pre{white-space:pre-wrap;word-break:break-word;font-family:'Consolas','Courier New',monospace;font-size:.83em;line-height:1.75;color:#374151}
.empty-text{color:var(--muted);font-style:italic;font-size:.88em}

/* ── SCROLLBAR ── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#9ca3af}
</style>
</head>
<body>

<div class="header">
    <div class="header-top">
        <span class="ticket-key">${esc(t.key)}</span>
        <span class="resolved-badge">✓ Resolved</span>
    </div>
    <div class="summary">${esc(t.summary)}</div>
    <div class="meta">
        <span>⏱ ${esc(resolvedAt)}</span>
        ${files.length ? `<span>📁 ${files.length} file${files.length > 1 ? 's' : ''} changed</span>` : ''}
    </div>
</div>

<div class="body">

    <div class="card">
        <div class="card-title">SpecKit Pipeline</div>
        <div class="pipeline">
            <div class="pip-step"><div class="pip-dot">1</div><span class="pip-label">Specify</span></div>
            <div class="pip-line"></div>
            <div class="pip-step"><div class="pip-dot">2</div><span class="pip-label">Plan</span></div>
            <div class="pip-line"></div>
            <div class="pip-step"><div class="pip-dot">3</div><span class="pip-label">Tasks</span></div>
            <div class="pip-line"></div>
            <div class="pip-step"><div class="pip-dot">4</div><span class="pip-label">Implement</span></div>
            <div class="pip-line"></div>
            <div class="pip-step"><div class="pip-dot done">✓</div><span class="pip-label">Done</span></div>
        </div>
    </div>

    <div class="card">
        <div class="card-title">Files Changed</div>
        <div class="files-inner">
            <div class="files-row">${fileChipsHtml}</div>
        </div>
    </div>

    ${sectionsHtml}

</div>
</body>
</html>`;
    }
}

module.exports = { DetailPanel };
