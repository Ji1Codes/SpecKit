// extension.js — entry point for the Jira SpecKit VS Code extension
'use strict';

const vscode = require('vscode');
const { TicketProvider } = require('./ticketProvider');
const { DetailPanel } = require('./detailPanel');

/** @type {vscode.StatusBarItem} */
let statusBarItem;
/** @type {ReturnType<typeof setInterval>} */
let refreshTimer;

// ─── Activate ────────────────────────────────────────────────────────────────

function activate(/** @type {vscode.ExtensionContext} */ context) {
    const cfg = () => vscode.workspace.getConfiguration('jiraSpeckit');

    // ── Tree providers ──────────────────────────────────────────────────────
    const openProvider     = new TicketProvider('open',     cfg);
    const resolvedProvider = new TicketProvider('resolved', cfg);

    const openView = vscode.window.createTreeView('jiraSpeckit.openTickets', {
        treeDataProvider: openProvider,
        showCollapseAll: false,
    });
    const resolvedView = vscode.window.createTreeView('jiraSpeckit.resolvedTickets', {
        treeDataProvider: resolvedProvider,
        showCollapseAll: false,
    });

    context.subscriptions.push(openView, resolvedView);

    // ── Status bar ──────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left, 100
    );
    statusBarItem.command  = 'jiraSpeckit.refresh';
    statusBarItem.tooltip  = 'Jira SpecKit — click to refresh';
    statusBarItem.text     = '$(bug) SpecKit: loading…';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Sync status bar text whenever open tickets change
    openProvider.onDidLoad((count, error) => {
        if (error) {
            statusBarItem.text         = '$(error) SpecKit: server offline';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            statusBarItem.text         = `$(bug) SpecKit: ${count} open`;
            statusBarItem.backgroundColor = undefined;
        }
    });

    // ── Commands ────────────────────────────────────────────────────────────

    context.subscriptions.push(

        vscode.commands.registerCommand('jiraSpeckit.refresh', () => {
            openProvider.refresh();
            resolvedProvider.refresh();
        }),

        vscode.commands.registerCommand('jiraSpeckit.resolveAll', async () => {
            const serverUrl = cfg().get('serverUrl');
            const yes = await vscode.window.showWarningMessage(
                'Trigger SpecKit to resolve ALL open Jira tickets now?',
                { modal: true }, 'Yes, resolve all'
            );
            if (!yes) return;

            statusBarItem.text = '$(sync~spin) SpecKit: resolving…';
            try {
                const res  = await fetch(`${serverUrl}/api/jira/resolve`, { method: 'POST' });
                const data = await res.json();
                vscode.window.showInformationMessage(
                    `SpecKit: triggered resolution — ${data.resolved ?? 0} resolved, ${data.errors ?? 0} errors.`
                );
            } catch {
                vscode.window.showErrorMessage(
                    `SpecKit: cannot reach server at ${serverUrl}. Is it running?`
                );
            } finally {
                // Brief pause then refresh so resolved tickets appear
                setTimeout(() => {
                    openProvider.refresh();
                    resolvedProvider.refresh();
                }, 3000);
            }
        }),

        vscode.commands.registerCommand('jiraSpeckit.openInBrowser', async (item) => {
            if (!item?.key) return;
            let base = cfg().get('jiraBaseUrl') || '';
            if (!base) {
                base = await vscode.window.showInputBox({
                    prompt:      'Enter your Jira base URL',
                    placeHolder: 'https://your-org.atlassian.net',
                    ignoreFocusOut: true,
                });
                if (!base) return;
                await vscode.workspace.getConfiguration('jiraSpeckit').update(
                    'jiraBaseUrl', base, vscode.ConfigurationTarget.Global
                );
            }
            const url = `${base.replace(/\/$/, '')}/browse/${item.key}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        }),

        vscode.commands.registerCommand('jiraSpeckit.viewResolution', (item) => {
            if (!item?.ticketData) return;
            DetailPanel.show(context.extensionUri, item.ticketData);
        }),

        vscode.commands.registerCommand('jiraSpeckit.copyTicketKey', (item) => {
            if (!item?.key) return;
            vscode.env.clipboard.writeText(item.key);
            vscode.window.showInformationMessage(`Copied: ${item.key}`);
        }),

    );

    // ── Auto-refresh timer ──────────────────────────────────────────────────
    function startTimer() {
        clearInterval(refreshTimer);
        const secs = Math.max(10, cfg().get('autoRefreshSeconds') ?? 30);
        refreshTimer = setInterval(() => {
            openProvider.refresh();
            resolvedProvider.refresh();
        }, secs * 1000);
    }

    startTimer();

    // Restart timer if config changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jiraSpeckit')) startTimer();
        })
    );

    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

    // ── Initial load ────────────────────────────────────────────────────────
    openProvider.refresh();
    resolvedProvider.refresh();
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

function deactivate() {
    clearInterval(refreshTimer);
}

module.exports = { activate, deactivate };
