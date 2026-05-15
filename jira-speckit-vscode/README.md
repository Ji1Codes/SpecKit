# Jira SpecKit

**Automatically resolve Jira tickets using AI — right from VS Code.**

Jira SpecKit connects to your team's Jira project and uses the SpecKit AI pipeline to watch for open tickets, generate a full Spec → Plan → Tasks → Implementation, post the resolution back to Jira, and mark the ticket as Done — all automatically.

---

## What you'll need before you start

Before installing this extension, make sure the following are in place:

### 1. Python 3.11 or newer
Download from [python.org](https://www.python.org/downloads/) if you don't have it.  
Verify in a terminal: `python --version`

### 2. The SpecKit backend server
This extension is a frontend for the **SpecKit FastAPI server**. You need that server running on your machine for the extension to work.

If your team has already set it up, ask them for the server URL (default: `http://localhost:8000`).

To run it yourself:
```
cd <path-to-SpecKit>
.venv\Scripts\uvicorn app:app --reload
```
Keep this terminal open while using the extension.

### 3. A Jira account with API access
You need access to a Jira project and the server must be configured with:
- Your Jira URL (e.g. `https://your-team.atlassian.net`)
- A Jira email and API token (set in the server's `.env` file)

> If you're not sure whether the server is configured, ask your team admin.

---

## Installation

1. Install this extension from the VS Code Marketplace (search **Jira SpecKit**)
2. Make sure the SpecKit backend server is running (see above)
3. Reload VS Code (`Ctrl+Shift+P` → **Developer: Reload Window**)
4. Click the **Jira SpecKit** icon in the left Activity Bar — you'll see your tickets appear automatically

---

## What you'll see

| Panel | What it shows |
|---|---|
| **Open Tickets** | All currently open tickets in your Jira project |
| **Resolved This Session** | Tickets auto-resolved by SpecKit AI, with files changed |
| **Resolution Detail Panel** | Click any resolved ticket → see the full Spec, Plan, Tasks, and Implementation |
| **Status bar** (bottom of VS Code) | Live count of open tickets; turns red if the server is offline |

Both panels refresh every 30 seconds automatically.

---

## Extension settings

Open VS Code Settings (`Ctrl+,`) and search **Jira SpecKit** to configure:

| Setting | Default | What it does |
|---|---|---|
| `jiraSpeckit.serverUrl` | `http://localhost:8000` | Where your SpecKit backend server is running |
| `jiraSpeckit.jiraBaseUrl` | *(empty)* | Your Jira URL — enables the "Open in Jira" button |
| `jiraSpeckit.autoRefreshSeconds` | `30` | How often to refresh the ticket lists (minimum 10 s) |

---

## Toolbar buttons

Inside the Jira SpecKit panel you'll find:

- **▶ Resolve All** — Manually trigger the AI pipeline on all open tickets right now
- **⟳ Refresh** — Reload both ticket lists immediately

---

## Troubleshooting

**"Cannot reach server" error in the sidebar**  
→ The SpecKit backend is not running. Start it with `.venv\Scripts\uvicorn app:app --reload` in the SpecKit folder.

**No open tickets showing, but there are tickets in Jira**  
→ Check that `jiraSpeckit.serverUrl` points to the correct server address. Also verify the server's `.env` file has the right Jira project key.

**Resolved tickets show "Not available for this ticket"**  
→ Those tickets were resolved before SpecKit started tracking them. Only tickets resolved through the SpecKit pipeline will have full Spec/Plan/Tasks/Implementation details.

**Status bar is red**  
→ The server is offline or unreachable. Start or restart the backend server.

