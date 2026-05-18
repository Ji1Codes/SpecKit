// chatPanel.js — SpecKit Chat: Copilot-style chat with inline file accept/deny
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const { getWorkspaceContext } = require('./workspaceScanner');

const PROVIDER_DEFAULTS = {
    'azure-openai': { label: 'Azure OpenAI',  icon: '☁️',  modelKey: 'azureOpenAiDeployment', fallback: 'gpt-4.1' },
    'openai':       { label: 'OpenAI',         icon: '🟢',  modelKey: 'openAiModel',           fallback: 'gpt-4o'  },
    'anthropic':    { label: 'Anthropic',       icon: '🟠',  modelKey: 'anthropicModel',        fallback: 'claude-opus-4-5' },
    'google':       { label: 'Google Gemini',   icon: '🔵',  modelKey: 'googleModel',           fallback: 'gemini-2.0-flash' },
    'custom':       { label: 'Custom / Local',  icon: '🔧',  modelKey: 'customApiModel',        fallback: '' },
};

class ChatPanel {
    static _instance = null;

    static createOrShow(context, pipeline) {
        if (ChatPanel._instance) {
            ChatPanel._instance._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        new ChatPanel(context, pipeline);
    }

    constructor(context, pipeline) {
        this._context  = context;
        this._pipeline = pipeline;
        this._history  = [];          // [{role, content}] sent to AI
        this._wsCtx    = '';

        const cfg = vscode.workspace.getConfiguration('jiraSpeckit');
        this._activeProv  = cfg.get('aiProvider') || 'azure-openai';
        this._activeModel = cfg.get(PROVIDER_DEFAULTS[this._activeProv]?.modelKey || '') ||
                            PROVIDER_DEFAULTS[this._activeProv]?.fallback || '';

        this._panel = vscode.window.createWebviewPanel(
            'jiraSpeckitChat',
            'SpecKit Chat',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ChatPanel._instance = this;

        this._panel.webview.html = this._buildHtml();
        this._panel.webview.onDidReceiveMessage(m => this._onMessage(m), null, context.subscriptions);
        this._panel.onDidDispose(() => { ChatPanel._instance = null; }, null, context.subscriptions);

        // Load workspace context asynchronously after UI shows
        getWorkspaceContext(4000).then(ctx => {
            this._wsCtx = ctx || '';
            this._post({ type: 'system', text: `Workspace loaded — ${this._wsCtx ? 'context ready' : 'no files found'}` });
        }).catch(() => { this._wsCtx = ''; });
    }

    _post(msg) {
        try { this._panel.webview.postMessage(msg); } catch { /* panel closed */ }
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'send':        return this._handleChat(msg.text, msg.provider, msg.model);
            case 'writeFile':   return this._writeFile(msg.filePath, msg.content);
            case 'clearHistory':this._history = []; return;
            case 'providerChange': {
                this._activeProv  = msg.provider;
                this._activeModel = msg.model;
                return;
            }
        }
    }

    async _handleChat(userText, provider, model) {
        this._activeProv  = provider;
        this._activeModel = model;
        this._post({ type: 'thinking', on: true });

        const systemPrompt = [
            'You are SpecKit — an expert AI software engineer assistant integrated into VS Code.',
            'Help the user build features, fix bugs, write code, and understand their codebase.',
            this._wsCtx ? `\nWorkspace context:\n${this._wsCtx}` : '',
            '\nWhen you need to create or modify files, output each using this exact format (no surrounding fences):',
            '===FILE:relative/path/to/file===',
            '(complete file contents here)',
            '===ENDFILE===',
            'You may output multiple FILE blocks in a single response.',
            'Outside FILE blocks, write plain conversational text. Do not use markdown headers.',
        ].filter(Boolean).join('\n');

        this._history.push({ role: 'user', content: userText });

        try {
            const raw = await this._pipeline.chatWith(
                [{ role: 'system', content: systemPrompt }, ...this._history],
                provider, model
            );

            // Parse ===FILE:path===...===ENDFILE=== blocks
            const fileBlocks = [];
            const fileRe = /===FILE:([^\n=]+)===\n([\s\S]*?)===ENDFILE===/g;
            let m;
            while ((m = fileRe.exec(raw)) !== null) {
                fileBlocks.push({ path: m[1].trim().replace(/^\/+/, ''), content: m[2] });
            }
            const displayText = raw.replace(/===FILE:[^\n=]+===\n[\s\S]*?===ENDFILE===/g, '').trim();

            this._history.push({ role: 'assistant', content: raw });
            this._post({ type: 'response', text: displayText, fileBlocks });
        } catch (err) {
            this._history.pop();
            this._post({ type: 'error', message: err.message });
        } finally {
            this._post({ type: 'thinking', on: false });
        }
    }

    _writeFile(filePath, content) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) {
            vscode.window.showErrorMessage('SpecKit Chat: No workspace folder open.');
            this._post({ type: 'writeResult', filePath, ok: false, error: 'No workspace open' });
            return;
        }
        const absPath = path.join(folders[0].uri.fsPath, filePath);
        try {
            const dir = path.dirname(absPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            this._post({ type: 'writeResult', filePath, ok: true });
            vscode.window.showInformationMessage(`SpecKit: wrote ${filePath}`);
        } catch (err) {
            this._post({ type: 'writeResult', filePath, ok: false, error: err.message });
            vscode.window.showErrorMessage(`SpecKit: could not write ${filePath}: ${err.message}`);
        }
    }

