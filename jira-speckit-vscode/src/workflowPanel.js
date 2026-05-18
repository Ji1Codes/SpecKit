// workflowPanel.js — Persistent Workflow Panel: tracks all pipeline stages
'use strict';

const vscode = require('vscode');

// ── Store helpers ─────────────────────────────────────────────────────────────

const STORE_KEY   = 'workflowStore';
const MIGRATED_KEY = 'workflowStoreMigrated';
const MAX_ENTRIES  = 500;
const MAX_PREVIEW  = 500;

function _emptyStore() {
    return { version: '1.0', entries: [] };
}

function _first3Lines(text) {
    if (!text) return '';
    return text.split('\n').slice(0, 3).join('\n').slice(0, MAX_PREVIEW);
}

function truncatePreview(text) {
    if (!text) return '';
    const lines = text.split('\n').slice(0, 3).join('\n');
    return lines.length > MAX_PREVIEW ? lines.slice(0, MAX_PREVIEW) + '…' : lines;
}

function parseTasks(tasksText) {
    if (!tasksText) return [];
    return tasksText.split('\n')
        .filter(l => l.trim())
        .map((l, i) => ({
            id:      i,
            label:   l.replace(/^-\s*\[.\]\s*/, '').replace(/^-\s*/, '').trim(),
            checked: /^\s*-\s*\[x\]/i.test(l),
        }))
        .filter(t => t.label);
}

function parseTestResults(commands) {
    return (commands || []).map(cmd => ({
        command:  cmd,
        exitCode: null,
        stdout:   '(run in terminal — output not captured)',
        ranAt:    null,
    }));
}

function loadStore(context) {
    try {
        const raw = context.globalState.get(STORE_KEY);
        if (raw && raw.version && Array.isArray(raw.entries)) return raw;
    } catch (_) {}
    return _emptyStore();
}

function saveStore(context, store) {
    if (store.entries.length > MAX_ENTRIES) {
        store.entries = store.entries.slice(0, MAX_ENTRIES);
    }
    return context.globalState.update(STORE_KEY, store);
}

function upsertEntry(store, patch) {
    const idx = store.entries.findIndex(e => e.id === patch.id);
    if (idx >= 0) {
        // merge top-level fields, keep existing stages
        Object.assign(store.entries[idx], { ...patch, stages: store.entries[idx].stages });
        store.entries[idx].updatedAt = new Date().toISOString();
    } else {
        // new entry — build default stages
        const now    = new Date().toISOString();
        const stages = (patch.type === 'chat'
            ? ['Understand', 'Plan', 'Execute', 'Confirm']
            : ['Spec', 'Plan', 'Tasks', 'Implement', 'Test']
        ).map(name => ({
            name, status: 'pending',
            outputPreview: null, errorSummary: null,
            startedAt: null, completedAt: null,
            tasks: null, testResults: null,
        }));
        store.entries.unshift({
            id: patch.id, type: patch.type || 'ticket',
            summary: (patch.summary || '').slice(0, 200),
            createdAt: now, updatedAt: now,
            inProgress: false, stages,
        });
        // prune
        if (store.entries.length > MAX_ENTRIES) store.entries.pop();
    }
    return store;
}

function updateStage(store, id, stageName, patch) {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return store;
    const stage = entry.stages.find(s => s.name === stageName);
    if (!stage) return store;

    const now = new Date().toISOString();
    if (patch.status === 'in-progress' && !stage.startedAt) stage.startedAt = now;
    if ((patch.status === 'done' || patch.status === 'failed') && !stage.completedAt) stage.completedAt = now;

    Object.assign(stage, patch);
    if (patch.outputPreview) stage.outputPreview = patch.outputPreview.slice(0, MAX_PREVIEW);
    if (patch.errorSummary)  stage.errorSummary  = patch.errorSummary.slice(0, 300);

    entry.updatedAt  = now;
    entry.inProgress = entry.stages.some(s => s.status === 'in-progress');
    return store;
}

// ── Migration from resolvedHistory ────────────────────────────────────────────

