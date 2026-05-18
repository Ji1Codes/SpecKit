// extension.js — entry point for the Jira SpecKit VS Code extension
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const { TicketProvider }      = require('./ticketProvider');
const { DetailPanel }         = require('./detailPanel');
const { JiraClient }          = require('./jiraClient');
const { AIPipeline }          = require('./aiPipeline');
const { ApprovalPanel }       = require('./approvalPanel');
const { ChatPanel }           = require('./chatPanel');
const { SettingsPanel, PROVIDERS } = require('./settingsPanel');
const { getWorkspaceContext } = require('./workspaceScanner');

/**
 * One-time migration: import resolved_history.json (written by the old FastAPI
 * server) into VS Code globalState so legacy tickets keep their spec/plan/tasks.
 */
function migrateFromLegacyJson(context) {
    if (context.globalState.get('legacyMigrated')) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const jsonPath = path.join(folders[0].uri.fsPath, 'resolved_history.json');
    if (!fs.existsSync(jsonPath)) return;
    try {
        const legacy = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (!Array.isArray(legacy) || !legacy.length) return;
        const existing = context.globalState.get('resolvedHistory', []);
        const merged   = Object.values(
            Object.fromEntries([...legacy, ...existing].map(t => [t.key, t]))
        );
        context.globalState.update('resolvedHistory', merged);
        context.globalState.update('legacyMigrated', true);
    } catch { /* corrupt file — skip silently */ }
}

let statusBarItem;
let llmStatusBar;
let refreshTimer;
let pollTimer;

// ─── Activate ────────────────────────────────────────────────────────────────