    _buildHtml() {
        const cfg = vscode.workspace.getConfiguration('jiraSpeckit');

        // Build provider dropdown options + model defaults to inject as JSON
        const providerOptions = Object.entries(PROVIDER_DEFAULTS).map(([id, p]) => {
            const model = cfg.get(p.modelKey || '') || p.fallback;
            return { id, label: `${p.icon}  ${p.label}`, model };
        });
        const initialProv  = this._activeProv;
        const initialModel = this._activeModel;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpecKit Chat</title>
<style>
/* ── Reset & base ────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
  font-size: 13px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  display: flex;
  flex-direction: column;
}

/* ── Top bar ─────────────────────────────────────── */
.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.topbar-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--vscode-foreground);
  margin-right: 4px;
}
.topbar-title span { color: var(--vscode-badge-background); }
.sel {
  padding: 3px 8px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  height: 26px;
}
.model-input {
  padding: 3px 8px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  width: 160px;
  height: 26px;
}
.model-input:focus { outline: 1px solid var(--vscode-focusBorder); }
.spacer { flex: 1; }
.icon-btn {
  background: none; border: none; cursor: pointer;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  padding: 3px 6px; border-radius: 4px; font-size: 14px;
  display: flex; align-items: center;
}
.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn[title] { cursor: pointer; }

/* ── Messages area ───────────────────────────────── */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.messages::-webkit-scrollbar { width: 6px; }
.messages::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }

/* ── Message rows ────────────────────────────────── */
.msg-row {
  display: flex;
  padding: 4px 16px;
  gap: 10px;
  animation: fadein 0.18s ease;
}
@keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
.msg-row.user { flex-direction: row-reverse; }
.msg-row.system { justify-content: center; padding: 6px 16px; }

