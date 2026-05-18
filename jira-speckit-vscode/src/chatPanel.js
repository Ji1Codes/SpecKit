// chatPanel.js — SpecKit Chat (Copilot-style UI)
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const { getWorkspaceContext } = require('./workspaceScanner');

const PROVIDER_DEFAULTS = {
    'azure-openai': { label: 'Azure OpenAI', modelKey: 'azureOpenAiDeployment', fallback: 'gpt-4.1' },
    'openai':       { label: 'OpenAI',        modelKey: 'openAiModel',           fallback: 'gpt-4o'  },
    'anthropic':    { label: 'Anthropic',     modelKey: 'anthropicModel',        fallback: 'claude-opus-4-5' },
    'google':       { label: 'Google Gemini', modelKey: 'googleModel',           fallback: 'gemini-2.0-flash' },
    'custom':       { label: 'Custom / Local',modelKey: 'customApiModel',        fallback: '' },
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
        this._history  = [];
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

        getWorkspaceContext(12000).then(ctx => {
            this._wsCtx = ctx || '';
            this._post({ type: 'system', text: this._wsCtx ? 'Workspace context loaded.' : 'No workspace files found.' });
        }).catch(() => { this._wsCtx = ''; });
    }

    _post(msg) {
        try { this._panel.webview.postMessage(msg); } catch { /* panel closed */ }
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'send':         return this._handleChat(msg.text, msg.provider, msg.model);
            case 'writeFile':    return this._writeFile(msg.filePath, msg.content);
            case 'clearHistory': this._history = []; return;
            case 'providerChange':
                this._activeProv  = msg.provider;
                this._activeModel = msg.model;
                return;
        }
    }

    async _handleChat(userText, provider, model) {
        this._activeProv  = provider;
        this._activeModel = model;
        this._post({ type: 'thinking', on: true });

        const systemPrompt = [
            'You are SpecKit — an expert AI software engineer assistant embedded in VS Code.',
            'You have full access to the user\'s workspace files listed below.',
            'You can explain code, answer questions about the codebase, and make changes to files.',
            '',
            'RULES:',
            '- Always use the workspace context to answer questions about the code — never say you cannot see the files.',
            '- When the user asks to change something, look up the relevant file(s) from the workspace context and modify them.',
            '  You do NOT need the user to specify which file to edit — infer it from context.',
            '- If a change spans multiple files, output all of them.',
            '- Use markdown for all responses. Use fenced code blocks with language tags for inline examples.',
            '- When outputting full file changes (new or modified), use EXACTLY this format — one block per file:',
            '===FILE:relative/path/to/file===',
            '<complete updated file contents>',
            '===ENDFILE===',
            '  The path must be relative to the workspace root. Always output the COMPLETE file, not just the diff.',
            '',
            this._wsCtx ? 'WORKSPACE CONTEXT:\n' + this._wsCtx : '(no workspace files found)',
        ].filter(Boolean).join('\n');

        // Trim history to last 20 messages to avoid exceeding context window
        if (this._history.length > 20) {
            this._history = this._history.slice(this._history.length - 20);
        }

        this._history.push({ role: 'user', content: userText });

        try {
            const raw = await this._pipeline.chatWith(
                [{ role: 'system', content: systemPrompt }, ...this._history],
                provider, model
            );

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
            this._post({ type: 'writeResult', filePath, ok: false, error: 'No workspace folder open' });
            return;
        }
        const absPath = path.join(folders[0].uri.fsPath, filePath);
        try {
            const dir = path.dirname(absPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            this._post({ type: 'writeResult', filePath, ok: true, absPath });
            vscode.window.showInformationMessage('SpecKit wrote: ' + absPath);
            vscode.workspace.openTextDocument(absPath).then(function(doc) {
                vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
            });
        } catch (err) {
            this._post({ type: 'writeResult', filePath, ok: false, error: err.message });
            vscode.window.showErrorMessage('SpecKit: could not write ' + filePath + ': ' + err.message);
        }
    }

    _buildHtml() {
        const cfg = vscode.workspace.getConfiguration('jiraSpeckit');
        const provOpts = Object.entries(PROVIDER_DEFAULTS).map(([id, p]) => ({
            id,
            label: p.label,
            model: cfg.get(p.modelKey || '') || p.fallback,
        }));
        const initProv    = this._activeProv;
        const initModel   = (this._activeModel || '').replace(/"/g, '&quot;');
        const provOptHtml = provOpts
            .map(p => '<option value="' + p.id + '"' + (p.id === initProv ? ' selected' : '') + '>' + p.label + '</option>')
            .join('');
        const modelsJson  = JSON.stringify(Object.fromEntries(provOpts.map(p => [p.id, p.model])));
        const nonce = [...Array(32)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.random()*62|0]).join('');
        return buildHtml(provOptHtml, initModel, modelsJson, nonce);
    }
}

