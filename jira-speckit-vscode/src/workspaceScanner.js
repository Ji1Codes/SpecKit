// workspaceScanner.js — reads the current VS Code workspace to give AI context
'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

const IGNORED = new Set(['node_modules', '.venv', '__pycache__', '.git', 'dist', 'build', '.next', 'coverage', '.cache']);
const KEY_FILES = [
    'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py',
    'pom.xml', 'build.gradle', 'Cargo.toml', 'go.mod',
    'README.md', '.env.example',
];

async function getWorkspaceContext(maxChars = 3000) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return '';

    const root = folders[0].uri.fsPath;
    let context = `Project name: ${path.basename(root)}\n`;

    // Read key descriptor files (package.json, requirements.txt, etc.)
    for (const filename of KEY_FILES) {
        const fp = path.join(root, filename);
        if (fs.existsSync(fp)) {
            try {
                const raw     = fs.readFileSync(fp, 'utf8');
                const snippet = raw.slice(0, 600);
                context += `\n--- ${filename} ---\n${snippet}\n`;
                if (context.length >= maxChars) break;
            } catch { /* skip unreadable files */ }
        }
    }

    // Top-level directory listing
    try {
        const entries = fs.readdirSync(root).filter(e => !e.startsWith('.') && !IGNORED.has(e));
        context += `\nTop-level structure: ${entries.join(', ')}`;
    } catch { /* skip */ }

    return context.slice(0, maxChars);
}

module.exports = { getWorkspaceContext };