.avatar {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; flex-shrink: 0; margin-top: 2px;
}
.msg-row.user .avatar {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.msg-row.assistant .avatar {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.bubble {
  max-width: 78%;
  border-radius: 10px;
  padding: 10px 14px;
  line-height: 1.6;
  word-break: break-word;
}
.msg-row.user .bubble {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-bottom-right-radius: 3px;
}
.msg-row.assistant .bubble {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-panel-border);
  border-bottom-left-radius: 3px;
  max-width: 90%;
}
.msg-row.system .bubble {
  background: none;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  padding: 2px 0;
  border: none;
}
.bubble code {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
  padding: 1px 5px; border-radius: 3px; font-size: 11.5px;
}

/* ── File change cards ───────────────────────────── */
.file-card {
  margin-top: 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 12px;
}
.file-card-header {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px;
  background: var(--vscode-sideBar-background);
  cursor: pointer;
  user-select: none;
}
.file-card-header:hover { background: var(--vscode-list-hoverBackground); }
.file-icon { font-size: 13px; }
.file-path {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px; flex: 1; color: var(--vscode-foreground);
}
.file-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
.file-chevron { color: var(--vscode-descriptionForeground); font-size: 10px; transition: transform .15s; }
.file-chevron.open { transform: rotate(90deg); }

.file-preview { display: none; border-top: 1px solid var(--vscode-panel-border); }
.file-preview.open { display: block; }
.file-preview pre {
  margin: 0; padding: 10px 14px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px; line-height: 1.5;
  background: var(--vscode-editor-background);
  white-space: pre;
  max-height: 320px; overflow-y: auto;
}
.file-actions {
  display: flex; gap: 8px; align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}
.btn-accept {
  padding: 4px 14px; border-radius: 4px; border: none; cursor: pointer;
  font-size: 12px; font-family: inherit; font-weight: 500;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn-accept:hover:not(:disabled) { opacity: 0.85; }
.btn-accept:disabled { opacity: 0.5; cursor: default; }
.btn-deny {
  padding: 4px 14px; border-radius: 4px; cursor: pointer;
  font-size: 12px; font-family: inherit; font-weight: 500;
  background: transparent;
  border: 1px solid var(--vscode-errorForeground, #f44);
  color: var(--vscode-errorForeground, #f44);
}
.btn-deny:hover:not(:disabled) { opacity: 0.7; }
.btn-deny:disabled { opacity: 0.4; cursor: default; }
.file-status {
  font-size: 11px; margin-left: auto;
  color: var(--vscode-descriptionForeground);
}
.file-card.accepted .file-card-header { opacity: 0.65; }
.file-card.denied   .file-card-header { opacity: 0.4; }
.file-card.denied pre { opacity: 0.35; }

/* ── Thinking indicator ──────────────────────────── */
.thinking {
  display: none; align-items: center; gap: 10px;
  padding: 8px 16px;
}
.thinking.on { display: flex; }
.dots span {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: var(--vscode-badge-background); margin: 0 2px;
  animation: bounce 1.2s infinite;
}
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40%           { transform: translateY(-5px); opacity: 1; }
}
.thinking-label { font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ── Input area ──────────────────────────────────── */
.input-area {
  border-top: 1px solid var(--vscode-panel-border);
  padding: 10px 12px;
  background: var(--vscode-sideBar-background);
  flex-shrink: 0;
}
.input-wrap {
  display: flex; gap: 8px; align-items: flex-end;
}
.input-box {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-family: inherit; font-size: 13px;
  resize: none; outline: none;
  line-height: 1.5;
  min-height: 38px; max-height: 180px;
  overflow-y: auto;
}
.input-box:focus { border-color: var(--vscode-focusBorder); }
.input-box::placeholder { color: var(--vscode-input-placeholderForeground); }
.send-btn {
  width: 36px; height: 36px; border-radius: 8px; border: none; cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 16px; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.send-btn:hover:not(:disabled) { opacity: 0.85; }
.send-btn:disabled { opacity: 0.4; cursor: default; }
.input-hint {
  font-size: 10px; color: var(--vscode-descriptionForeground);
  margin-top: 5px; text-align: right;
}
</style>
</head>
<body>

<!-- Top bar: title + provider + model selector -->
<div class="topbar">
  <span class="topbar-title">⚡ <span>SpecKit</span> Chat</span>
  <select class="sel" id="provider-sel" title="AI Provider">
    ${providerOptions.map(p =>
      `<option value="${p.id}" ${p.id === initialProv ? 'selected' : ''}>${p.label}</option>`
    ).join('\n    ')}
  </select>
  <input class="model-input" id="model-input" type="text"
         value="${initialModel.replace(/"/g, '&quot;')}"
         placeholder="model name" title="Model name / deployment" />
  <div class="spacer"></div>
  <button class="icon-btn" title="Clear conversation" onclick="clearChat()">🗑</button>
</div>

<!-- Messages -->
<div class="messages" id="messages"></div>

<!-- Thinking -->
<div class="thinking" id="thinking">
  <div class="dots"><span></span><span></span><span></span></div>
  <span class="thinking-label" id="thinking-label">SpecKit is thinking…</span>
</div>

<!-- Input -->
<div class="input-area">
  <div class="input-wrap">
    <textarea class="input-box" id="input" rows="1"
      placeholder="Ask anything… (Enter to send, Shift+Enter for new line)"></textarea>
    <button class="send-btn" id="send-btn" title="Send" onclick="sendMessage()">➤</button>
  </div>
  <div class="input-hint">Enter to send · Shift+Enter for new line</div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();

  /* ── State ──────────────────────────────────────── */
  const providerModels = ${JSON.stringify(Object.fromEntries(providerOptions.map(p => [p.id, p.model])))};
  const fileStore      = new Map(); // fileId → {path, content}
  const pendingWrites  = new Map(); // filePath → {acceptBtn, card, statusEl}
  let   fileIdCounter  = 0;
  let   busy           = false;

  /* ── DOM refs ────────────────────────────────────── */
  const messagesEl   = document.getElementById('messages');
  const inputEl      = document.getElementById('input');
  const sendBtn      = document.getElementById('send-btn');
  const thinkingEl   = document.getElementById('thinking');
  const thinkLabelEl = document.getElementById('thinking-label');
  const providerSel  = document.getElementById('provider-sel');
  const modelInput   = document.getElementById('model-input');

  /* ── Provider selector ───────────────────────────── */
  providerSel.addEventListener('change', () => {
    modelInput.value = providerModels[providerSel.value] || '';
    vscode.postMessage({ type: 'providerChange', provider: providerSel.value, model: modelInput.value });
  });

  /* ── Send message ────────────────────────────────── */
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    addMessage('user', text);
    inputEl.value = '';
    autoResize();
    vscode.postMessage({
      type: 'send',
      text,
      provider: providerSel.value,
      model:    modelInput.value.trim(),
    });
  }

  /* ── Add a message row ───────────────────────────── */
  function addMessage(role, text, fileBlocks) {
    const row = document.createElement('div');
    row.className = 'msg-row ' + role;

    if (role !== 'system') {
      const av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = role === 'user' ? '👤' : '⚡';
      row.appendChild(av);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (text) {
      const t = document.createElement('div');
      t.innerHTML = renderText(text);
      bubble.appendChild(t);
    }

    if (fileBlocks && fileBlocks.length) {
      for (const fb of fileBlocks) bubble.appendChild(buildFileCard(fb));
    }

    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollEnd();
  }

  /* ── File change card ────────────────────────────── */
  function buildFileCard(file) {
    const id      = ++fileIdCounter;
    fileStore.set(id, file);

    const lines   = file.content.split('\\n');
    const preview = lines.slice(0, 250).join('\\n');
    const more    = lines.length > 250 ? '\\n… (' + (lines.length - 250) + ' more lines)' : '';
    const lineStr = lines.length + ' line' + (lines.length !== 1 ? 's' : '');

    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.fileid = id;

    card.innerHTML =
      '<div class="file-card-header" onclick="togglePreview(' + id + ')">' +
        '<span class="file-icon">📄</span>' +
        '<span class="file-path">' + esc(file.path) + '</span>' +
        '<span class="file-meta">' + lineStr + '</span>' +
        '<span class="file-chevron" id="chev-' + id + '">▶</span>' +
      '</div>' +
      '<div class="file-preview" id="prev-' + id + '">' +
        '<pre><code>' + esc(preview) + esc(more) + '</code></pre>' +
      '</div>' +
      '<div class="file-actions">' +
        '<button class="btn-accept" id="acc-' + id + '" onclick="acceptFile(' + id + ')">✅ Accept</button>' +
        '<button class="btn-deny"   id="den-' + id + '" onclick="denyFile('  + id + ')">❌ Deny</button>' +
        '<span class="file-status" id="sta-' + id + '"></span>' +
      '</div>';

    return card;
  }

  function togglePreview(id) {
    document.getElementById('prev-' + id).classList.toggle('open');
    document.getElementById('chev-' + id).classList.toggle('open');
  }

  function acceptFile(id) {
    const file    = fileStore.get(id);
    const accBtn  = document.getElementById('acc-' + id);
    const denBtn  = document.getElementById('den-' + id);
    const statEl  = document.getElementById('sta-' + id);
    const card    = accBtn.closest('.file-card');
    if (!file || accBtn.disabled) return;

    accBtn.disabled = true;
    denBtn.disabled = true;
    accBtn.textContent = '⏳ Writing…';
    pendingWrites.set(file.path, { accBtn, denBtn, statEl, card });
    vscode.postMessage({ type: 'writeFile', filePath: file.path, content: file.content });
  }

  function denyFile(id) {
    const accBtn = document.getElementById('acc-' + id);
    const denBtn = document.getElementById('den-' + id);
    const statEl = document.getElementById('sta-' + id);
    const card   = denBtn.closest('.file-card');
    accBtn.disabled = true;
    denBtn.disabled = true;
    denBtn.textContent = '✖ Denied';
    statEl.textContent = 'Not applied';
    card.classList.add('denied');
  }

  /* ── Text renderer ────────────────────────────────── */
  function renderText(raw) {
    // Inline code
    let out = esc(raw).replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    // Bold
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Line breaks
    out = out.replace(/\\n/g, '<br>');
    return out;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function scrollEnd() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  function clearChat() {
    messagesEl.innerHTML = '';
    fileIdCounter = 0;
    fileStore.clear();
    pendingWrites.clear();
    vscode.postMessage({ type: 'clearHistory' });
  }

  /* ── Key handlers ─────────────────────────────────── */
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputEl.addEventListener('input', autoResize);

  /* ── Messages from extension ──────────────────────── */
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {

      case 'system':
        addMessage('system', msg.text);
        break;

      case 'thinking':
        busy = msg.on;
        thinkingEl.classList.toggle('on', msg.on);
        sendBtn.disabled = msg.on;
        if (msg.on) {
          thinkLabelEl.textContent = (providerSel.options[providerSel.selectedIndex].text.trim()) + ' is thinking…';
          scrollEnd();
        }
        break;

      case 'response':
        addMessage('assistant', msg.text, msg.fileBlocks);
        break;

      case 'error':
        addMessage('system', '⚠️ ' + msg.message);
        break;

      case 'writeResult': {
        const p = pendingWrites.get(msg.filePath);
        if (!p) break;
        if (msg.ok) {
          p.accBtn.textContent = '✅ Written';
          p.statEl.textContent = 'Applied to workspace';
          p.card.classList.add('accepted');
        } else {
          p.accBtn.textContent = '❌ Failed';
          p.accBtn.disabled = false;
          p.denBtn.disabled = false;
          p.statEl.textContent = msg.error || 'Write failed';
        }
        pendingWrites.delete(msg.filePath);
        break;
      }
    }
  });

  /* ── Expose for inline onclick ─────────────────────── */
  window.togglePreview = togglePreview;
  window.acceptFile    = acceptFile;
  window.denyFile      = denyFile;
  window.clearChat     = clearChat;
  window.sendMessage   = sendMessage;
})();
</script>
</body>
</html>`;
    }
}

module.exports = { ChatPanel };