/* ─── HTML builder (no nested template literals) ─────────────────────── */
function buildHtml(provOptHtml, initModel, modelsJson, nonce) {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
        '<meta charset="UTF-8">\n' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\' \'unsafe-inline\';">\n' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
        '<title>SpecKit Chat</title>\n' +
        getChatCSS() +
        '</head>\n<body>\n' +
        getChatBody(provOptHtml, initModel) +
        '<script nonce="' + nonce + '">\n' + getChatScript(modelsJson) + '\n</script>\n' +
        '</body>\n</html>';
}

function getChatCSS() {
    return '<style>\n' +
'*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}\n' +
'html,body{height:100%;overflow:hidden}\n' +
'body{\n' +
'  font-family:var(--vscode-font-family,-apple-system,"Segoe UI",sans-serif);\n' +
'  font-size:13px;\n' +
'  color:var(--vscode-foreground);\n' +
'  background:var(--vscode-sideBar-background,var(--vscode-editor-background));\n' +
'  display:flex;flex-direction:column;height:100vh;\n' +
'}\n' +

/* topbar */
'.topbar{\n' +
'  display:flex;align-items:center;gap:6px;\n' +
'  padding:5px 10px;\n' +
'  border-bottom:1px solid var(--vscode-panel-border);\n' +
'  background:var(--vscode-titleBar-activeBackground,var(--vscode-sideBar-background));\n' +
'  flex-shrink:0;\n' +
'}\n' +
'.topbar-logo{font-weight:700;font-size:13px;color:var(--vscode-textLink-foreground,#4af);letter-spacing:-.3px}\n' +
'.topbar-sep{color:var(--vscode-panel-border);margin:0 2px;font-size:11px}\n' +
'.topbar-right{display:flex;align-items:center;gap:4px;margin-left:auto}\n' +
'.prov-sel{\n' +
'  padding:2px 5px;height:22px;\n' +
'  border:1px solid var(--vscode-dropdown-border,var(--vscode-panel-border));\n' +
'  background:var(--vscode-dropdown-background);\n' +
'  color:var(--vscode-dropdown-foreground,var(--vscode-foreground));\n' +
'  border-radius:3px;font-size:11px;font-family:inherit;cursor:pointer;\n' +
'}\n' +
'.model-inp{\n' +
'  padding:2px 6px;height:22px;width:140px;\n' +
'  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));\n' +
'  background:var(--vscode-input-background);\n' +
'  color:var(--vscode-input-foreground);\n' +
'  border-radius:3px;font-size:11px;\n' +
'  font-family:var(--vscode-editor-font-family,monospace);\n' +
'}\n' +
'.model-inp:focus,.prov-sel:focus{outline:1px solid var(--vscode-focusBorder)}\n' +
'.icon-btn{\n' +
'  background:none;border:none;cursor:pointer;\n' +
'  color:var(--vscode-icon-foreground,var(--vscode-foreground));\n' +
'  padding:2px 5px;border-radius:3px;font-size:14px;line-height:1;\n' +
'}\n' +
'.icon-btn:hover{background:var(--vscode-toolbar-hoverBackground)}\n' +

/* messages */
'.msgs{\n' +
'  flex:1;overflow-y:auto;\n' +
'  display:flex;flex-direction:column;\n' +
'  padding:0;\n' +
'}\n' +
'.msgs::-webkit-scrollbar{width:5px}\n' +
'.msgs::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}\n' +
'.msg{\n' +
'  padding:12px 16px;\n' +
'  border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.08));\n' +
'  animation:fi .12s ease;\n' +
'}\n' +
'.msg:first-child{border-top:none}\n' +
'@keyframes fi{from{opacity:0;transform:translateY(3px)}to{opacity:1}}\n' +
'.msg.user{background:var(--vscode-editor-background)}\n' +
'.msg.assistant{background:var(--vscode-sideBar-background)}\n' +
'.msg.system{\n' +
'  padding:5px 16px;\n' +
'  font-size:11px;\n' +
'  color:var(--vscode-descriptionForeground);\n' +
'  text-align:center;\n' +
'  border-top:none;\n' +
'  background:none;\n' +
'}\n' +
'.msg.error{\n' +
'  padding:8px 16px;\n' +
'  font-size:12px;\n' +
'  color:var(--vscode-errorForeground,#f88);\n' +
'  background:none;\n' +
'}\n' +
'.msg-hdr{\n' +
'  display:flex;align-items:center;gap:6px;\n' +
'  margin-bottom:6px;\n' +
'  font-size:11px;font-weight:600;\n' +
'  color:var(--vscode-descriptionForeground);\n' +
'  text-transform:uppercase;letter-spacing:.5px;\n' +
'}\n' +
'.msg-icon{\n' +
'  width:16px;height:16px;border-radius:50%;\n' +
'  display:flex;align-items:center;justify-content:center;\n' +
'  font-size:9px;font-weight:700;flex-shrink:0;\n' +
'}\n' +
'.msg.user .msg-icon{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}\n' +
'.msg.assistant .msg-icon{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}\n' +

/* markdown content */
'.md{line-height:1.65;word-break:break-word}\n' +
'.md p{margin:0 0 8px}\n' +
'.md p:last-child{margin-bottom:0}\n' +
'.md h1,.md h2,.md h3{font-weight:600;line-height:1.3;margin:10px 0 5px;color:var(--vscode-foreground)}\n' +
'.md h1{font-size:16px}.md h2{font-size:14px}.md h3{font-size:13px}\n' +
'.md ul,.md ol{margin:4px 0 8px 18px}\n' +
'.md li{margin:2px 0}\n' +
'.md strong{font-weight:600}\n' +
'.md em{font-style:italic}\n' +
'.md del{text-decoration:line-through;opacity:.6}\n' +
'.md blockquote{\n' +
'  border-left:3px solid var(--vscode-textBlockQuote-border,var(--vscode-textLink-foreground,#4af));\n' +
'  padding-left:10px;margin:6px 0;\n' +
'  color:var(--vscode-textBlockQuote-foreground,var(--vscode-descriptionForeground));\n' +
'}\n' +
'.md code{\n' +
'  font-family:var(--vscode-editor-font-family,"Cascadia Code",monospace);\n' +
'  font-size:11.5px;\n' +
'  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.15));\n' +
'  padding:1px 5px;border-radius:3px;\n' +
'}\n' +
'.md a{color:var(--vscode-textLink-foreground);text-decoration:none}\n' +
'.md a:hover{text-decoration:underline}\n' +

/* code blocks */
'.codeblock{\n' +
'  margin:8px 0;\n' +
'  border:1px solid var(--vscode-panel-border);\n' +
'  border-radius:5px;overflow:hidden;\n' +
'}\n' +
'.codeblock-hdr{\n' +
'  display:flex;align-items:center;justify-content:space-between;\n' +
'  padding:4px 10px;\n' +
'  background:var(--vscode-editorGroupHeader-tabsBackground,rgba(128,128,128,.1));\n' +
'  border-bottom:1px solid var(--vscode-panel-border);\n' +
'}\n' +
'.codelang{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;color:var(--vscode-descriptionForeground)}\n' +
'.copybtn{\n' +
'  background:none;border:none;cursor:pointer;\n' +
'  font-size:11px;font-family:inherit;\n' +
'  color:var(--vscode-descriptionForeground);\n' +
'  padding:2px 6px;border-radius:3px;\n' +
'}\n' +
'.copybtn:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}\n' +
'.codeblock pre{\n' +
'  margin:0;padding:10px 12px;\n' +
'  overflow-x:auto;\n' +
'  font-family:var(--vscode-editor-font-family,"Cascadia Code",monospace);\n' +
'  font-size:12px;line-height:1.5;\n' +
'  background:var(--vscode-editor-background);\n' +
'  white-space:pre;\n' +
'}\n' +

/* file cards */
'.fc{\n' +
'  margin:8px 0;\n' +
'  border:1px solid var(--vscode-panel-border);\n' +
'  border-radius:5px;overflow:hidden;\n' +
'}\n' +
'.fc-hdr{\n' +
'  display:flex;align-items:center;gap:7px;\n' +
'  padding:7px 11px;\n' +
'  background:var(--vscode-editorGroupHeader-tabsBackground,rgba(128,128,128,.08));\n' +
'  cursor:pointer;user-select:none;\n' +
'}\n' +
'.fc-hdr:hover{background:var(--vscode-list-hoverBackground)}\n' +
'.fc-name{\n' +
'  font-family:var(--vscode-editor-font-family,monospace);\n' +
'  font-size:12px;flex:1;\n' +
'  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;\n' +
'}\n' +
'.fc-meta{font-size:11px;color:var(--vscode-descriptionForeground);flex-shrink:0}\n' +
'.fc-chev{font-size:9px;color:var(--vscode-descriptionForeground);transition:transform .15s;flex-shrink:0}\n' +
'.fc-chev.open{transform:rotate(90deg)}\n' +
'.fc-pre{display:none;border-top:1px solid var(--vscode-panel-border)}\n' +
'.fc-pre.open{display:block}\n' +
'.fc-pre pre{\n' +
'  margin:0;padding:9px 12px;\n' +
'  font-family:var(--vscode-editor-font-family,monospace);\n' +
'  font-size:11.5px;line-height:1.5;\n' +
'  overflow:auto;max-height:220px;\n' +
'  background:var(--vscode-editor-background);white-space:pre;\n' +
'}\n' +
'.fc-foot{\n' +
'  display:flex;align-items:center;gap:7px;\n' +
'  padding:6px 11px;\n' +
'  border-top:1px solid var(--vscode-panel-border);\n' +
'  background:var(--vscode-editorGroupHeader-tabsBackground,rgba(128,128,128,.08));\n' +
'}\n' +
'.fc-stat{\n' +
'  font-size:11px;color:var(--vscode-descriptionForeground);\n' +
'  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;\n' +
'}\n' +
'.btn-acc,.btn-den{\n' +
'  padding:3px 12px;border-radius:3px;border:none;\n' +
'  cursor:pointer;font-size:12px;font-family:inherit;font-weight:500;\n' +
'}\n' +
'.btn-acc{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}\n' +
'.btn-acc:hover:not(:disabled){opacity:.85}\n' +
'.btn-acc:disabled{opacity:.5;cursor:default}\n' +
'.btn-den{\n' +
'  background:transparent;\n' +
'  border:1px solid var(--vscode-errorForeground,#c44);\n' +
'  color:var(--vscode-errorForeground,#c44);\n' +
'}\n' +
'.btn-den:hover:not(:disabled){opacity:.7}\n' +
'.btn-den:disabled{opacity:.4;cursor:default}\n' +
'.fc.accepted{opacity:.65}\n' +
'.fc.denied{opacity:.4}\n' +

/* thinking */
'.thinking{\n' +
'  display:none;align-items:center;gap:8px;\n' +
'  padding:8px 16px;\n' +
'  font-size:12px;color:var(--vscode-descriptionForeground);\n' +
'  border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.08));\n' +
'}\n' +
'.thinking.on{display:flex}\n' +
'.dots{display:flex;gap:3px}\n' +
'.dots span{\n' +
'  width:5px;height:5px;border-radius:50%;\n' +
'  background:var(--vscode-badge-background);\n' +
'  animation:pulse 1.4s ease-in-out infinite;\n' +
'}\n' +
'.dots span:nth-child(2){animation-delay:.2s}\n' +
'.dots span:nth-child(3){animation-delay:.4s}\n' +
'@keyframes pulse{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}\n' +

/* input */
'.inp-area{\n' +
'  border-top:1px solid var(--vscode-panel-border);\n' +
'  padding:8px;\n' +
'  background:var(--vscode-sideBar-background);\n' +
'  flex-shrink:0;\n' +
'}\n' +
'.inp-wrap{\n' +
'  display:flex;align-items:flex-end;gap:5px;\n' +
'  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));\n' +
'  border-radius:6px;\n' +
'  background:var(--vscode-input-background);\n' +
'  padding:4px 4px 4px 10px;\n' +
'}\n' +
'.inp-wrap:focus-within{border-color:var(--vscode-focusBorder)}\n' +
'.inp{\n' +
'  flex:1;background:none;border:none;outline:none;\n' +
'  color:var(--vscode-input-foreground);\n' +
'  font-family:inherit;font-size:13px;\n' +
'  resize:none;line-height:1.5;\n' +
'  min-height:22px;max-height:140px;\n' +
'  overflow-y:auto;padding:3px 0;\n' +
'}\n' +
'.inp::placeholder{color:var(--vscode-input-placeholderForeground)}\n' +
'.send-btn{\n' +
'  width:28px;height:28px;border:none;border-radius:4px;cursor:pointer;\n' +
'  background:var(--vscode-button-background);color:var(--vscode-button-foreground);\n' +
'  display:flex;align-items:center;justify-content:center;\n' +
'  font-size:15px;flex-shrink:0;\n' +
'}\n' +
'.send-btn:hover:not(:disabled){opacity:.85}\n' +
'.send-btn:disabled{opacity:.3;cursor:default}\n' +
'.inp-hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px;padding:0 2px;display:flex;justify-content:space-between}\n' +
'</style>\n';
}

