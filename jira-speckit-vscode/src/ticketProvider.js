// ticketProvider.js — TreeDataProvider for open and resolved ticket views
'use strict';

const vscode = require('vscode');

// ─── Priority / status icon mapping ──────────────────────────────────────────

function statusIcon(status) {
    const s = (status ?? '').toLowerCase();
    if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'pass-filled';
    if (s.includes('progress') || s.includes('active'))                       return 'sync';
    if (s.includes('review'))                                                  return 'eye';
    if (s.includes('blocked'))                                                 return 'error';
    return 'circle-outline';
}

function statusColor(status) {
    const s = (status ?? '').toLowerCase();
    if (s.includes('done') || s.includes('closed'))   return new vscode.ThemeColor('testing.iconPassed');
    if (s.includes('progress') || s.includes('active')) return new vscode.ThemeColor('charts.blue');
    if (s.includes('review'))                          return new vscode.ThemeColor('charts.yellow');
    if (s.includes('blocked'))                         return new vscode.ThemeColor('testing.iconFailed');
    return new vscode.ThemeColor('charts.blue');
}

// ─── TreeItem classes ─────────────────────────────────────────────────────────

class TicketItem extends vscode.TreeItem {
    constructor(ticket, mode) {
        super(
            `${ticket.key}  ${ticket.summary || '(no summary)'}`,
            vscode.TreeItemCollapsibleState.None
        );
        this.key        = ticket.key;
        this.ticketData = ticket;

        if (mode === 'open') {
            this.contextValue = 'openTicket';
            this.description  = ticket.status || 'To Do';
            this.iconPath     = new vscode.ThemeIcon(statusIcon(ticket.status), statusColor(ticket.status));
            this.tooltip      = new vscode.MarkdownString(
                `**${ticket.key}**\n\n${ticket.summary}\n\n_Status: ${ticket.status || 'To Do'}_`
            );
        } else {
            this.contextValue = 'resolvedTicket';
            const fc = ticket.files_changed ?? [];
            const when = ticket.resolved_at
                ? new Date(ticket.resolved_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';
            this.description  = [
                fc.length ? `${fc.length} file${fc.length > 1 ? 's' : ''} changed` : '',
                when,
            ].filter(Boolean).join('  ·  ');
            this.iconPath     = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
            this.tooltip      = new vscode.MarkdownString(
                `**${ticket.key}** — ${ticket.summary}\n\n` +
                `**Files changed:** ${fc.length ? fc.map(f => `\`${f}\``).join(', ') : 'none'}`
            );
            this.command = {
                command:   'jiraSpeckit.viewResolution',
                title:     'View Resolution',
                arguments: [this],
            };
        }
    }
}

class EmptyItem extends vscode.TreeItem {
    constructor(label, detail) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description  = detail ?? '';
        this.contextValue = 'empty';
        this.iconPath     = new vscode.ThemeIcon('info');
    }
}

class LoadingItem extends vscode.TreeItem {
    constructor() {
        super('Fetching tickets…', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
}

class ErrorItem extends vscode.TreeItem {
    constructor(serverUrl) {
        super('Cannot reach server', vscode.TreeItemCollapsibleState.None);
        this.description  = serverUrl;
        this.iconPath     = new vscode.ThemeIcon('plug', new vscode.ThemeColor('testing.iconFailed'));
        this.tooltip      = new vscode.MarkdownString(
            `**Server offline**\n\nMake sure the FastAPI server is running:\n\`\`\`\nuvicorn app:app --reload\n\`\`\`\n\nExpected at: \`${serverUrl}\``
        );
        this.contextValue = 'error';
    }
}

// ─── TicketProvider ───────────────────────────────────────────────────────────

class TicketProvider {
    constructor(mode, getConfig) {
        this.mode      = mode;
        this.getConfig = getConfig;
        this._items    = [new LoadingItem()];
        this._loadCallbacks = [];

        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
    }

    onDidLoad(cb) { this._loadCallbacks.push(cb); }

    refresh() {
        this._items = [new LoadingItem()];
        this._onDidChangeTreeData.fire(undefined);
        this._fetch();
    }

    async _fetch() {
        const cfg       = this.getConfig();
        const serverUrl = (cfg.get('serverUrl') || 'http://localhost:8000').replace(/\/$/, '');
        const endpoint  = this.mode === 'open'
            ? `${serverUrl}/api/jira/open`
            : `${serverUrl}/api/jira/resolved`;

        try {
            const res  = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (this.mode === 'open') {
                const issues = data.issues ?? [];
                this._items  = issues.length
                    ? issues.map(i => new TicketItem({
                        key:         i.key,
                        summary:     i.summary     ?? '',
                        status:      i.status      ?? '',
                        description: i.description ?? '',
                    }, 'open'))
                    : [new EmptyItem('No open tickets', '🎉 All clear!')];
                this._loadCallbacks.forEach(cb => cb(issues.length, false));
            } else {
                const tickets = data.tickets ?? [];
                this._items   = tickets.length
                    ? tickets.map(t => new TicketItem(t, 'resolved'))
                    : [new EmptyItem('No resolved tickets yet', 'They will appear here automatically')];
            }
        } catch {
            this._items = [new ErrorItem(serverUrl)];
            this._loadCallbacks.forEach(cb => cb(0, true));
        } finally {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    getTreeItem(element) { return element; }
    getChildren(element) { return element ? [] : this._items; }
}

module.exports = { TicketProvider };
