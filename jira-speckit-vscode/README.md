# Jira SpecKit — VS Code Extension

Visualise and trigger the SpecKit Jira auto-resolver from inside VS Code.

## Features

| Feature | Details |
|---|---|
| **Open Tickets** sidebar | Live list of all open Jira tickets from your project |
| **Resolved This Session** sidebar | Every ticket auto-resolved by the poller, with files changed |
| **Resolution Detail Panel** | Click any resolved ticket to see Spec → Plan → Tasks → Implementation |
| **Status bar badge** | Shows open ticket count at a glance; red when server is offline |
| **Resolve All** button | Trigger the full pipeline manually from the toolbar |
| **Open in Jira** | Jump to any ticket in your browser |
| **Auto-refresh** | Both lists refresh every 30 s (configurable) |

## Requirements

The FastAPI server (`app.py`) must be running:

```bash
cd d:\SpecKit
.venv\Scripts\uvicorn app:app --reload
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `jiraSpeckit.serverUrl` | `http://localhost:8000` | URL of the SpecKit FastAPI server |
| `jiraSpeckit.jiraBaseUrl` | *(empty)* | Jira instance URL for opening tickets in browser |
| `jiraSpeckit.autoRefreshSeconds` | `30` | How often to auto-refresh (minimum 10) |

## Running / Debugging

1. Open `jira-speckit-vscode/` as a workspace in VS Code  
   (`File → Open Folder → d:\SpecKit\jira-speckit-vscode`)
2. Press **F5** — an Extension Development Host window opens with the extension active
3. Look for the **Jira SpecKit** icon in the Activity Bar (left sidebar)

## Packaging as a `.vsix`

```bash
# Install the packaging tool once
npm install -g @vscode/vsce

# From inside jira-speckit-vscode/
cd d:\SpecKit\jira-speckit-vscode
vsce package
# → jira-speckit-0.1.0.vsix
```

## Installing locally

```bash
code --install-extension jira-speckit-0.1.0.vsix
```

## Publishing to the Marketplace

1. Create a publisher at <https://marketplace.visualstudio.com/manage>
2. Generate a Personal Access Token (PAT) with **Marketplace → Manage** scope
3. Set `"publisher"` in `package.json` to your publisher ID
4. Run:

```bash
vsce login <your-publisher-id>
vsce publish
```