function getChatBody(provOptHtml, initModel) {
    return '<div class="topbar">\n' +
'  <span class="topbar-logo">SpecKit</span>\n' +
'  <span class="topbar-sep">|</span>\n' +
'  <span style="font-size:11px;color:var(--vscode-descriptionForeground)">Chat</span>\n' +
'  <div class="topbar-right">\n' +
'    <select class="prov-sel" id="provSel">' + provOptHtml + '</select>\n' +
'    <input class="model-inp" id="modelInp" type="text" value="' + initModel + '" placeholder="model" />\n' +
'    <button class="icon-btn" id="clearBtn" title="New conversation">&#x2B;</button>\n' +
'  </div>\n' +
'</div>\n' +
'<div class="msgs" id="msgs"></div>\n' +
'<div class="thinking" id="thinking">\n' +
'  <div class="dots"><span></span><span></span><span></span></div>\n' +
'  <span id="thinkLbl">Thinking\u2026</span>\n' +
'</div>\n' +
'<div class="inp-area">\n' +
'  <div class="inp-wrap">\n' +
'    <textarea class="inp" id="inp" rows="1" placeholder="Ask SpecKit\u2026 (Enter to send, Shift+Enter for new line)"></textarea>\n' +
'    <button class="send-btn" id="sendBtn" title="Send">&#x27A4;</button>\n' +
'  </div>\n' +
'  <div class="inp-hint"><span>Enter&#160;&#183;&#160;send&#160;&#160;&#160;Shift+Enter&#160;&#183;&#160;new line</span><span id="provLbl"></span></div>\n' +
'</div>\n';
}