async function _migrateIfNeeded(context) {
    if (context.globalState.get(MIGRATED_KEY)) return;
    const history = context.globalState.get('resolvedHistory', []);
    if (!history.length) { await context.globalState.update(MIGRATED_KEY, true); return; }

    let store = loadStore(context);
    if (store.entries.length > 0) { await context.globalState.update(MIGRATED_KEY, true); return; }

    for (const h of history.slice(0, MAX_ENTRIES)) {
        const now = h.resolved_at || new Date().toISOString();
        store.entries.push({
            id: h.key, type: 'ticket',
            summary:   (h.summary || '').slice(0, 200),
            createdAt: now, updatedAt: now, inProgress: false,
            stages: [
                { name: 'Spec',      status: h.spec    ? 'done' : 'pending', outputPreview: _first3Lines(h.spec),     errorSummary: null, startedAt: null, completedAt: now, tasks: null, testResults: null },
                { name: 'Plan',      status: h.plan    ? 'done' : 'pending', outputPreview: _first3Lines(h.plan),     errorSummary: null, startedAt: null, completedAt: now, tasks: null, testResults: null },
                { name: 'Tasks',     status: h.tasks   ? 'done' : 'pending', outputPreview: _first3Lines(h.tasks),    errorSummary: null, startedAt: null, completedAt: now, tasks: parseTasks(h.tasks), testResults: null },
                { name: 'Implement', status: h.solution ? 'done' : 'pending', outputPreview: _first3Lines(h.solution), errorSummary: null, startedAt: null, completedAt: now, tasks: null, testResults: null },
                { name: 'Test',      status: 'pending', outputPreview: null, errorSummary: null, startedAt: null, completedAt: null, tasks: null, testResults: [] },
            ],
        });
    }
    await saveStore(context, store);
    await context.globalState.update(MIGRATED_KEY, true);
}

// ── WorkflowPanel class ───────────────────────────────────────────────────────

class WorkflowPanel {
    static _instance = null;

    static createOrShow(context) {
        if (WorkflowPanel._instance) {
            WorkflowPanel._instance._panel.reveal(vscode.ViewColumn.Two);
            return;
        }
        new WorkflowPanel(context);
    }

    /**
     * Emit a workflow event — safe to call even when panel is closed.
     *
     * patch shapes:
     *   Create entry:   { id, type, summary, action:'create' }
     *   Update stage:   { id, stageName, status, outputPreview?, errorSummary?, tasks?, testResults? }
     *   Batch stages:   { id, stageBatch: { StageName: {status, outputPreview?, tasks?}, … } }
     *   Toggle task:    { id, stageName, taskId, checked }  (handled internally from webview)
     */
    static async emit(context, patch) {
        try {
            let store = loadStore(context);

            if (patch.action === 'create') {
                store = upsertEntry(store, patch);
            } else if (patch.stageBatch) {
                for (const [name, sp] of Object.entries(patch.stageBatch)) {
                    store = updateStage(store, patch.id, name, sp);
                }
            } else if (patch.stageName) {
                store = updateStage(store, patch.id, patch.stageName, patch);
            }

            await saveStore(context, store);

            if (WorkflowPanel._instance) {
                const entry = store.entries.find(e => e.id === patch.id);
                if (entry) WorkflowPanel._instance._post({ type: 'upsert', entry });
            }
        } catch (_) { /* never crash the pipeline */ }
    }

