// approvalPanel.js — Review & approve AI-generated files before writing to disk
'use strict';

const vscode = require('vscode');

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

class ApprovalPanel {
    /**
     * Show a review panel for the generated files.
     * Returns a promise that resolves to the array of approved files to write.
     * Resolves to [] if the user denies or closes the panel.
     *
     * @param {object} context       VS Code ExtensionContext
     * @param {string} ticketKey     e.g. "PM-5"
     * @param {string} ticketSummary e.g. "Build dashboard UI"
     * @param {Array}  generatedFiles [{path, content}]
     * @returns {Promise<Array>}
     */
    static show(context, ticketKey, ticketSummary, generatedFiles) {
        return new Promise((resolve) => {
            let resolved = false;
            const settle = (files) => {
                if (!resolved) { resolved = true; resolve(files); }
            };

            const panel = vscode.window.createWebviewPanel(
                'jiraSpeckitApproval',
                `Review Changes — ${ticketKey}`,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: false }
            );

            panel.webview.html = ApprovalPanel._buildHtml(ticketKey, ticketSummary, generatedFiles);

            panel.webview.onDidReceiveMessage((msg) => {
                switch (msg.action) {
                    case 'applySelected': {
                        const approved = generatedFiles.filter((_, i) => (msg.selected || []).includes(i));
                        panel.dispose();
                        settle(approved);
                        break;
                    }
                    case 'applyAll': {
                        panel.dispose();
                        settle([...generatedFiles]);
                        break;
                    }
                    case 'deny': {
                        panel.dispose();
                        settle([]);
                        break;
                    }
                }
            }, undefined, context.subscriptions);

            // Closing the panel without deciding = deny
            panel.onDidDispose(() => settle([]), undefined, context.subscriptions);
        });
    }

    static _buildHtml(ticketKey, ticketSummary, files) {
        const PREVIEW_LINE_LIMIT = 300;

        const cardsHtml = files.map((f, i) => {
            const lines    = f.content.split('\n');
            const preview  = lines.slice(0, PREVIEW_LINE_LIMIT).join('\n');
            const truncated = lines.length > PREVIEW_LINE_LIMIT
                ? `\n… (${lines.length - PREVIEW_LINE_LIMIT} more lines)` : '';
            const lineCount = lines.length;

            return `
<div class="file-card" id="card-${i}">
  <div class="file-header" onclick="toggleBody(${i})">
    <input type="checkbox" class="file-check" data-index="${i}" checked
           onclick="event.stopPropagation(); updateCount();" />
    <span class="file-path">${escapeHtml(f.path)}</span>
    <span class="file-meta">${lineCount} line${lineCount !== 1 ? 's' : ''}</span>
    <span class="chevron" id="chev-${i}">▶</span>
  </div>
  <div class="file-body" id="body-${i}">
    <pre><code>${escapeHtml(preview)}${escapeHtml(truncated)}</code></pre>
  </div>
</div>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review Changes</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 24px;
    min-height: 100vh;
  }

  /* ── Header ── */
  .header { margin-bottom: 18px; }
  .header-top { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
  .ticket-badge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.5px; flex-shrink: 0;
  }
  h1 { font-size: 17px; font-weight: 600; color: var(--vscode-foreground); }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 2px; }

  /* ── Toolbar ── */
  .toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 0; margin-bottom: 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-wrap: wrap;
  }
  .toolbar-left { display: flex; gap: 8px; flex: 1; flex-wrap: wrap; }
  .btn {
    padding: 5px 16px; border-radius: 4px; border: none;
    cursor: pointer; font-size: 12px; font-family: inherit;
    font-weight: 500; transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .btn-apply-sel {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-apply-all {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .btn-deny {
    background: transparent;
    color: var(--vscode-errorForeground, #f44);
    border: 1px solid var(--vscode-errorForeground, #f44);
  }
  .counter {
    color: var(--vscode-descriptionForeground); font-size: 12px; margin-left: auto;
  }
  .select-links { display: flex; gap: 10px; margin-left: 4px; }
  .link-btn {
    background: none; border: none; cursor: pointer; font-size: 11px;
    color: var(--vscode-textLink-foreground); text-decoration: underline;
    font-family: inherit; padding: 0;
  }

  /* ── File Cards ── */
  .file-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; margin-bottom: 10px; overflow: hidden;
  }
  .file-card.unchecked { opacity: 0.5; }
  .file-header {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 14px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    cursor: pointer; user-select: none;
  }
  .file-header:hover { background: var(--vscode-list-hoverBackground); }
  .file-check { width: 14px; height: 14px; cursor: pointer; flex-shrink: 0; accent-color: var(--vscode-button-background); }
  .file-path {
    font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
    font-size: 12px; flex: 1; color: var(--vscode-foreground);
  }
  .file-meta { color: var(--vscode-descriptionForeground); font-size: 11px; flex-shrink: 0; }
  .chevron { color: var(--vscode-descriptionForeground); font-size: 10px; transition: transform 0.15s; flex-shrink: 0; }
  .chevron.open { transform: rotate(90deg); }

  /* ── Code Preview ── */
  .file-body { display: none; border-top: 1px solid var(--vscode-panel-border); }
  .file-body.open { display: block; }
  pre {
    margin: 0; padding: 12px 16px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
    font-size: 12px; line-height: 1.55;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    white-space: pre;
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-top">
    <span class="ticket-badge">${escapeHtml(ticketKey)}</span>
    <h1>Review AI-Generated Files</h1>
  </div>
  <div class="subtitle">${escapeHtml(ticketSummary)} &mdash; ${files.length} file${files.length !== 1 ? 's' : ''} generated. Select what to apply to your workspace.</div>
</div>

<div class="toolbar">
  <div class="toolbar-left">
    <button class="btn btn-apply-sel" id="btn-apply-sel" onclick="applySelected()">✅ Apply Selected</button>
    <button class="btn btn-apply-all" onclick="applyAll()">⚡ Apply All</button>
    <button class="btn btn-deny" onclick="deny()">✖ Deny All</button>
    <div class="select-links">
      <button class="link-btn" onclick="selectAll()">Select all</button>
      <button class="link-btn" onclick="deselectAll()">Deselect all</button>
    </div>
  </div>
  <span class="counter" id="counter">${files.length} / ${files.length} selected</span>
</div>

${cardsHtml}

<script>
  const vscode = acquireVsCodeApi();
  const total = ${files.length};

  function getChecked() {
    return [...document.querySelectorAll('.file-check:checked')].map(cb => parseInt(cb.dataset.index));
  }

  function updateCount() {
    const n = getChecked().length;
    document.getElementById('counter').textContent = n + ' / ' + total + ' selected';
    document.getElementById('btn-apply-sel').disabled = n === 0;
    document.querySelectorAll('.file-card').forEach((card, i) => {
      const cb = card.querySelector('.file-check');
      card.classList.toggle('unchecked', !cb.checked);
    });
  }

  function toggleBody(i) {
    const body = document.getElementById('body-' + i);
    const chev = document.getElementById('chev-' + i);
    const open = body.classList.toggle('open');
    chev.classList.toggle('open', open);
  }

  function selectAll()   { document.querySelectorAll('.file-check').forEach(cb => cb.checked = true);  updateCount(); }
  function deselectAll() { document.querySelectorAll('.file-check').forEach(cb => cb.checked = false); updateCount(); }

  function applySelected() {
    const selected = getChecked();
    if (selected.length === 0) return;
    vscode.postMessage({ action: 'applySelected', selected });
  }
  function applyAll() { vscode.postMessage({ action: 'applyAll' }); }
  function deny()     { vscode.postMessage({ action: 'deny' }); }

  updateCount();
</script>
</body>
</html>`;
    }
}

module.exports = { ApprovalPanel };
