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
    constructor(message) {
        super('Error loading tickets', vscode.TreeItemCollapsibleState.None);
        this.description  = message || 'Check Settings';
        this.iconPath     = new vscode.ThemeIcon('plug', new vscode.ThemeColor('testing.iconFailed'));
        this.tooltip      = new vscode.MarkdownString(
            `**Could not load tickets**\n\n${message}\n\nOpen Settings and configure your Jira credentials.`
        );
        this.contextValue = 'error';
        this.command = {
            command: 'jiraSpeckit.openSettings',
            title:   'Open Settings',
        };
    }
}

// ─── TicketProvider ───────────────────────────────────────────────────────────
// getData: async function() → raw Jira issues[] (open) or resolved ticket objects[] (resolved)

class TicketProvider {
    constructor(mode, getData) {
        this.mode    = mode;
        this.getData = getData;
        this._items  = [new LoadingItem()];
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
        try {
            const data = await this.getData();

            if (this.mode === 'open') {
                // data is raw Jira issues with .fields.*
                const issues = Array.isArray(data) ? data : [];
                this._items  = issues.length
                    ? issues.map(i => {
                        const f = i.fields || {};
                        return new TicketItem({
                            key:         i.key,
                            summary:     f.summary || '',
                            status:      f.status?.name || '',
                            description: f.description || '',
                        }, 'open');
                    })
                    : [new EmptyItem('No open tickets', 'All clear!')];
                this._loadCallbacks.forEach(cb => cb(issues.length, false));
            } else {
                // data is resolved ticket objects {key, summary, files_changed, ...}
                const tickets = Array.isArray(data) ? data : [];
                this._items   = tickets.length
                    ? tickets.map(t => new TicketItem(t, 'resolved'))
                    : [new EmptyItem('No resolved tickets yet', 'They will appear here automatically')];
            }
        } catch (err) {
            this._items = [new ErrorItem(err.message || String(err))];
            this._loadCallbacks.forEach(cb => cb(0, true));
        } finally {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    getTreeItem(element) { return element; }
    getChildren(element) { return element ? [] : this._items; }
}

module.exports = { TicketProvider };