    constructor(context) {
        this._context = context;

        this._panel = vscode.window.createWebviewPanel(
            'jiraSpeckitWorkflow',
            'SpecKit Workflow',
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        WorkflowPanel._instance = this;

        _migrateIfNeeded(context).then(() => {
            this._panel.webview.html = this._buildHtml();
        });

        this._panel.webview.onDidReceiveMessage(msg => this._onMessage(msg));
        this._panel.onDidDispose(() => { WorkflowPanel._instance = null; });
    }

    async _onMessage(msg) {
        const store = loadStore(this._context);
        switch (msg.type) {
            case 'ready': {
                const entries = store.entries.slice(0, 100);
                this._post({ type: 'init', entries, hasMore: store.entries.length > 100 });
                break;
            }
            case 'loadMore': {
                const offset = msg.offset || 0;
                const slice  = store.entries.slice(offset, offset + 50);
                this._post({ type: 'moreEntries', entries: slice, offset: offset + 50, hasMore: store.entries.length > offset + 50 });
                break;
            }
            case 'toggleTask': {
                const entry = store.entries.find(e => e.id === msg.id);
                if (!entry) break;
                const stage = entry.stages.find(s => s.name === msg.stageName);
                if (stage && stage.tasks) {
                    const task = stage.tasks.find(t => t.id === msg.taskId);
                    if (task) task.checked = msg.checked;
                    entry.updatedAt = new Date().toISOString();
                    await saveStore(this._context, store);
                }
                break;
            }
        }
    }

    _post(msg) {
        try { this._panel.webview.postMessage(msg); } catch (_) {}
    }

    _buildHtml() {
        const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>SpecKit Workflow</title>
<style nonce="${nonce}">
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,system-ui);font-size:var(--vscode-font-size,13px);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:0 0 80px}
/* header */
.wf-header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));position:sticky;top:0;background:var(--vscode-editor-background);z-index:10}
.wf-title{font-weight:700;font-size:14px}
.wf-counts{font-size:11px;opacity:.5}
/* filter bar */
.filter-bar{display:flex;gap:8px;padding:10px 20px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.1))}
.filter-btn{padding:3px 12px;border-radius:12px;font-size:11px;cursor:pointer;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));background:transparent;color:var(--vscode-editor-foreground);font-family:inherit}
.filter-btn.active{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border-color:transparent}
/* entry */
.entry{border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.1));padding:12px 20px}
.entry-header{display:flex;align-items:flex-start;gap:10px;cursor:pointer;user-select:none}
.entry-icon{font-size:11px;padding:2px 7px;border-radius:10px;font-weight:700;flex-shrink:0;margin-top:1px}
.icon-ticket{background:rgba(14,99,156,.18);color:#58a6ff}
.icon-chat{background:rgba(80,200,80,.12);color:#4ec9b0}
.entry-sum{flex:1;font-size:13px;font-weight:600;line-height:1.3}
.entry-meta{font-size:11px;opacity:.45;white-space:nowrap;margin-top:2px}
.entry-status{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;flex-shrink:0;margin-top:1px}
.s-pending{background:rgba(128,128,128,.15);color:var(--vscode-descriptionForeground)}
.s-in-progress{background:rgba(14,99,156,.2);color:#4fc1ff}
.s-done{background:rgba(40,200,80,.12);color:#4ec9b0}
.s-failed{background:rgba(230,60,50,.15);color:#f48771}
/* stage pills */
.stages{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.pill{font-size:11px;padding:2px 9px;border-radius:10px;border:1px solid transparent}
.pill-pending{border-color:rgba(128,128,128,.25);color:var(--vscode-descriptionForeground)}
.pill-in-progress{border-color:#4fc1ff;color:#4fc1ff;animation:pill-pulse 1.2s ease-in-out infinite}
@keyframes pill-pulse{50%{opacity:.5}}
.pill-done{background:rgba(40,200,80,.1);border-color:rgba(40,200,80,.3);color:#4ec9b0}
.pill-failed{background:rgba(230,60,50,.1);border-color:rgba(230,60,50,.3);color:#f48771}
/* expanded body */
.entry-body{display:none;margin-top:12px;padding-top:10px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.1))}
.entry.open .entry-body{display:block}
.stage-row{margin-bottom:12px}
.stage-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;opacity:.6;margin-bottom:4px}
.stage-output{font-size:12px;line-height:1.5;white-space:pre-wrap;background:var(--vscode-textBlockQuote-background,rgba(128,128,128,.07));border-left:2px solid var(--vscode-panel-border,rgba(128,128,128,.2));padding:6px 10px;border-radius:0 4px 4px 0;font-family:var(--vscode-editor-font-family,monospace)}
.stage-error{color:#f48771;font-size:12px;font-style:italic;margin-top:4px}
/* tasks */
.task-list{list-style:none;display:flex;flex-direction:column;gap:4px;margin-top:4px}
.task-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.4}
.task-item input[type=checkbox]{margin-top:2px;flex-shrink:0;accent-color:var(--vscode-button-background,#0e639c)}
.task-item.done label{text-decoration:line-through;opacity:.5}
/* test results */
.test-row{background:var(--vscode-terminal-background,#1e1e1e);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));border-radius:5px;overflow:hidden;margin-top:6px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}
.test-cmd{display:flex;align-items:center;gap:8px;padding:5px 10px;background:rgba(255,255,255,.03);border-bottom:1px solid rgba(128,128,128,.12)}
.test-prompt{color:#4ec9b0;font-weight:700}
.test-out{padding:6px 10px;white-space:pre-wrap;max-height:150px;overflow-y:auto;color:var(--vscode-terminal-foreground,#ccc)}
.test-exit{padding:2px 10px 5px;font-size:11px}
.exit-ok{color:#4ec9b0}.exit-fail{color:#f48771}.exit-pending{opacity:.4}
/* load more */
.load-more{display:none;margin:12px 20px;padding:8px;text-align:center;cursor:pointer;border:1px dashed var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:6px;font-size:12px;color:var(--vscode-descriptionForeground)}
.load-more.visible{display:block}
/* empty */
.empty{padding:60px 20px;text-align:center;opacity:.4;font-size:13px}
</style>
</head>
<body>
<div class="wf-header">
  <div>
    <div class="wf-title">SpecKit Workflow</div>
    <div class="wf-counts" id="wfCounts"></div>
  </div>
  <div class="filter-bar" style="padding:0;border:none;gap:5px">
    <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
    <button class="filter-btn" data-filter="ticket" onclick="setFilter('ticket')">Tickets</button>
    <button class="filter-btn" data-filter="chat" onclick="setFilter('chat')">Chat</button>
    <button class="filter-btn" data-filter="in-progress" onclick="setFilter('in-progress')">Active</button>
    <button class="filter-btn" data-filter="failed" onclick="setFilter('failed')">Failed</button>
  </div>
</div>

<div id="list"></div>
<div class="load-more" id="loadMore" onclick="loadMore()">Load more…</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let _entries = [];
let _filter  = 'all';
let _offset  = 0;
let _hasMore = false;

function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function entryStatus(entry) {
  if (entry.stages.some(s=>s.status==='failed'))      return 'failed';
  if (entry.stages.some(s=>s.status==='in-progress')) return 'in-progress';
  if (entry.stages.every(s=>s.status==='done'))        return 'done';
  if (entry.stages.some(s=>s.status==='done'))         return 'in-progress';
  return 'pending';
}

function pillClass(status){ return 'pill pill-'+status; }
function statusClass(status){ return 'entry-status s-'+status; }

function statusLabel(s){
  return {pending:'Pending','in-progress':'Active',done:'Done',failed:'Failed'}[s]||s;
}

function renderStageBody(entry){
  return entry.stages.map(stage=>{
    let inner='';
    if(stage.status==='pending') inner='<span style="opacity:.4;font-size:12px">Waiting…</span>';
    else if(stage.outputPreview) inner='<div class="stage-output">'+esc(stage.outputPreview)+'</div>';
    if(stage.errorSummary) inner+='<div class="stage-error">⚠ '+esc(stage.errorSummary)+'</div>';

    // tasks
    if(stage.tasks&&stage.tasks.length){
      const done=stage.tasks.filter(t=>t.checked).length;
      inner+='<div style="font-size:11px;opacity:.5;margin:6px 0 4px">'+done+'/'+stage.tasks.length+' tasks done</div>';
      inner+='<ul class="task-list">';
      for(const t of stage.tasks){
        inner+='<li class="task-item'+(t.checked?' done':'')+'">'+
          '<input type="checkbox"'+(t.checked?' checked':'')+
          ' onchange="toggleTask(\''+esc(entry.id)+'\',\''+esc(stage.name)+'\','+t.id+',this.checked)">'+
          '<label>'+esc(t.label)+'</label></li>';
      }
      inner+='</ul>';
    }

    // test results
    if(stage.testResults&&stage.testResults.length){
      for(const r of stage.testResults){
        const exitCls = r.exitCode===null?'exit-pending':r.exitCode===0?'exit-ok':'exit-fail';
        const exitTxt = r.exitCode===null?'(pending)':'exit '+r.exitCode;
        inner+='<div class="test-row">'+
          '<div class="test-cmd"><span class="test-prompt">$</span><code>'+esc(r.command)+'</code></div>'+
          '<div class="test-out">'+esc(r.stdout||'')+'</div>'+
          '<div class="test-exit '+exitCls+'">'+exitTxt+'</div>'+
          '</div>';
      }
    }

    const stCls  = 'pill pill-'+stage.status;
    return '<div class="stage-row">'+
      '<div class="stage-name"><span class="'+stCls+'" style="font-size:10px;font-weight:600">'+esc(stage.name)+'</span></div>'+
      (inner||'')+'</div>';
  }).join('');
}

function renderEntry(entry){
  const status = entryStatus(entry);
  const iconCls = entry.type==='chat'?'icon-chat':'icon-ticket';
  const iconLbl = entry.type==='chat'?'CHAT':'JIRA';
  const pills   = entry.stages.map(s=>'<span class="'+pillClass(s.status)+'">'+esc(s.name)+'</span>').join('');
  const date    = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'}) : '';

  return '<div class="entry" id="e-'+esc(entry.id)+'" data-status="'+status+'" data-type="'+entry.type+'">'+
    '<div class="entry-header" onclick="toggle(\''+esc(entry.id)+'\')">'+
      '<span class="entry-icon '+iconCls+'">'+iconLbl+'</span>'+
      '<div style="flex:1;min-width:0">'+
        '<div class="entry-sum">'+esc(entry.id)+' &mdash; '+esc(entry.summary)+'</div>'+
        '<div class="entry-meta">'+date+'</div>'+
        '<div class="stages">'+pills+'</div>'+
      '</div>'+
      '<span class="'+statusClass(status)+'">'+statusLabel(status)+'</span>'+
    '</div>'+
    '<div class="entry-body">'+renderStageBody(entry)+'</div>'+
  '</div>';
}

function setFilter(f){
  _filter=f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===f));
  render();
}

function filteredEntries(){
  return _entries.filter(e=>{
    if(_filter==='all') return true;
    if(_filter==='ticket'||_filter==='chat') return e.type===_filter;
    return entryStatus(e)===_filter;
  });
}

function render(){
  const list = document.getElementById('list');
  const fe   = filteredEntries();
  if(!fe.length){
    list.innerHTML='<div class="empty">No workflow entries yet.<br>Open a Jira ticket or send a chat message.</div>';
  } else {
    list.innerHTML = fe.map(renderEntry).join('');
  }
  const c = document.getElementById('wfCounts');
  c.textContent = _entries.length+' entries · '+filteredEntries().length+' shown';
  document.getElementById('loadMore').classList.toggle('visible', _hasMore);
}

function toggle(id){
  const el = document.getElementById('e-'+id);
  if(el) el.classList.toggle('open');
}

function toggleTask(id,stageName,taskId,checked){
  vscode.postMessage({type:'toggleTask',id,stageName,taskId,checked});
  // optimistic local update
  const e=_entries.find(e=>e.id===id);
  if(e){ const s=e.stages.find(s=>s.name===stageName); if(s&&s.tasks){ const t=s.tasks.find(t=>t.id===taskId); if(t) t.checked=checked; } }
}

function loadMore(){
  vscode.postMessage({type:'loadMore',offset:_offset});
}

window.addEventListener('message',ev=>{
  const msg=ev.data;
  if(msg.type==='init'){
    _entries=msg.entries||[];
    _hasMore=msg.hasMore||false;
    _offset=_entries.length;
    render();
  } else if(msg.type==='moreEntries'){
    _entries=_entries.concat(msg.entries||[]);
    _hasMore=msg.hasMore||false;
    _offset=msg.offset||_offset;
    render();
  } else if(msg.type==='upsert'){
    const idx=_entries.findIndex(e=>e.id===msg.entry.id);
    if(idx>=0) _entries[idx]=msg.entry; else _entries.unshift(msg.entry);
    render();
    // re-open if it was open before
    if(document.getElementById('e-'+msg.entry.id)?.classList.contains('open'))
      document.getElementById('e-'+msg.entry.id)?.classList.add('open');
  }
});

vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
    }
}

module.exports = { WorkflowPanel, loadStore, saveStore, upsertEntry, updateStage, truncatePreview, parseTasks, parseTestResults };