function getChatScript(modelsJson) {
    return '(function(){\n' +
'"use strict";\n' +
'var vscode=acquireVsCodeApi();\n' +
'var MODELS=' + modelsJson + ';\n' +
'var fileStore={};\n' +
'var pending={};\n' +
'var fid=0;\n' +
'var busy=false;\n' +
'var msgsEl=document.getElementById("msgs");\n' +
'var inpEl=document.getElementById("inp");\n' +
'var sendBtn=document.getElementById("sendBtn");\n' +
'var clearBtn=document.getElementById("clearBtn");\n' +
'var thinkEl=document.getElementById("thinking");\n' +
'var thinkLbl=document.getElementById("thinkLbl");\n' +
'var provSel=document.getElementById("provSel");\n' +
'var modelInp=document.getElementById("modelInp");\n' +
'var provLbl=document.getElementById("provLbl");\n' +
'\n' +
'function updProvLbl(){\n' +
'  var o=provSel.options[provSel.selectedIndex];\n' +
'  if(provLbl)provLbl.textContent=o?o.text.trim():"";\n' +
'}\n' +
'updProvLbl();\n' +
'\n' +
'/* ── Markdown renderer ── */\n' +
'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n' +
'function escA(s){return esc(s).replace(/"/g,"&quot;");}\n' +
'\n' +
'function inlineMd(s){\n' +
'  s=esc(s);\n' +
'  /* bold+italic */ s=s.replace(/\\*\\*\\*([^*]+)\\*\\*\\*/g,"<strong><em>$1</em></strong>");\n' +
'  /* bold */        s=s.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>");\n' +
'  /* italic */      s=s.replace(/\\*([^*\\n]+)\\*/g,"<em>$1</em>");\n' +
'  /* strikethrough */s=s.replace(/~~([^~]+)~~/g,"<del>$1</del>");\n' +
'  /* inline code: split on backtick pairs */\n' +
'  var parts=s.split("&#96;");\n' +
'  if(parts.length>1){\n' +
'    var r="";\n' +
'    for(var i=0;i<parts.length;i++){\n' +
'      if(i%2===0)r+=parts[i];\n' +
'      else r+="<code>"+parts[i]+"</code>";\n' +
'    }\n' +
'    s=r;\n' +
'  }\n' +
'  return s;\n' +
'}\n' +
'\n' +
'function renderMd(raw){\n' +
'  var lines=raw.split("\\n");\n' +
'  var out="";\n' +
'  var i=0;\n' +
'  var inUl=false,inOl=false;\n' +
'  function closeList(){if(inUl){out+="</ul>";inUl=false;}if(inOl){out+="</ol>";inOl=false;}}\n' +
'  while(i<lines.length){\n' +
'    var line=lines[i];\n' +
'    /* fenced code block */\n' +
'    if(/^```/.test(line)){\n' +
'      closeList();\n' +
'      var lang=(line.slice(3).trim()||"");\n' +
'      var code=[];\n' +
'      i++;\n' +
'      while(i<lines.length&&!/^```/.test(lines[i])){code.push(lines[i]);i++;}\n' +
'      var codeText=code.join("\\n");\n' +
'      out+=\'<div class="codeblock"><div class="codeblock-hdr">\';\n' +
'      out+=\'<span class="codelang">\'+esc(lang||"code")+\'</span>\';\n' +
'      out+=\'<button class="copybtn" data-code="\'+escA(codeText)+\'">Copy</button>\';\n' +
'      out+=\'</div><pre>\'+esc(codeText)+\'</pre></div>\';\n' +
'      i++;continue;\n' +
'    }\n' +
'    /* heading */\n' +
'    var hm=line.match(/^(#{1,3})\\s+(.+)$/);\n' +
'    if(hm){closeList();var lv=hm[1].length;out+="<h"+lv+" class=\'md\'>"+inlineMd(hm[2])+"</h"+lv+">";i++;continue;}\n' +
'    /* blockquote */\n' +
'    if(/^>\\s*/.test(line)){closeList();out+=\'<blockquote>\'+inlineMd(line.replace(/^>\\s*/,""))+\'</blockquote>\';i++;continue;}\n' +
'    /* bullet list */\n' +
'    var ulm=line.match(/^[-*+]\\s+(.+)$/);\n' +
'    if(ulm){if(!inUl){closeList();out+="<ul>";inUl=true;}out+="<li>"+inlineMd(ulm[1])+"</li>";i++;continue;}\n' +
'    /* numbered list */\n' +
'    var olm=line.match(/^\\d+\\.\\s+(.+)$/);\n' +
'    if(olm){if(!inOl){closeList();out+="<ol>";inOl=true;}out+="<li>"+inlineMd(olm[1])+"</li>";i++;continue;}\n' +
'    /* blank line */\n' +
'    if(line.trim()===""){closeList();out+="<br>";i++;continue;}\n' +
'    /* paragraph */\n' +
'    closeList();out+=\'<p>\'+inlineMd(line)+\'</p>\';i++;\n' +
'  }\n' +
'  closeList();\n' +
'  return out;\n' +
'}\n' +
'\n' +
'/* ── Message rendering ── */\n' +
'function addMsg(role,text,fbs){\n' +
'  var div=document.createElement("div");\n' +
'  div.className="msg "+role;\n' +
'  if(role==="user"||role==="assistant"){\n' +
'    var hdr=document.createElement("div");\n' +
'    hdr.className="msg-hdr";\n' +
'    var icon=document.createElement("div");\n' +
'    icon.className="msg-icon";\n' +
'    icon.textContent=role==="user"?"U":"SK";\n' +
'    var lbl=document.createElement("span");\n' +
'    lbl.textContent=role==="user"?"You":"SpecKit";\n' +
'    hdr.appendChild(icon);hdr.appendChild(lbl);\n' +
'    div.appendChild(hdr);\n' +
'  }\n' +
'  if(text){\n' +
'    var body=document.createElement("div");\n' +
'    body.className="md";\n' +
'    if(role==="user")body.innerHTML="<p>"+esc(text).replace(/\\n/g,"<br>")+"</p>";\n' +
'    else body.innerHTML=renderMd(text);\n' +
'    div.appendChild(body);\n' +
'  }\n' +
'  if(fbs&&fbs.length)for(var j=0;j<fbs.length;j++)div.appendChild(buildFC(fbs[j]));\n' +
'  msgsEl.appendChild(div);\n' +
'  scrollEnd();\n' +
'}\n' +
'\n' +
'/* ── File card ── */\n' +
'function buildFC(file){\n' +
'  var id=++fid;\n' +
'  fileStore[id]=file;\n' +
'  var lines=file.content.split("\\n");\n' +
'  var prev=lines.slice(0,200).join("\\n")+(lines.length>200?"\\n\\u2026 ("+(lines.length-200)+" more lines)":"");\n' +
'  var meta=lines.length+(lines.length===1?" line":" lines");\n' +
'  var card=document.createElement("div");card.className="fc";card.dataset.fcid=id;\n' +
'\n' +
'  var hdr=document.createElement("div");hdr.className="fc-hdr";hdr.dataset.action="toggle";hdr.dataset.id=id;\n' +
'  var ico=document.createElement("span");ico.textContent="\\u{1F4C4}";\n' +
'  var nm=document.createElement("span");nm.className="fc-name";nm.textContent=file.path;nm.title=file.path;\n' +
'  var mt=document.createElement("span");mt.className="fc-meta";mt.textContent=meta;\n' +
'  var cv=document.createElement("span");cv.className="fc-chev";cv.id="cv"+id;cv.innerHTML="&#9658;";\n' +
'  hdr.appendChild(ico);hdr.appendChild(nm);hdr.appendChild(mt);hdr.appendChild(cv);\n' +
'\n' +
'  var preWrap=document.createElement("div");preWrap.className="fc-pre";preWrap.id="fcpre"+id;\n' +
'  var pre=document.createElement("pre");pre.textContent=prev;\n' +
'  preWrap.appendChild(pre);\n' +
'\n' +
'  var foot=document.createElement("div");foot.className="fc-foot";\n' +
'  var accBtn=document.createElement("button");accBtn.className="btn-acc";accBtn.dataset.action="accept";accBtn.dataset.id=id;accBtn.id="acc"+id;accBtn.textContent="Accept";\n' +
'  var denBtn=document.createElement("button");denBtn.className="btn-den";denBtn.dataset.action="deny";denBtn.dataset.id=id;denBtn.id="den"+id;denBtn.textContent="Discard";\n' +
'  var stat=document.createElement("span");stat.className="fc-stat";stat.id="sta"+id;\n' +
'  foot.appendChild(accBtn);foot.appendChild(denBtn);foot.appendChild(stat);\n' +
'\n' +
'  card.appendChild(hdr);card.appendChild(preWrap);card.appendChild(foot);\n' +
'  return card;\n' +
'}\n' +
'\n' +
'/* ── Click delegation ── */\n' +
'document.addEventListener("click",function(e){\n' +
'  if(e.target.classList.contains("copybtn")){\n' +
'    var code=e.target.dataset.code||"";\n' +
'    try{navigator.clipboard.writeText(code).then(function(){var o=e.target.textContent;e.target.textContent="Copied!";setTimeout(function(){e.target.textContent=o;},1500);});}catch(_){}\n' +
'    return;\n' +
'  }\n' +
'  var el=e.target;\n' +
'  while(el&&el!==document.body){if(el.dataset&&el.dataset.action)break;el=el.parentElement;}\n' +
'  if(!el||!el.dataset||!el.dataset.action)return;\n' +
'  var act=el.dataset.action;\n' +
'  var id=parseInt(el.dataset.id,10);\n' +
'  if(act==="toggle"){var pw=document.getElementById("fcpre"+id);var cv=document.getElementById("cv"+id);if(pw)pw.classList.toggle("open");if(cv)cv.classList.toggle("open");}\n' +
'  else if(act==="accept")doAccept(id);\n' +
'  else if(act==="deny")doDeny(id);\n' +
'});\n' +
'\n' +
'function doAccept(id){\n' +
'  var file=fileStore[id];\n' +
'  var a=document.getElementById("acc"+id),d=document.getElementById("den"+id),s=document.getElementById("sta"+id);\n' +
'  if(!file||!a||a.disabled)return;\n' +
'  a.disabled=true;d.disabled=true;a.textContent="Writing\\u2026";\n' +
'  pending[file.path]={a:a,d:d,s:s,card:a.closest(".fc")};\n' +
'  vscode.postMessage({type:"writeFile",filePath:file.path,content:file.content});\n' +
'}\n' +
'function doDeny(id){\n' +
'  var a=document.getElementById("acc"+id),d=document.getElementById("den"+id),s=document.getElementById("sta"+id);\n' +
'  if(a)a.disabled=true;\n' +
'  if(d){d.disabled=true;d.textContent="Discarded";}\n' +
'  if(s)s.textContent="Not applied";\n' +
'  var card=d?d.closest(".fc"):null;if(card)card.classList.add("denied");\n' +
'}\n' +
'\n' +
'/* ── Send / clear ── */\n' +
'function doSend(){\n' +
'  var text=inpEl.value.trim();\n' +
'  if(!text||busy)return;\n' +
'  addMsg("user",text);\n' +
'  inpEl.value="";\n' +
'  autoResize();\n' +
'  vscode.postMessage({type:"send",text:text,provider:provSel.value,model:modelInp.value.trim()});\n' +
'}\n' +
'function doClear(){\n' +
'  msgsEl.innerHTML="";\n' +
'  fileStore={};pending={};fid=0;\n' +
'  vscode.postMessage({type:"clearHistory"});\n' +
'}\n' +
'sendBtn.addEventListener("click",doSend);\n' +
'clearBtn.addEventListener("click",doClear);\n' +
'inpEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();doSend();}});\n' +
'inpEl.addEventListener("input",autoResize);\n' +
'provSel.addEventListener("change",function(){modelInp.value=MODELS[provSel.value]||"";updProvLbl();vscode.postMessage({type:"providerChange",provider:provSel.value,model:modelInp.value});});\n' +
'\n' +
'function autoResize(){inpEl.style.height="auto";inpEl.style.height=Math.min(inpEl.scrollHeight,140)+"px";}\n' +
'function scrollEnd(){msgsEl.scrollTop=msgsEl.scrollHeight;}\n' +
'\n' +
'/* ── Extension messages ── */\n' +
'window.addEventListener("message",function(e){\n' +
'  var msg=e.data;\n' +
'  switch(msg.type){\n' +
'    case "system":addMsg("system",msg.text);break;\n' +
'    case "thinking":\n' +
'      busy=!!msg.on;\n' +
'      thinkEl.classList.toggle("on",busy);\n' +
'      sendBtn.disabled=busy;\n' +
'      if(busy){\n' +
'        var o=provSel.options[provSel.selectedIndex];\n' +
'        thinkLbl.textContent=(o?o.text.trim():"SpecKit")+" is thinking\\u2026";\n' +
'        scrollEnd();\n' +
'      }\n' +
'      break;\n' +
'    case "response":addMsg("assistant",msg.text||"",msg.fileBlocks);break;\n' +
'    case "error":addMsg("error","Error: "+(msg.message||"unknown error"));break;\n' +
'    case "writeResult":{\n' +
'      var p=pending[msg.filePath];\n' +
'      if(!p)break;\n' +
'      if(msg.ok){\n' +
'        p.a.textContent="Written \\u2713";\n' +
'        p.s.textContent=msg.absPath||"Written";\n' +
'        if(p.s.title!==undefined)p.s.title=msg.absPath||"";\n' +
'        if(p.card)p.card.classList.add("accepted");\n' +
'      }else{\n' +
'        p.a.textContent="Retry";\n' +
'        p.a.disabled=false;p.d.disabled=false;\n' +
'        p.s.textContent=msg.error||"Write failed";\n' +
'      }\n' +
'      delete pending[msg.filePath];\n' +
'      break;\n' +
'    }\n' +
'  }\n' +
'});\n' +
'\n' +
'})();\n';
}

module.exports = { ChatPanel };
