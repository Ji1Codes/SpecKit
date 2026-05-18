// workspaceScanner.js — reads the current VS Code workspace to give AI context
'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

const IGNORED = new Set([
    'node_modules', '.venv', '__pycache__', '.git', 'dist', 'build',
    '.next', 'coverage', '.cache', '.vsix', 'out', '.nyc_output',
]);
const CODE_EXTS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.scss',
    '.json', '.yaml', '.yml', '.md', '.txt', '.sh', '.java', '.go',
    '.rs', '.cs', '.cpp', '.c', '.h', '.rb', '.php', '.swift',
]);
const KEY_NAMES = new Set([
    'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py',
    'pom.xml', 'build.gradle', 'Cargo.toml', 'go.mod', 'README.md',
]);

function collectFiles(dir, relBase, results, limit) {
    if (results.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (results.length >= limit) break;
        if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const rel  = relBase ? relBase + '/' + e.name : e.name;
        if (e.isDirectory()) {
            collectFiles(full, rel, results, limit);
        } else if (e.isFile() && CODE_EXTS.has(path.extname(e.name).toLowerCase())) {
            results.push({ full, rel });
        }
    }
}

async function getWorkspaceContext(maxChars = 12000) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return '';

    const root = folders[0].uri.fsPath;
    let context = `Project: ${path.basename(root)}\nRoot: ${root}\n`;

    const files = [];
    collectFiles(root, '', files, 80);

    // File list
    context += `\nWorkspace files:\n${files.map(f => '  ' + f.rel).join('\n')}\n`;

    // Read key files first, then the rest
    const isKey = f => KEY_NAMES.has(path.basename(f.rel));
    const sorted = [...files.filter(isKey), ...files.filter(f => !isKey(f))];

    for (const file of sorted) {
        if (context.length >= maxChars) break;
        try {
            const raw = fs.readFileSync(file.full, 'utf8');
            if (!raw.trim()) continue;
            const budget = Math.min(2000, maxChars - context.length - 60);
            if (budget < 40) break;
            const snippet = raw.length > budget ? raw.slice(0, budget) + '\n…(truncated)' : raw;
            context += `\n--- ${file.rel} ---\n${snippet}\n`;
        } catch { /* skip unreadable */ }
    }

    return context.slice(0, maxChars);
}

module.exports = { getWorkspaceContext };