function activate(/** @type {vscode.ExtensionContext} */ context) {
    const cfg = () => vscode.workspace.getConfiguration('jiraSpeckit');

    // ── LLM status bar selector ─────────────────────────────────────────
    llmStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    llmStatusBar.command = 'jiraSpeckit.selectProvider';
    llmStatusBar.tooltip = 'SpecKit: click to switch AI provider';
    context.subscriptions.push(llmStatusBar);

    function updateLlmBar() {
        const p     = cfg().get('aiProvider') || 'azure-openai';
        const found = PROVIDERS.find(x => x.id === p);
        llmStatusBar.text = `$(hubot) ${found ? found.label : p}`;
        llmStatusBar.show();
    }
    updateLlmBar();

    // Refresh bar when user changes setting externally
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jiraSpeckit.aiProvider')) updateLlmBar();
        })
    );

    // ── Core clients ────────────────────────────────────────────────────────
    const jira     = new JiraClient(cfg);
    const pipeline = new AIPipeline(cfg);
    const inFlight = new Set(); // ticket keys currently being resolved

    // Persist resolved history across VS Code sessions
    migrateFromLegacyJson(context);
    let resolvedHistory = context.globalState.get('resolvedHistory', []);
    const saveHistory = (history) => {
        resolvedHistory = history;
        context.globalState.update('resolvedHistory', history);
    };

    // ── Tree providers ──────────────────────────────────────────────────────
    const openProvider = new TicketProvider('open', () => jira.fetchOpenTickets());

    const resolvedProvider = new TicketProvider('resolved', async () => {
        // Merge persisted poller history (rich) with Jira Done tickets (basic)
        const combined = Object.fromEntries(resolvedHistory.map(t => [t.key, t]));
        try {
            const doneIssues = await jira.fetchDoneTickets();
            for (const issue of doneIssues) {
                if (!combined[issue.key]) {
                    const f = issue.fields || {};
                    combined[issue.key] = {
                        key:           issue.key,
                        summary:       f.summary || '',
                        files_changed: [],
                        spec: '', plan: '', tasks: '', solution: '',
                        resolved_at:   f.resolutiondate || f.updated || '',
                        source:        'jira',
                    };
                }
            }
        } catch { /* show what we have if Jira call fails */ }
        return Object.values(combined);
    });

    const openView = vscode.window.createTreeView('jiraSpeckit.openTickets', {
        treeDataProvider: openProvider, showCollapseAll: false,
    });
    const resolvedView = vscode.window.createTreeView('jiraSpeckit.resolvedTickets', {
        treeDataProvider: resolvedProvider, showCollapseAll: false,
    });
    context.subscriptions.push(openView, resolvedView);

    // ── Status bar ──────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'jiraSpeckit.refresh';
    statusBarItem.tooltip = 'Jira SpecKit — click to refresh';
    statusBarItem.text    = '$(bug) SpecKit: loading…';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    openProvider.onDidLoad((count, error) => {
        if (error) {
            statusBarItem.text            = '$(error) SpecKit: check settings';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            statusBarItem.text            = `$(bug) SpecKit: ${count} open`;
            statusBarItem.backgroundColor = undefined;
        }
    });

    // ── Built-in poller (no Python server needed) ───────────────────────────
    async function runPoller() {
        if (!cfg().get('jiraProjectKey') || !cfg().get('jiraEmail') || !cfg().get('jiraApiToken')) return;
        try {
            const issues = await jira.fetchOpenTickets();
            for (const issue of issues) {
                const tid = issue.key;
                if (inFlight.has(tid)) continue;
                inFlight.add(tid);

                (async () => {
                    try {
                        statusBarItem.text = `$(sync~spin) SpecKit: resolving ${tid}…`;
                        const fields       = issue.fields || {};
                        const workspaceCtx = await getWorkspaceContext();
                        const descText     = fields.description
                            ? (typeof fields.description === 'string'
                                ? fields.description
                                : JSON.stringify(fields.description))
                            : '';

                        // Download any image attachments from Jira
                        const images = await jira.downloadAttachments(fields.attachment || []);
                        if (images.length) {
                            statusBarItem.text = `$(sync~spin) SpecKit: analysing ${images.length} image(s) for ${tid}…`;
                        }

                        const result = await pipeline.resolve(
                            tid, fields.summary || '', descText, workspaceCtx, images
                        );

                        await jira.postComment(tid, result.comment);
                        await jira.transitionToDone(tid);

                        // Show approval panel — let user decide which files to apply
                        const writtenFiles = [];
                        if (result.generatedFiles && result.generatedFiles.length) {
                            const wsRoot = vscode.workspace.workspaceFolders
                                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                                : null;

                            const approvedFiles = await ApprovalPanel.show(
                                context, tid, fields.summary || '', result.generatedFiles
                            );

                            if (wsRoot && approvedFiles.length) {
                                for (const gf of approvedFiles) {
                                    try {
                                        const absPath = path.join(wsRoot, gf.path);
                                        const dir     = path.dirname(absPath);
                                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                                        fs.writeFileSync(absPath, gf.content, 'utf8');
                                        writtenFiles.push(gf.path);
                                    } catch (writeErr) {
                                        vscode.window.showWarningMessage(`SpecKit: could not write ${gf.path}: ${writeErr.message}`);
                                    }
                                }
                            }
                        }

                        const entry = {
                            key:             tid,
                            summary:         fields.summary || '',
                            files_changed:   writtenFiles.length ? writtenFiles : result.filesChanged,
                            images_analysed: result.imagesAnalysed || [],
                            spec:            result.spec,
                            plan:            result.plan,
                            tasks:           result.tasks,
                            solution:        result.solution,
                            resolved_at:     new Date().toISOString(),
                        };
                        saveHistory([entry, ...resolvedHistory].slice(0, 50));
                        resolvedProvider.refresh();
                        openProvider.refresh();
                        const fileMsg = writtenFiles.length
                            ? ` — wrote ${writtenFiles.length} file(s): ${writtenFiles.join(', ')}`
                            : '';
                        vscode.window.showInformationMessage(`SpecKit resolved ${tid}: ${fields.summary}${fileMsg}`);
                    } catch (err) {
                        vscode.window.showErrorMessage(`SpecKit failed on ${tid}: ${err.message}`);
                    } finally {
                        inFlight.delete(tid);
                    }
                })();
            }
        } catch { /* silent poll failure — bad config, network issue, etc. */ }
    }

    // ── Commands ────────────────────────────────────────────────────────────
    context.subscriptions.push(

        vscode.commands.registerCommand('jiraSpeckit.refresh', () => {
            openProvider.refresh();
            resolvedProvider.refresh();
        }),

        vscode.commands.registerCommand('jiraSpeckit.resolveAll', async () => {
            const yes = await vscode.window.showWarningMessage(
                'Trigger SpecKit to resolve ALL open Jira tickets now?',
                { modal: true }, 'Yes, resolve all'
            );
            if (!yes) return;
            await runPoller();
        }),

        vscode.commands.registerCommand('jiraSpeckit.openInBrowser', async (item) => {
            if (!item?.key) return;
            let base = cfg().get('jiraBaseUrl') || '';
            if (!base) {
                base = await vscode.window.showInputBox({
                    prompt: 'Enter your Jira base URL',
                    placeHolder: 'https://your-org.atlassian.net',
                    ignoreFocusOut: true,
                });
                if (!base) return;
                await vscode.workspace.getConfiguration('jiraSpeckit').update(
                    'jiraBaseUrl', base, vscode.ConfigurationTarget.Global
                );
            }
            vscode.env.openExternal(vscode.Uri.parse(`${base.replace(/\/$/, '')}/browse/${item.key}`));
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

        vscode.commands.registerCommand('jiraSpeckit.openSettings', () => {
            // Test Jira connection using supplied form values (not yet saved)
            async function testJiraFn(settings) {
                const base  = (settings.jiraBaseUrl || '').replace(/\/$/, '');
                const token = Buffer.from(`${settings.jiraEmail}:${settings.jiraApiToken}`).toString('base64');
                const resp  = await fetch(`${base}/rest/api/3/myself`, {
                    headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
                    signal:  AbortSignal.timeout(10000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status} — check URL, email and token`);
                const user = await resp.json();
                const project = settings.jiraProjectKey || '(not set)';
                return `Connected as ${user.displayName || user.emailAddress} · project: ${project}`;
            }
            SettingsPanel.show(context, cfg, testJiraFn);
        }),

        vscode.commands.registerCommand('jiraSpeckit.openChat', () => {
            ChatPanel.createOrShow(context, pipeline);
        }),

        vscode.commands.registerCommand('jiraSpeckit.selectProvider', async () => {
            const current = cfg().get('aiProvider') || 'azure-openai';
            const items   = PROVIDERS.map(p => ({
                label:       `${p.icon}  ${p.label}${p.id === current ? '  ✓' : ''}`,
                description: p.hint,
                value:       p.id,
                picked:      p.id === current,
            }));
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder:        'Select AI provider for SpecKit',
                matchOnDescription: true,
            });
            if (!picked) return;
            await cfg().update('aiProvider', picked.value, vscode.ConfigurationTarget.Global);
            updateLlmBar();
            vscode.window.showInformationMessage(`SpecKit: switched to ${picked.label.trim()}`);
        }),

    );

    // ── Timers ───────────────────────────────────────────────────────────────
    function startTimers() {
        clearInterval(refreshTimer);
        clearInterval(pollTimer);
        const secs = Math.max(10, cfg().get('autoRefreshSeconds') ?? 30);
        refreshTimer = setInterval(() => {
            openProvider.refresh();
            resolvedProvider.refresh();
        }, secs * 1000);
        pollTimer = setInterval(runPoller, secs * 1000);
    }

    startTimers();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jiraSpeckit')) startTimers();
        })
    );
    context.subscriptions.push({ dispose: () => { clearInterval(refreshTimer); clearInterval(pollTimer); } });

    // ── First-run prompt if not configured ──────────────────────────────────
    const configured = cfg().get('jiraProjectKey') && cfg().get('jiraEmail') && cfg().get('jiraApiToken');
    if (!configured) {
        vscode.window.showInformationMessage(
            'Jira SpecKit: Add your Jira credentials in Settings to get started.',
            'Open Settings'
        ).then(action => {
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'jiraSpeckit');
            }
        });
    }

    openProvider.refresh();
    resolvedProvider.refresh();
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

function deactivate() {
    clearInterval(refreshTimer);
    clearInterval(pollTimer);
}

module.exports = { activate, deactivate };

