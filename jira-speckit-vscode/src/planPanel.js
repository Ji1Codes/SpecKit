// planPanel.js — Shows spec, plan, tasks and test commands before execution
'use strict';

const vscode = require('vscode');

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

class PlanPanel {
    /**
     * Show the plan review panel.
     * Returns a promise resolving to true (user clicked Proceed) or false (Cancel/close).
     *
     * @param {object} context      - VS Code ExtensionContext
     * @param {string} ticketKey    - e.g. "PM-5"
     * @param {string} summary      - ticket summary
     * @param {object} planResult   - { spec, plan, tasks, testCommands }
     */
    static show(context, ticketKey, summary, planResult) {
        return new Promise((resolve) => {
            let settled = false;
            const settle = (val) => { if (!settled) { settled = true; resolve(val); } };

            const panel = vscode.window.createWebviewPanel(
                'jiraSpeckitPlan',
                `Plan — ${ticketKey}`,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: false }
            );

            panel.webview.html = PlanPanel._buildHtml(panel.webview, ticketKey, summary, planResult);

            panel.webview.onDidReceiveMessage((msg) => {
                panel.dispose();
                settle(msg.action === 'proceed');
            }, undefined, context.subscriptions);

            panel.onDidDispose(() => settle(false), undefined, context.subscriptions);
        });
    }

    static _buildHtml(webview, key, summary, { spec, plan, tasks, testCommands }) {
        const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');

        // Render plain text to HTML: blank lines → paragraph breaks, preserve indentation
        const renderText = (text) => {
            if (!text) return '<em style="opacity:.5">—</em>';
            return esc(text)
                .split(/\n\n+/)
                .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
                .join('');
        };

        const testRows = (testCommands || []).slice(0, 10).map(cmd =>
            `<div class="cmd-row"><span class="prompt">$</span><code>${esc(cmd)}</code></div>`
        ).join('') || '<p class="muted">No test commands specified.</p>';

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>SpecKit Plan</title>
<style nonce="${nonce}">
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family,system-ui);
  font-size:var(--vscode-font-size,13px);
  color:var(--vscode-editor-foreground);
  background:var(--vscode-editor-background);
  padding:28px 32px 60px;
  max-width:820px;
  margin:0 auto;
}
h1{font-size:1.25em;font-weight:700;margin-bottom:4px;line-height:1.3}
.ticket-meta{font-size:12px;opacity:.55;margin-bottom:24px}
.badge{
  display:inline-block;padding:2px 10px;border-radius:12px;
  background:var(--vscode-badge-background,#0e639c);
  color:var(--vscode-badge-foreground,#fff);
  font-weight:700;font-size:11px;margin-right:8px;letter-spacing:.5px
}
/* sections */
details{
  border:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));
  border-radius:8px;margin-bottom:14px;overflow:hidden
}
summary{
  padding:12px 16px;cursor:pointer;font-weight:600;font-size:13px;
  background:var(--vscode-sideBar-background,rgba(255,255,255,.03));
  display:flex;align-items:center;gap:8px;user-select:none;list-style:none
}
summary::-webkit-details-marker{display:none}
.arrow{
  width:16px;height:16px;display:grid;place-items:center;
  transition:transform .2s;opacity:.6;font-style:normal
}
details[open] .arrow{transform:rotate(90deg)}
.section-body{padding:14px 16px;line-height:1.6}
.section-body p{margin-bottom:8px}
.section-body p:last-child{margin-bottom:0}
/* tasks */
.task-list{list-style:none;display:flex;flex-direction:column;gap:6px}
.task-list li{display:flex;align-items:flex-start;gap:8px;line-height:1.5}
.task-list li::before{content:"☐";font-size:14px;margin-top:1px;opacity:.7;flex-shrink:0}
/* test commands */
.cmd-block{
  background:var(--vscode-terminal-background,#1e1e1e);
  border:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));
  border-radius:6px;overflow:hidden;font-family:var(--vscode-editor-font-family,monospace)
}
.cmd-row{display:flex;align-items:center;gap:10px;padding:7px 14px;font-size:12.5px}
.cmd-row+.cmd-row{border-top:1px solid rgba(128,128,128,.1)}
.prompt{color:#4ec9b0;font-weight:700;flex-shrink:0}
.cmd-row code{color:var(--vscode-terminal-foreground,#ccc)}
.muted{opacity:.45;font-style:italic}
/* actions */
.actions{
  position:fixed;bottom:0;left:0;right:0;
  display:flex;gap:12px;justify-content:flex-end;
  padding:14px 32px;
  background:var(--vscode-editor-background);
  border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.15));
}
button{
  padding:8px 22px;border-radius:5px;font-size:13px;
  font-family:inherit;cursor:pointer;border:1px solid transparent
}
.btn-proceed{
  background:var(--vscode-button-background,#0e639c);
  color:var(--vscode-button-foreground,#fff);
  border-color:var(--vscode-button-background,#0e639c)
}
.btn-proceed:hover{filter:brightness(1.12)}
.btn-cancel{
  background:transparent;
  color:var(--vscode-descriptionForeground);
  border-color:var(--vscode-panel-border,rgba(128,128,128,.35))
}
.btn-cancel:hover{background:rgba(128,128,128,.1)}
.notice{
  background:rgba(14,99,156,.12);border:1px solid rgba(14,99,156,.3);
  border-radius:6px;padding:10px 14px;margin-bottom:20px;
  font-size:12px;line-height:1.5;color:var(--vscode-descriptionForeground)
}
.notice strong{color:var(--vscode-editor-foreground)}
</style>
</head>
<body>
<h1><span class="badge">${esc(key)}</span>${esc(summary)}</h1>
<p class="ticket-meta">SpecKit has analysed this ticket. Review the plan below before any code is generated.</p>

<div class="notice">
  <strong>No code has been written yet.</strong>
  Review the specification, plan and tasks. If the plan looks correct, click <strong>Proceed</strong>
  to generate the implementation. Click <strong>Cancel</strong> to abort.
</div>

<details open>
  <summary><i class="arrow">▶</i>Specification</summary>
  <div class="section-body">${renderText(spec)}</div>
</details>

<details open>
  <summary><i class="arrow">▶</i>Implementation Plan</summary>
  <div class="section-body">${renderText(plan)}</div>
</details>

<details open>
  <summary><i class="arrow">▶</i>Task Checklist</summary>
  <div class="section-body">
    <ul class="task-list">
      ${(tasks || '').split('\n')
          .filter(l => l.trim())
          .map(l => `<li>${esc(l.replace(/^-\s*\[.\]\s*/, '').replace(/^-\s*/, ''))}</li>`)
          .join('\n      ')}
    </ul>
  </div>
</details>

<details open>
  <summary><i class="arrow">▶</i>Test &amp; Verification Commands</summary>
  <div class="section-body">
    <p style="margin-bottom:10px;font-size:12px;opacity:.6">
      These commands will run in the integrated terminal after the files are written.
    </p>
    <div class="cmd-block">${testRows}</div>
  </div>
</details>

<div class="actions">
  <button class="btn-cancel" id="cancelBtn">Cancel</button>
  <button class="btn-proceed" id="proceedBtn">Proceed with Implementation →</button>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('proceedBtn').onclick = () => vscode.postMessage({ action: 'proceed' });
document.getElementById('cancelBtn').onclick  = () => vscode.postMessage({ action: 'cancel' });
</script>
</body>
</html>`;
    }
}

module.exports = { PlanPanel };
