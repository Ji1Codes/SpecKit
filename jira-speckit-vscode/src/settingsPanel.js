// settingsPanel.js — Custom settings UI for Jira Ticket Auto Resolver (SpecKit)
'use strict';

const vscode = require('vscode');

let _panel = null; // singleton

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const PROVIDERS = [
    { id: 'azure-openai', label: 'Azure OpenAI',    icon: '☁️',  hint: 'GPT-4.1, GPT-4o via Azure' },
    { id: 'openai',       label: 'OpenAI',           icon: '✨',  hint: 'GPT-4o, o3 via OpenAI API' },
    { id: 'anthropic',    label: 'Anthropic',         icon: '🟠',  hint: 'Claude Opus, Sonnet' },
    { id: 'google',       label: 'Google Gemini',     icon: '🔷',  hint: 'Gemini 2.0 Flash, 2.5 Pro' },
    { id: 'custom',       label: 'Custom / Company',  icon: '🏢',  hint: 'Any OpenAI-compatible API' },
];

class SettingsPanel {
    static show(context, getCfg, testJiraFn) {
        if (_panel) {
            _panel.reveal(vscode.ViewColumn.One);
            // Refresh values in case something changed
            _panel.webview.html = SettingsPanel._buildHtml(getCfg());
            return;
        }

        _panel = vscode.window.createWebviewPanel(
            'jiraSpeckitSettings',
            'SpecKit — Settings',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        _panel.webview.html = SettingsPanel._buildHtml(getCfg());

        _panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.action === 'save') {
                const s      = msg.settings;
                const config = getCfg();
                const G      = vscode.ConfigurationTarget.Global;
                await Promise.all([
                    config.update('jiraBaseUrl',           s.jiraBaseUrl,           G),
                    config.update('jiraEmail',             s.jiraEmail,             G),
                    config.update('jiraApiToken',          s.jiraApiToken,          G),
                    config.update('jiraProjectKey',        s.jiraProjectKey,        G),
                    config.update('aiProvider',            s.aiProvider,            G),
                    config.update('azureOpenAiEndpoint',   s.azureOpenAiEndpoint,   G),
                    config.update('azureOpenAiApiKey',     s.azureOpenAiApiKey,     G),
                    config.update('azureOpenAiDeployment', s.azureOpenAiDeployment, G),
                    config.update('azureOpenAiApiVersion', s.azureOpenAiApiVersion, G),
                    config.update('openAiApiKey',          s.openAiApiKey,          G),
                    config.update('openAiModel',           s.openAiModel,           G),
                    config.update('anthropicApiKey',       s.anthropicApiKey,       G),
                    config.update('anthropicModel',        s.anthropicModel,        G),
                    config.update('googleApiKey',          s.googleApiKey,          G),
                    config.update('googleModel',           s.googleModel,           G),
                    config.update('customApiEndpoint',     s.customApiEndpoint,     G),
                    config.update('customApiKey',          s.customApiKey,          G),
                    config.update('customApiModel',        s.customApiModel,        G),
                    config.update('autoRefreshSeconds',    Number(s.autoRefreshSeconds) || 30, G),
                ]);
                _panel.webview.postMessage({ action: 'saved' });
            }

            if (msg.action === 'testJira') {
                try {
                    const result = await testJiraFn(msg.settings);
                    _panel.webview.postMessage({ action: 'testResult', ok: true, message: result });
                } catch (e) {
                    _panel.webview.postMessage({ action: 'testResult', ok: false, message: e.message });
                }
            }
        }, undefined, context.subscriptions);

        _panel.onDidDispose(() => { _panel = null; }, undefined, context.subscriptions);
    }

    static _buildHtml(config) {
        const g   = (key, def = '') => { const v = config.get(key); return v !== undefined && v !== null ? String(v) : def; };
        const cur = g('aiProvider', 'azure-openai');

        const providerCards = PROVIDERS.map(p => `
          <div class="pcard ${cur === p.id ? 'selected' : ''}" onclick="selectProvider('${p.id}')" id="pcard-${p.id}">
            <span class="pcard-icon">${p.icon}</span>
            <span class="pcard-name">${p.label}</span>
            <span class="pcard-hint">${p.hint}</span>
          </div>`).join('');

        const providerFields = `
          <div class="pfields" id="pf-azure-openai" style="display:${cur==='azure-openai'?'block':'none'}">
            <div class="field-group">
              <label>Endpoint URL</label>
              <input id="azureOpenAiEndpoint" value="${esc(g('azureOpenAiEndpoint'))}" placeholder="https://your-resource.openai.azure.com/" />
            </div>
            <div class="field-group">
              <label>API Key</label>
              <div class="secret-wrap">
                <input id="azureOpenAiApiKey" type="password" value="${esc(g('azureOpenAiApiKey'))}" placeholder="Your Azure OpenAI API key" />
                <button class="eye-btn" onclick="toggleSecret('azureOpenAiApiKey', this)">👁</button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-group">
                <label>Deployment Name</label>
                <input id="azureOpenAiDeployment" value="${esc(g('azureOpenAiDeployment','gpt-4o'))}" placeholder="gpt-4o" />
              </div>
              <div class="field-group">
                <label>API Version</label>
                <input id="azureOpenAiApiVersion" value="${esc(g('azureOpenAiApiVersion','2024-12-01-preview'))}" placeholder="2024-12-01-preview" />
              </div>
            </div>
          </div>

          <div class="pfields" id="pf-openai" style="display:${cur==='openai'?'block':'none'}">
            <div class="field-group">
              <label>API Key</label>
              <div class="secret-wrap">
                <input id="openAiApiKey" type="password" value="${esc(g('openAiApiKey'))}" placeholder="sk-..." />
                <button class="eye-btn" onclick="toggleSecret('openAiApiKey', this)">👁</button>
              </div>
            </div>
            <div class="field-group">
              <label>Model</label>
              <input id="openAiModel" value="${esc(g('openAiModel','gpt-4o'))}" placeholder="gpt-4o" />
              <span class="field-hint">e.g. gpt-4o, gpt-4.1, o3</span>
            </div>
          </div>

          <div class="pfields" id="pf-anthropic" style="display:${cur==='anthropic'?'block':'none'}">
            <div class="field-group">
              <label>API Key</label>
              <div class="secret-wrap">
                <input id="anthropicApiKey" type="password" value="${esc(g('anthropicApiKey'))}" placeholder="sk-ant-..." />
                <button class="eye-btn" onclick="toggleSecret('anthropicApiKey', this)">👁</button>
              </div>
            </div>
            <div class="field-group">
              <label>Model</label>
              <input id="anthropicModel" value="${esc(g('anthropicModel','claude-opus-4-5'))}" placeholder="claude-opus-4-5" />
              <span class="field-hint">e.g. claude-opus-4-5, claude-sonnet-4-5</span>
            </div>
          </div>

          <div class="pfields" id="pf-google" style="display:${cur==='google'?'block':'none'}">
            <div class="field-group">
              <label>API Key</label>
              <div class="secret-wrap">
                <input id="googleApiKey" type="password" value="${esc(g('googleApiKey'))}" placeholder="Your Google AI Studio key" />
                <button class="eye-btn" onclick="toggleSecret('googleApiKey', this)">👁</button>
              </div>
            </div>
            <div class="field-group">
              <label>Model</label>
              <input id="googleModel" value="${esc(g('googleModel','gemini-2.0-flash'))}" placeholder="gemini-2.0-flash" />
              <span class="field-hint">e.g. gemini-2.0-flash, gemini-2.5-pro</span>
            </div>
          </div>

          <div class="pfields" id="pf-custom" style="display:${cur==='custom'?'block':'none'}">
            <div class="field-group">
              <label>API Base URL</label>
              <input id="customApiEndpoint" value="${esc(g('customApiEndpoint'))}" placeholder="http://localhost:11434/v1" />
              <span class="field-hint">OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, company API)</span>
            </div>
            <div class="field-group">
              <label>API Key <span class="field-optional">(optional)</span></label>
              <div class="secret-wrap">
                <input id="customApiKey" type="password" value="${esc(g('customApiKey'))}" placeholder="Leave blank if not required" />
                <button class="eye-btn" onclick="toggleSecret('customApiKey', this)">👁</button>
              </div>
            </div>
            <div class="field-group">
              <label>Model <span class="field-optional">(optional)</span></label>
              <input id="customApiModel" value="${esc(g('customApiModel'))}" placeholder="Leave blank if endpoint has a default" />
            </div>
          </div>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpecKit Settings</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Sidebar ── */
  .sidebar {
    width: 168px;
    flex-shrink: 0;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-right: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
    padding: 16px 0 12px;
  }
  .sidebar-logo {
    padding: 0 16px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 8px;
  }
  .sidebar-logo-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .sidebar-logo-sub { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    cursor: pointer;
    border-left: 2px solid transparent;
    color: var(--vscode-foreground);
    font-size: 13px;
    transition: background 0.1s;
    user-select: none;
  }
  .nav-item:hover { background: var(--vscode-list-hoverBackground); }
  .nav-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-button-background);
    font-weight: 600;
  }
  .nav-icon { font-size: 14px; width: 18px; text-align: center; flex-shrink: 0; }

  /* ── Main ── */
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 28px 32px 16px;
  }
  .section { display: none; }
  .section.active { display: block; }

  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 4px;
    color: var(--vscode-foreground);
  }
  .section-desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 24px;
  }

  /* ── Form fields ── */
  .field-group {
    margin-bottom: 18px;
  }
  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 18px;
  }
  .field-row .field-group { margin-bottom: 0; }

  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    margin-bottom: 5px;
  }
  .field-optional {
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
  }
  input[type="text"], input[type="password"], input:not([type]) {
    width: 100%;
    padding: 6px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }
  input:focus {
    border-color: var(--vscode-focusBorder);
    outline: 1px solid var(--vscode-focusBorder);
  }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }

  .secret-wrap { display: flex; gap: 6px; align-items: center; }
  .secret-wrap input { flex: 1; }
  .eye-btn {
    background: none;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 5px 8px;
    font-size: 13px;
    line-height: 1;
    flex-shrink: 0;
  }
  .eye-btn:hover { background: var(--vscode-toolbar-hoverBackground); }

  .field-hint {
    display: block;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }

  /* ── Provider cards ── */
  .provider-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 10px;
    margin-bottom: 24px;
  }
  .pcard {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 12px 14px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    user-select: none;
  }
  .pcard:hover { background: var(--vscode-list-hoverBackground); }
  .pcard.selected {
    border-color: var(--vscode-button-background);
    background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
    box-shadow: 0 0 0 1px var(--vscode-button-background);
  }
  .pcard-icon { font-size: 20px; display: block; margin-bottom: 6px; }
  .pcard-name { font-size: 12px; font-weight: 600; display: block; margin-bottom: 2px; }
  .pcard-hint { font-size: 10px; color: var(--vscode-descriptionForeground); display: block; }

  .pfields { animation: fadeIn 0.15s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* ── Save bar ── */
  .save-bar {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 10px 32px;
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--vscode-editor-background);
    flex-shrink: 0;
  }
  .btn {
    padding: 6px 18px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    transition: opacity 0.15s;
  }
  .btn:hover:not(:disabled) { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-panel-border);
  }
  .save-msg {
    font-size: 12px;
    color: var(--vscode-terminal-ansiGreen);
    opacity: 0;
    transition: opacity 0.3s;
  }
  .save-msg.show { opacity: 1; }
  .save-msg.error { color: var(--vscode-errorForeground); }

  /* ── Test result ── */
  .test-result {
    margin-top: 10px;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    display: none;
  }
  .test-result.ok  { background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 15%, transparent); color: var(--vscode-terminal-ansiGreen); display:block; }
  .test-result.err { background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); color: var(--vscode-errorForeground); display:block; }

  /* ── Number input ── */
  .number-row { display: flex; align-items: center; gap: 10px; }
  .number-row input { width: 80px; }
  .number-unit { font-size: 12px; color: var(--vscode-descriptionForeground); }

  hr.divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 24px 0; }
</style>
</head>
<body>

<!-- ── Sidebar ── -->
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="sidebar-logo-title">SpecKit</div>
    <div class="sidebar-logo-sub">Jira Auto Resolver</div>
  </div>
  <div class="nav-item active" id="nav-jira"    onclick="showSection('jira')">    <span class="nav-icon">🔗</span> Jira</div>
  <div class="nav-item"        id="nav-ai"      onclick="showSection('ai')">      <span class="nav-icon">🤖</span> AI Provider</div>
  <div class="nav-item"        id="nav-general" onclick="showSection('general')"> <span class="nav-icon">⚙️</span> General</div>
</div>

<!-- ── Main content ── -->
<div class="main">
  <div class="content">

    <!-- ┌── Jira ──────────────────────────────────────────────────────────┐ -->
    <div class="section active" id="sec-jira">
      <div class="section-title">Jira Connection</div>
      <div class="section-desc">Connect to your Atlassian Jira instance. All credentials are stored in VS Code's global settings.</div>

      <div class="field-group">
        <label>Base URL</label>
        <input id="jiraBaseUrl" value="${esc(g('jiraBaseUrl'))}" placeholder="https://your-org.atlassian.net" />
        <span class="field-hint">Your Atlassian domain — no trailing slash</span>
      </div>
      <div class="field-row">
        <div class="field-group">
          <label>Email</label>
          <input id="jiraEmail" value="${esc(g('jiraEmail'))}" placeholder="you@company.com" />
        </div>
        <div class="field-group">
          <label>Project Key</label>
          <input id="jiraProjectKey" value="${esc(g('jiraProjectKey'))}" placeholder="PM" />
          <span class="field-hint">Only tickets from this project are fetched</span>
        </div>
      </div>
      <div class="field-group">
        <label>API Token</label>
        <div class="secret-wrap">
          <input id="jiraApiToken" type="password" value="${esc(g('jiraApiToken'))}" placeholder="Generate at id.atlassian.net → Security → API tokens" />
          <button class="eye-btn" onclick="toggleSecret('jiraApiToken', this)">👁</button>
        </div>
      </div>

      <button class="btn btn-secondary" onclick="testJira()">🔌 Test Connection</button>
      <div class="test-result" id="test-result"></div>
    </div>

    <!-- ┌── AI Provider ───────────────────────────────────────────────────┐ -->
    <div class="section" id="sec-ai">
      <div class="section-title">AI Provider</div>
      <div class="section-desc">Choose which LLM powers the SpecKit pipeline. Only the selected provider's settings are required.</div>

      <input type="hidden" id="aiProvider" value="${esc(cur)}" />
      <div class="provider-grid">${providerCards}</div>

      ${providerFields}
    </div>

    <!-- ┌── General ───────────────────────────────────────────────────────┐ -->
    <div class="section" id="sec-general">
      <div class="section-title">General</div>
      <div class="section-desc">Polling and behaviour settings.</div>

      <div class="field-group">
        <label>Auto-refresh interval</label>
        <div class="number-row">
          <input type="text" id="autoRefreshSeconds" value="${esc(g('autoRefreshSeconds', '30'))}" />
          <span class="number-unit">seconds (minimum 10)</span>
        </div>
        <span class="field-hint">How often SpecKit polls Jira for new open tickets and triggers the resolver.</span>
      </div>
    </div>

  </div><!-- /content -->

  <!-- ── Save bar ── -->
  <div class="save-bar">
    <button class="btn btn-primary" onclick="save()">💾 Save Changes</button>
    <span class="save-msg" id="save-msg"></span>
  </div>
</div><!-- /main -->

<script>
  const vscode = acquireVsCodeApi();

  // ── Section switching ──────────────────────────────────────────────────
  function showSection(id) {
    document.querySelectorAll('.section').forEach(s  => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('sec-' + id).classList.add('active');
    document.getElementById('nav-' + id).classList.add('active');
  }

  // ── Provider cards ────────────────────────────────────────────────────
  function selectProvider(id) {
    document.querySelectorAll('.pcard').forEach(c => c.classList.remove('selected'));
    document.getElementById('pcard-' + id).classList.add('selected');
    document.getElementById('aiProvider').value = id;
    document.querySelectorAll('.pfields').forEach(f => f.style.display = 'none');
    const pf = document.getElementById('pf-' + id);
    if (pf) pf.style.display = 'block';
  }

  // ── Show/hide password ────────────────────────────────────────────────
  function toggleSecret(inputId, btn) {
    const inp = document.getElementById(inputId);
    const isPassword = inp.type === 'password';
    inp.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? '🔒' : '👁';
  }

  // ── Collect all settings from the form ───────────────────────────────
  function collectSettings() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    return {
      jiraBaseUrl:           val('jiraBaseUrl'),
      jiraEmail:             val('jiraEmail'),
      jiraApiToken:          val('jiraApiToken'),
      jiraProjectKey:        val('jiraProjectKey'),
      aiProvider:            val('aiProvider'),
      azureOpenAiEndpoint:   val('azureOpenAiEndpoint'),
      azureOpenAiApiKey:     val('azureOpenAiApiKey'),
      azureOpenAiDeployment: val('azureOpenAiDeployment'),
      azureOpenAiApiVersion: val('azureOpenAiApiVersion'),
      openAiApiKey:          val('openAiApiKey'),
      openAiModel:           val('openAiModel'),
      anthropicApiKey:       val('anthropicApiKey'),
      anthropicModel:        val('anthropicModel'),
      googleApiKey:          val('googleApiKey'),
      googleModel:           val('googleModel'),
      customApiEndpoint:     val('customApiEndpoint'),
      customApiKey:          val('customApiKey'),
      customApiModel:        val('customApiModel'),
      autoRefreshSeconds:    val('autoRefreshSeconds'),
    };
  }

  // ── Save ──────────────────────────────────────────────────────────────
  function save() {
    vscode.postMessage({ action: 'save', settings: collectSettings() });
  }

  // ── Test Jira connection ──────────────────────────────────────────────
  function testJira() {
    const el = document.getElementById('test-result');
    el.className = 'test-result';
    el.textContent = '⏳ Testing connection…';
    el.style.display = 'block';
    vscode.postMessage({ action: 'testJira', settings: collectSettings() });
  }

  // ── Messages from extension ───────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.action === 'saved') {
      const el = document.getElementById('save-msg');
      el.textContent = '✅ Saved';
      el.className = 'save-msg show';
      setTimeout(() => el.classList.remove('show'), 2500);
    }
    if (msg.action === 'testResult') {
      const el = document.getElementById('test-result');
      el.className = 'test-result ' + (msg.ok ? 'ok' : 'err');
      el.textContent = (msg.ok ? '✅ ' : '❌ ') + msg.message;
    }
  });
</script>
</body>
</html>`;
    }
}

module.exports = { SettingsPanel, PROVIDERS };
