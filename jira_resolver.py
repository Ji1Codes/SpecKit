"""
Jira Auto-Resolver (SpecKit-Driven)
=====================================
For each open Jira ticket, runs the full SpecKit 4-step pipeline using GPT-4.1:

  Step 1 — Specify   : Generate a feature spec from the ticket (user story + acceptance criteria)
  Step 2 — Plan      : Create a technical implementation plan from the spec
  Step 3 — Tasks     : Break the plan into a numbered, actionable task list
  Step 4 — Implement : Execute the tasks and produce the final solution

The Step 4 output is posted as a Jira comment and the ticket is transitioned to Done.
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
from base64 import b64encode

import httpx
from openai import AsyncAzureOpenAI

logger = logging.getLogger(__name__)

WORKSPACE_ROOT = pathlib.Path(__file__).parent
_SKIP_DIRS = {".venv", "__pycache__", ".git", ".github", "node_modules", "specs", ".pytest_cache"}
_EDITABLE_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".json"}
_MAX_FILE_BYTES = 50_000


# ---------------------------------------------------------------------------
# Jira helpers
# ---------------------------------------------------------------------------

def _auth_headers(email: str, token: str) -> dict[str, str]:
    auth = b64encode(f"{email}:{token}".encode()).decode()
    return {"Authorization": f"Basic {auth}", "Accept": "application/json"}


def _adf_node_to_text(node: dict) -> str:
    """Recursively extract plain text from an Atlassian Document Format node."""
    if node.get("type") == "text":
        return node.get("text", "")
    return " ".join(filter(None, (_adf_node_to_text(c) for c in node.get("content", []))))


def extract_description(desc_field) -> str:
    """Extract plain text from a Jira description (ADF dict or plain string)."""
    if not desc_field:
        return ""
    if isinstance(desc_field, str):
        return desc_field
    if isinstance(desc_field, dict):
        parts = [_adf_node_to_text(n) for n in desc_field.get("content", [])]
        return "\n".join(filter(None, parts)).strip()
    return str(desc_field)


# ---------------------------------------------------------------------------
# Jira API calls
# ---------------------------------------------------------------------------

async def fetch_open_tickets(
    jira_url: str,
    email: str,
    token: str,
    project: str,
    *,
    max_results: int = 50,
) -> list[dict]:
    """Return open Jira tickets (statusCategory != Done) for the given project."""
    headers = _auth_headers(email, token)
    base = jira_url.rstrip("/")

    async with httpx.AsyncClient(timeout=30) as client:
        # Validate credentials before fetching
        me = await client.get(f"{base}/rest/api/3/myself", headers=headers)
        if me.status_code != 200:
            raise RuntimeError(
                "Jira authentication failed. Check JIRA_EMAIL / JIRA_API_TOKEN in .env"
            )

        resp = await client.get(
            f"{base}/rest/api/3/search/jql",
            headers=headers,
            params={
                "jql": f'project = "{project}" AND statusCategory != Done ORDER BY created DESC',
                "maxResults": max_results,
                "fields": "summary,description,status,priority,assignee,created,resolutiondate,components,labels,issuetype",
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Jira search failed: {resp.status_code} — {resp.text}")

        return resp.json().get("issues", [])


async def post_comment(
    jira_url: str, email: str, token: str, ticket_id: str, text: str
) -> None:
    """Post a plain-text comment (wrapped in Atlassian Document Format) on a Jira ticket."""
    headers = {**_auth_headers(email, token), "Content-Type": "application/json"}
    body = {
        "body": {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": text}],
                }
            ],
        }
    }
    async with httpx.AsyncClient(timeout=30) as client:
        await client.post(
            f"{jira_url.rstrip('/')}/rest/api/3/issue/{ticket_id}/comment",
            headers=headers,
            json=body,
        )


async def transition_to_done(
    jira_url: str, email: str, token: str, ticket_id: str
) -> bool:
    """Transition a Jira ticket to Done/Resolved. Returns True if successful."""
    headers = {**_auth_headers(email, token), "Content-Type": "application/json"}
    base = jira_url.rstrip("/")

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{base}/rest/api/3/issue/{ticket_id}/transitions", headers=headers
        )
        if r.status_code != 200:
            return False

        done_id = next(
            (
                t["id"]
                for t in r.json().get("transitions", [])
                if t.get("name", "").lower() in ("done", "resolved", "closed", "complete")
            ),
            None,
        )
        if not done_id:
            logger.warning(f"[JIRA] No 'Done' transition found for {ticket_id}")
            return False

        resp = await client.post(
            f"{base}/rest/api/3/issue/{ticket_id}/transitions",
            headers=headers,
            json={"transition": {"id": done_id}},
        )
        return resp.status_code in (200, 204)


# ---------------------------------------------------------------------------
# LLM helper
# ---------------------------------------------------------------------------

def _llm_client() -> AsyncAzureOpenAI:
    return AsyncAzureOpenAI(
        azure_endpoint=os.environ["AZURE_OPENAI_LLM_MODEL_API_BASE"],
        api_key=os.environ["AZURE_OPENAI_LLM_MODEL_API_KEY"],
        api_version=os.environ["AZURE_OPENAI_LLM_MODEL_API_VERSION"],
    )


async def _llm(system: str, user: str, *, max_tokens: int = 800, json_mode: bool = False) -> str:
    """Single LLM call — returns the assistant message content."""
    model = os.environ["AZURE_OPENAI_LLM_MODEL_LLM_MODEL"]
    kwargs: dict = dict(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=max_tokens,
        temperature=0.2 if json_mode else 0.3,
    )
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    resp = await _llm_client().chat.completions.create(**kwargs)
    return resp.choices[0].message.content.strip()


# ---------------------------------------------------------------------------
# Workspace file helpers
# ---------------------------------------------------------------------------

def _read_workspace_files() -> dict[str, str]:
    """Return {relative_path: content} for every editable file in the workspace."""
    files: dict[str, str] = {}
    for path in WORKSPACE_ROOT.rglob("*"):
        if path.is_dir():
            continue
        rel_parts = path.relative_to(WORKSPACE_ROOT).parts
        if any(part in _SKIP_DIRS for part in rel_parts):
            continue
        if path.suffix not in _EDITABLE_EXTENSIONS:
            continue
        if path.stat().st_size > _MAX_FILE_BYTES:
            continue
        try:
            rel = path.relative_to(WORKSPACE_ROOT).as_posix()
            files[rel] = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            pass
    return files


def _safe_write(rel_path: str, content: str) -> None:
    """Write content to a workspace-relative path, blocking path-traversal."""
    target = (WORKSPACE_ROOT / rel_path).resolve()
    if not str(target).startswith(str(WORKSPACE_ROOT.resolve())):
        raise ValueError(f"Path escape blocked: {rel_path}")
    if target.suffix not in _EDITABLE_EXTENSIONS:
        raise ValueError(f"Extension not allowed: {target.suffix}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


async def speckit_edit(summary: str, solution: str, existing_files: dict[str, str]) -> list[str]:
    """Step 5 — Edit: apply the SpecKit solution by rewriting actual workspace files."""
    # Build a compact snapshot of the current codebase for context
    files_context = "\n\n".join(
        f"### {rel}\n```\n{content[:4000]}\n```"
        for rel, content in existing_files.items()
    )
    raw = await _llm(
        system=(
            "You are a senior engineer applying a feature implementation to an existing codebase. "
            "Given the current files and a solution, return a JSON object with a single key "
            "\"changes\": an array of objects, each with:\n"
            "  \"file\": relative path (e.g. \"static/app.js\")\n"
            "  \"content\": complete new file content (full replacement, not a diff)\n"
            "Only include files that genuinely need to change. "
            "Only use paths that already exist in the codebase — do not invent new files."
        ),
        user=(
            f"Ticket: {summary}\n\n"
            f"Solution to implement:\n{solution}\n\n"
            f"Current codebase:\n\n{files_context}"
        ),
        max_tokens=4096,
        json_mode=True,
    )

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning(f"[EDIT] LLM returned invalid JSON: {exc}")
        return []

    changed: list[str] = []
    for change in data.get("changes", []):
        rel = change.get("file", "").strip()
        content = change.get("content", "")
        if not rel or not content:
            continue
        try:
            _safe_write(rel, content)
            changed.append(rel)
            logger.info(f"[EDIT] Wrote {rel}")
        except ValueError as exc:
            logger.warning(f"[EDIT] Skipped {rel}: {exc}")
    return changed


# ---------------------------------------------------------------------------
# SpecKit pipeline — Specify → Plan → Tasks → Implement
# ---------------------------------------------------------------------------

async def speckit_specify(summary: str, description: str) -> str:
    """Step 1 — Specify: produce a structured feature spec from the Jira ticket."""
    return await _llm(
        system=(
            "You are a technical spec writer following the SpecKit spec-driven methodology. "
            "Given a Jira ticket, write a concise feature specification."
        ),
        user=(
            f"Jira Ticket: {summary}\n\n"
            f"Description:\n{description or '(no description)'}\n\n"
            "Write a specification that includes:\n"
            "- User Story (as a ... I want to ... so that ...)\n"
            "- Acceptance Criteria (numbered list)\n"
            "- Edge Cases to handle"
        ),
    )


async def speckit_plan(spec: str) -> str:
    """Step 2 — Plan: generate a technical implementation plan from the spec."""
    return await _llm(
        system=(
            "You are a software architect following the SpecKit spec-driven methodology. "
            "Given a feature specification, create a concise technical implementation plan."
        ),
        user=(
            f"Feature Specification:\n{spec}\n\n"
            "Create an implementation plan that includes:\n"
            "- Technical approach (2-3 sentences)\n"
            "- Key components / files to create or modify\n"
            "- Dependencies or constraints to be aware of"
        ),
    )


async def speckit_tasks(plan: str) -> str:
    """Step 3 — Tasks: break the plan into an ordered, actionable task list."""
    return await _llm(
        system=(
            "You are a technical lead following the SpecKit spec-driven methodology. "
            "Break the implementation plan into a clear, numbered task list."
        ),
        user=(
            f"Implementation Plan:\n{plan}\n\n"
            "Generate a numbered task list where each task is:\n"
            "- Specific and actionable\n"
            "- Completable independently\n"
            "- Ordered by dependency (foundational tasks first)"
        ),
    )


async def speckit_implement(summary: str, spec: str, plan: str, tasks: str) -> str:
    """Step 4 — Implement: execute the tasks and produce the final solution."""
    return await _llm(
        system=(
            "You are a senior engineer following the SpecKit spec-driven methodology. "
            "Given the spec, plan, and task list for a ticket, produce the complete solution."
        ),
        user=(
            f"Ticket: {summary}\n\n"
            f"Spec:\n{spec}\n\n"
            f"Plan:\n{plan}\n\n"
            f"Tasks:\n{tasks}\n\n"
            "Implement the full solution. Include:\n"
            "- Concrete steps taken\n"
            "- Any code snippets, configuration, or commands needed\n"
            "- Verification steps to confirm the ticket is resolved"
        ),
    )


async def speckit_resolve(summary: str, description: str) -> dict:
    """
    Run the full SpecKit pipeline for one ticket (5 steps):
      Specify → Plan → Tasks → Implement → Edit codebase
    Returns a dict with all step outputs, files changed, and the Jira comment.
    """
    logger.info(f"[SPECKIT] Specify  → {summary}")
    spec = await speckit_specify(summary, description)

    logger.info(f"[SPECKIT] Plan     → {summary}")
    plan = await speckit_plan(spec)

    logger.info(f"[SPECKIT] Tasks    → {summary}")
    tasks = await speckit_tasks(plan)

    logger.info(f"[SPECKIT] Implement→ {summary}")
    solution = await speckit_implement(summary, spec, plan, tasks)

    logger.info(f"[SPECKIT] Edit     → {summary}")
    existing_files = _read_workspace_files()
    files_changed = await speckit_edit(summary, solution, existing_files)

    files_section = (
        "\n".join(f"- `{f}`" for f in files_changed)
        if files_changed
        else "_No file changes were necessary._"
    )
    comment = (
        "## SpecKit Auto-Resolution\n\n"
        "### 📋 Spec\n"
        f"{spec}\n\n"
        "### 🗺️ Plan\n"
        f"{plan}\n\n"
        "### ✅ Tasks\n"
        f"{tasks}\n\n"
        "### 🚀 Implementation\n"
        f"{solution}\n\n"
        "### 📁 Files Changed\n"
        f"{files_section}"
    )

    return {
        "spec": spec,
        "plan": plan,
        "tasks": tasks,
        "solution": solution,
        "files_changed": files_changed,
        "comment": comment,
    }


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def resolve_all_open_tickets(
    jira_url: str, email: str, token: str, project: str
) -> list[dict]:
    """
    For every open ticket in the project:
      1. Run the SpecKit pipeline (Specify → Plan → Tasks → Implement)
      2. Post the full result as a Jira comment
      3. Transition the ticket to Done
    """
    tickets = await fetch_open_tickets(jira_url, email, token, project)
    logger.info(f"[JIRA] Found {len(tickets)} open tickets in project {project}")

    results: list[dict] = []
    for issue in tickets:
        ticket_id = issue["key"]
        fields = issue.get("fields", {})
        summary = fields.get("summary") or ""
        description = extract_description(fields.get("description"))

        try:
            pipeline = await speckit_resolve(summary, description)
            await post_comment(jira_url, email, token, ticket_id, pipeline["comment"])
            transitioned = await transition_to_done(jira_url, email, token, ticket_id)

            logger.info(f"[JIRA] Resolved {ticket_id} via SpecKit (transitioned={transitioned}, files={pipeline.get('files_changed', [])})")  
            results.append({
                "ticket": ticket_id,
                "summary": summary,
                "status": "resolved",
                "transitioned_to_done": transitioned,
                "files_changed": pipeline.get("files_changed", []),
                "spec": pipeline["spec"],
                "plan": pipeline["plan"],
                "tasks": pipeline["tasks"],
                "solution": pipeline["solution"],
            })

        except Exception as exc:
            logger.warning(f"[JIRA] Failed to resolve {ticket_id}: {exc}")
            results.append({
                "ticket": ticket_id,
                "summary": summary,
                "status": "error",
                "error": str(exc),
            })

    return results
